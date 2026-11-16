import * as z from 'zod';
import { readPoolNonce, readReviveAccount, resolveHolder, waitingCount, waitingText, type Holder, type PoolNonce } from '../lib/accounts.ts';
import { checksummed, fallbackIdOfH160, parseAddress, toSs58, type ParsedAddress } from '../lib/address.ts';
import { buildCall, checkPlainInput, echoCall, ethLimits, PALLETS_ROUTE_BASIS, readEthSide, specialOriginNote, type BuiltCall, type CallContext, type EthReading } from '../lib/calls.ts';
import { getConn } from '../lib/chain.ts';
import { acceptanceOf, verdictText as ethVerdictText } from '../lib/evm.ts';
import { formatUnits, lines, nativeAmount, weiAmount } from '../lib/format.ts';
import { getIndex } from '../lib/meta.ts';
import { callNames, dryRunCall, fromReading, innerCallNotes, replyText, verdictText, type CallDryRun } from '../lib/nativedryrun.ts';
import { NATIVE_DECIMALS, PALLETS_ADDRESS, pickNetwork } from '../lib/networks.ts';
import { messageText } from '../lib/text.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** Call bytes up to this many hex characters are shown in full. */
const SHOW_HEX_MAX = 8_000;
/** runTool cuts an answer at 19,000 characters; the argument lines give way first, so the sender's part is kept. */
const ANSWER_MAX = 18_500;
const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

type RunResult = CallDryRun | { unavailable: string };

/** The chain's own answer to the call from this sender, as a short section. */
function dryRunSection(ctx: CallContext, built: BuiltCall, run: RunResult, parsed: ParsedAddress, holder: Holder, ethKey: boolean): string[] {
  const { network, index } = ctx;
  if ('unavailable' in run) {
    return [
      `Dry run from this sender: not made. The node gave no usable answer just now (${run.unavailable}). The rest of this answer stands; ask again in a moment for the chain's own answer.`,
    ];
  }
  const h160 = checksummed(parsed.h160);
  const through =
    run.path === 'rpc'
      ? `eth_estimateGas on the Ethereum RPC ${network.evmCopy}`
      : run.fallbackReason
        ? `the node's runtime API (ReviveApi eth_estimate_gas), because the Ethereum RPC gave no usable answer (${run.fallbackReason})`
        : `the node's runtime API (ReviveApi eth_estimate_gas), because the ${network.label} has no public Ethereum RPC`;
  const own = parsed.kind === 'h160' ? null : toSs58(parsed.accountId);
  let from: string;
  let ranAs: string;
  if (ethKey) {
    from = h160;
    ranAs = `No native account is linked to that address, so the call ran as its fallback account${own ? ', this account' : ` ${holder.holderSs58}`}.`;
  } else if (holder.linked) {
    from = own ? `${h160} (this account's 0x form)` : h160;
    ranAs = holder.linked === own ? 'The chain links that 0x form to this account, so the call ran as this account itself.' : `The chain links it to ${holder.linked}, so the call ran as that native account.`;
  } else {
    from = `${h160} (this account's 0x form)`;
    ranAs =
      `No account is linked to that 0x form yet (a native account is linked when it is created), so the call ran as the 0x form's fallback account ${toSs58(fallbackIdOfH160(parsed.h160))}, not as this account. ` +
      'Ask again once this account exists.';
  }
  return [
    `Dry run from this sender (the node ran the call just now; nothing was sent): ${verdictText(index, run)}`,
    `  reply: ${replyText(run)}${run.estimate === null ? '. explain_error reads it.' : ''}`,
    `  how: from ${from} to the pallets address, with these call bytes as data and value 0, through ${through}. ${ranAs}`,
    ...innerCallNotes(callNames(index, built.call)).map((n) => `  ${n}`),
    '  Checked on Nov 15, 2026 with 143 such dry runs in 18 modules on the testnet: each answered with a gas figure or with "Failed to dispatch call:" and the call\'s own error, ' +
      'and from the 0x form of a linked account the call ran as that account. A dry run does not check the fee (the lines above do), and no sent transaction has confirmed these answers.',
  ];
}

async function senderLines(ctx: CallContext, built: BuiltCall, amounts: bigint, hasLimit: boolean, parsed: ParsedAddress): Promise<{ text: string[]; ethKey: boolean; next: string | null }> {
  const { conn, network } = ctx;
  const api = conn.api as Loose;
  const token = network.token;
  const facesEth = parsed.kind === 'h160' || parsed.isFallbackForm;
  // A native input is the account that pays, so its balance is read in the same round as its link.
  // A native account that is not a fallback account cannot be an Ethereum key, so its dry run starts at once too.
  const knownId = parsed.kind === 'h160' ? null : parsed.accountId;
  const early = parsed.kind !== 'h160' && !parsed.isFallbackForm ? dryRunCall(conn, parsed.h160, built.hex) : null;
  const [holder, knownAccount] = await Promise.all([resolveHolder(conn, parsed), knownId ? api.query.system.account(knownId) : Promise.resolve(null)]);
  // A 0x address that no native account is linked to: an Ethereum key (MetaMask) or a contract.
  const ethKey = facesEth && !holder.linked;
  const [revive, account] = await Promise.all([ethKey ? readReviveAccount(conn, parsed.h160) : Promise.resolve(null), knownAccount ?? api.query.system.account(holder.holderId)]);
  const isContract = Boolean(revive?.contract);
  // paymentInfo would look up the nonce and a recent block itself (about ten requests, counted on Nov 15,
  // 2026). The nonce just read and a mortal era give a signed transaction of the same length (181 bytes for
  // the same call either way), so the same fee, with one request.
  const era = api.registry.createType('ExtrinsicEra', { current: 0, period: 64 });
  const info = await api.tx(built.call).paymentInfo(holder.holderSs58, { nonce: account.nonce, era, blockHash: api.genesisHash });
  const fee = BigInt(info.partialFee.toString());
  const free = BigInt(account.data.free.toString());
  const ed = BigInt(api.consts.balances.existentialDeposit.toString());
  const need = fee + amounts + ed;
  const h160 = checksummed(parsed.h160);
  // Route b's reading is the dry run of an Ethereum key; any other sender gets one eth_estimateGas.
  let reading: EthReading | null = null;
  let readingFailed: string | null = null;
  let run: RunResult | null = null;
  if (!isContract) {
    if (ethKey && network.evm) {
      try {
        reading = await readEthSide(conn, { from: parsed.h160, to: PALLETS_ADDRESS, data: built.hex, value: 0n });
        run = fromReading(reading);
      } catch (err) {
        readingFailed = messageText(err instanceof Error ? err.message : String(err), 240);
        run = { unavailable: readingFailed };
      }
    } else run = await (early ?? dryRunCall(conn, parsed.h160, built.hex));
  }

  const who = ethKey
    ? `${h160}, a 0x account. Its balance is held by its fallback account ${holder.holderSs58} (the 20 bytes followed by twelve 0xEE bytes).`
    : facesEth
      ? `${h160}, the 0x form of the native account ${holder.linked}. That native account signs this call and pays for it.`
      : `${holder.holderSs58}, a native account.`;
  const text: string[] = [
    '',
    `Sender: ${who}`,
    parsed.checksumWarning && `WARNING: ${parsed.checksumWarning}`,
    `Fee and balance, read just now:`,
    `  fee estimate: ${nativeAmount(fee, network)} (paymentInfo, partialFee)`,
    ethKey && network.key === 'testnet' && '  (sent through the pallets address a call paid a little more in our tests on Nov 13, 2026: Balances.transferKeepAlive paid 0.0159 tPOT, where the same call sent natively paid 0.0149 to 0.0150, and System.remarkWithEvent paid 0.0158. Leave room above this estimate.)',
    `  free balance: ${nativeAmount(free, network)}`,
    `  needed: fee + native amounts among the arguments (${formatUnits(amounts, NATIVE_DECIMALS)} ${token}) + the ${formatUnits(ed, NATIVE_DECIMALS)} ${token} existential deposit = ${nativeAmount(need, network)}`,
    hasLimit && '  (an amount that is only a limit, such as a storage deposit limit, may not be spent in full; it is counted in full here)',
    free >= need
      ? `  covers it: yes, with ${formatUnits(free - need, NATIVE_DECIMALS)} ${token} to spare`
      : null,
    free >= need
      ? run && !('unavailable' in run) && (ethKey || holder.linked)
        ? `  (This counts ${token} only. Whether the sender holds the rest the call needs, such as another token or an NFT, is the dry run's answer below.)`
        : `  (This counts ${token} only. If the call moves another token, an NFT or anything else the sender must hold, that holding and the token's minimum balance were not checked: read them with read_storage.)`
      : `  covers it: NO, short by ${nativeAmount(need - free, network)}. Send that much ${token} to ${holder.holderSs58} first.`,
  ].filter((l): l is string => typeof l === 'string');

  if (isContract || !run) {
    text.push(`  ${h160} is a contract. A contract has no key, so it cannot send this call; only its own code can make calls.`);
    return { text, ethKey, next: null };
  }
  if (!ethKey && facesEth) text.push(`  No Ethereum key exists for ${h160} (it is derived from the native account by a hash), so it cannot use route b below. Sign natively with ${holder.linked}.`);
  // An Ethereum key can only use route b, an Ethereum transaction to the pallets address.
  if (ethKey && !network.evm) {
    text.push(`  A 0x account can send this call only through an Ethereum transaction (route b below), and the ${network.label} has no public Ethereum RPC (checked Nov 13, 2026), so MetaMask, cast and viem have nowhere to send it there today.`);
  }
  text.push('', ...dryRunSection(ctx, built, run, parsed, holder, ethKey));
  if (!ethKey || !network.evm) return { text, ethKey, next: null };

  if (!reading) {
    text.push('', `Route b for this 0x account: the gas figures could not be read just now (${readingFailed}). Ask again in a moment.`);
    return { text, ethKey, next: null };
  }
  const via = reading.path === 'rpc' ? `the Ethereum RPC ${network.evmCopy}` : `the node's runtime API, because the Ethereum RPC gave no usable answer (${reading.fallbackReason})`;
  text.push('', `Route b for this 0x account, read just now through ${via}:`);
  if (reading.estimate === null) {
    text.push('  No gas figures: eth_estimateGas answered with the refusal shown in the dry run above.');
    return { text, ethKey, next: null };
  }
  const { gasLimit, maxFee } = ethLimits(reading.estimate, reading.gasPrice, 0n);
  // The node's rule, measured by real sends on Nov 15, 2026 (lib/evm.ts): gas limit x base fee against the balance.
  const acceptance = acceptanceOf({ gasLimit, baseFee: reading.gasPrice, value: 0n, balance: reading.balance });
  const pool = await readPoolNonce(conn, holder.holderSs58).catch((): PoolNonce | null => null);
  text.push(
    `  gas estimate: ${reading.estimate}; gas price: ${reading.gasPrice} wei per gas`,
    `  gas limit ${gasLimit} (estimate + 10 percent), max fee per gas ${maxFee} wei (gas price + one eighth; it is not charged), max priority fee 0`,
    `  to be taken by the node: gas limit x base fee = ${weiAmount(acceptance.toBeTaken, network)}. The max fee is not counted (measured by real sends on Nov 15, 2026).`,
    `  balance now (eth_getBalance: free less the existential deposit, or less the frozen amount when that is larger, plus dust): ${weiAmount(reading.balance, network)}`,
    `  verdict: ${ethVerdictText(acceptance, network, holder.holderSs58)}`,
    pool === null
      ? `  nonce to use: ${reading.noncePending} (the node did not answer system_accountNextIndex just now, so a transaction that still waits may not be counted)`
      : waitingCount(pool) === 0
        ? `  nonce to use: ${pool.next}`
        : `  nonce: WARNING, ${waitingText(pool)}`,
    "  The call's own native amounts are taken from the same balance when it runs: if they do not fit, the transaction is taken, fails in its block and still costs the fee (testnet block 477826, Nov 15, 2026).",
  );
  const next = `Next: estimate_eth_transaction {"from": "${parsed.h160}", "to": "${PALLETS_ADDRESS}", "data": "${built.hex.length <= 200 ? built.hex : '<the call bytes above>'}"} gives the fields to copy for viem, ethers and cast.`;
  return { text, ethKey, next };
}

export default defineTool({
  name: 'encode_call',
  title: 'Portaldot V3: encode a native call (never signs)',
  description:
    'Encodes a Portaldot V3 native call (extrinsic) from "Module.call" and its arguments into the exact SCALE call bytes, and reads them back as the chain will, so mistakes show before anything is signed. ' +
    'Returns the call bytes and their length, the module and call index, every argument as decoded (amounts also in tokens, addresses as SS58), and how to send it: with @polkadot/api from a native account, ' +
    'or as an Ethereum transaction to the pallets address from a 0x (MetaMask) account. With "sender": the fee, the balance, whether it covers fee + amounts + the 0.1 existential deposit, and the chain\'s own answer to the call from that sender (a dry run: accepted, or its error); for a 0x sender also the gas limits of the Ethereum route. ' +
    'Takes nested calls (Utility.batchAll, Multisig.asMulti, Sudo.sudo) as bytes or as {"call", "args"}. Amounts are whole numbers of the smallest unit, as strings. Never signs or sends. ' +
    'Example: {"call": "Balances.transferKeepAlive", "args": ["5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z", "1000000000000"]} (that address is the Treasury, used as a harmless example: put your own recipient).',
  input: {
    call: z
      .string()
      .trim()
      .min(3)
      .max(300)
      .describe('The call as Module.call, written any way: "Balances.transferKeepAlive", "balances::transfer_keep_alive", "api.tx.utility.batchAll". describe_item lists its arguments.'),
    args: z
      .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'The arguments: an array in order, ["5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z", "1000000000000"], or an object by name, {"dest": "5EYC...", "value": "1000000000000"}. ' +
          'Amounts are whole numbers of the smallest unit as strings (1 tPOT = "100000000000000"). Accounts as SS58 (5...). An inner call is its 0x bytes or {"call": "System.remarkWithEvent", "args": ["hi"]}. Leave out for a call with no arguments.',
      ),
    sender: z
      .string()
      .optional()
      .describe('Optional: who will send it, as a 5... address or a 0x address, for example "5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z". Adds the fee estimate, a balance check and a dry run of the call from that sender. Public addresses only, never a key or a secret phrase.'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ call, args, sender, network: key }) => {
    const network = pickNetwork(key);
    checkPlainInput(args, 'args', network);
    const senderParsed = sender ? parseAddress(sender) : null;
    const conn = await getConn(network.key);
    const index = getIndex(conn);
    const ctx: CallContext = { conn, index, network };
    const built = await buildCall(ctx, call, args);
    const api = conn.api as Loose;
    const module = index.modules.find((m) => m.name === built.item.module);
    const echo = echoCall(ctx, built.call, built.inputs, '  ');
    const length = (built.hex.length - 2) / 2;
    // api.tx(bytes) reads bytes as a whole signed transaction; a Call made from the bytes is what rebuilds the call.
    const sameBytes = api.tx(api.createType('Call', built.hex)).method.toHex() === built.hex;
    const origin = specialOriginNote(built.item);
    const inCode = built.hex.length <= 200 ? built.hex : '0x... (the call bytes above)';
    const argNames = built.item.args.map((a) => a.name).join(', ');
    const sent = senderParsed ? await senderLines(ctx, built, echo.nativeTotal, echo.hasLimit, senderParsed) : null;

    const render = (echoLines: string[]): string => lines(
      `${built.item.module}.${built.item.name} on the ${network.label} (runtime ${index.specVersion}): module ${module?.index ?? '?'}, call ${built.item.index ?? '?'}, so the bytes start 0x${hex2(module?.index ?? 0)}${hex2(built.item.index ?? 0)}. ` +
        "Encoded just now from the chain's own metadata. Nothing was signed or sent.",
      '',
      `Call bytes (${length} bytes):`,
      built.hex.length <= SHOW_HEX_MAX ? built.hex : `${built.hex.slice(0, 200)}... (cut: ${length} bytes in all. Build them in your code with api.tx.${built.item.section}.${built.item.name}(...).method.toHex().)`,
      '',
      'What the chain reads from these bytes (check every value before signing):',
      echoLines,
      origin && `\nNote: the chain's own notes for this call say: "${origin}" A call that needs a special origin (root) fails when an ordinary account sends it, on either route below.`,
      sent ? sent.text : null,
      '',
      'How to send it (these tools never sign):',
      'a) From a native account (a 5... key), with @polkadot/api:',
      `     const tx = api.tx(api.createType('Call', '${inCode}'));`,
      '     await tx.signAndSend(account); // a test key in your own script, or a wallet\'s signer',
      sameBytes
        ? "   Checked just now: tx.method.toHex() gives back exactly these bytes. api.tx('0x...') on its own does not work: it reads the bytes as a whole signed transaction and throws."
        : '   WARNING: rebuilding the call from its bytes did not give the same bytes just now. Build it directly instead, as below.',
      `   The same call written out: api.tx.${built.item.section}.${built.item.name}(${argNames}).`,
      `b) From a 0x account (an Ethereum key, for example MetaMask): send an Ethereum transaction to the pallets address ${PALLETS_ADDRESS} with these bytes as data and value 0. ` +
        "The call then runs as the key's fallback account (the 20 bytes followed by twelve 0xEE bytes), which pays the fee. " +
        'The 0x form of a native account has no key, so it cannot send this way; a dry run from it runs the call as that native account itself, once the account is linked to it (checked on Nov 15, 2026).',
      `   ${PALLETS_ROUTE_BASIS}`,
      network.evm
        ? '   estimate_eth_transaction with that "to" and these bytes as "data" gives the gas limit, the fee and the fields to copy.'
        : `   Not available on the ${network.label} today: it has no public Ethereum RPC (checked Nov 13, 2026), so a wallet has nowhere to send such a transaction.`,
      '',
      sent?.next ??
        (senderParsed
          ? 'Next: explain_error reads any error the node gives back when you send it.'
          : 'Next: call encode_call again with "sender" for the fee, a balance check and the chain\'s answer from that sender; explain_error reads any error the node gives back when you send it.'),
    );

    let text = render(echo.lines);
    if (text.length > ANSWER_MAX) {
      // The argument lines give way, from the end, so the sender's part and the ways to send stay whole.
      let keep = echo.lines.length;
      let freed = 0;
      while (keep > 0 && freed < text.length - ANSWER_MAX + 200) freed += echo.lines[--keep].length + 1;
      text = render([...echo.lines.slice(0, keep), `  ... ${echo.lines.length - keep} more lines not shown, to keep this answer within its length limit${built.hex.length <= SHOW_HEX_MAX ? ' (the call bytes above hold them all)' : ''}. To check every value, encode the batch in smaller parts.`]);
    }
    return text;
  },
});
