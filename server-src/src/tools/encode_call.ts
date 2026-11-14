import * as z from 'zod';
import { readReviveAccount, resolveHolder } from '../lib/accounts.ts';
import { checksummed, parseAddress, type ParsedAddress } from '../lib/address.ts';
import { buildCall, checkPlainInput, echoCall, ethLimits, PALLETS_ROUTE_BASIS, readEthSide, specialOriginNote, type BuiltCall, type CallContext } from '../lib/calls.ts';
import { getConn } from '../lib/chain.ts';
import { formatUnits, lines, nativeAmount, untrusted, weiAmount } from '../lib/format.ts';
import { getIndex } from '../lib/meta.ts';
import { NATIVE_DECIMALS, PALLETS_ADDRESS, pickNetwork } from '../lib/networks.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** Call bytes up to this many hex characters are shown in full. */
const SHOW_HEX_MAX = 8_000;
const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

async function senderLines(ctx: CallContext, built: BuiltCall, amounts: bigint, hasLimit: boolean, parsed: ParsedAddress): Promise<{ text: string[]; ethKey: boolean; next: string | null }> {
  const { conn, network } = ctx;
  const api = conn.api as Loose;
  const token = network.token;
  const holder = await resolveHolder(conn, parsed);
  const facesEth = parsed.kind === 'h160' || parsed.isFallbackForm;
  // A 0x address that no native account is linked to: an Ethereum key (MetaMask) or a contract.
  const ethKey = facesEth && !holder.linked;
  const revive = ethKey ? await readReviveAccount(conn, parsed.h160) : null;
  const isContract = Boolean(revive?.contract);
  const tx = api.tx(built.call);
  const [info, account] = await Promise.all([tx.paymentInfo(holder.holderSs58), api.query.system.account(holder.holderId)]);
  const fee = BigInt(info.partialFee.toString());
  const free = BigInt(account.data.free.toString());
  const ed = BigInt(api.consts.balances.existentialDeposit.toString());
  const need = fee + amounts + ed;
  const h160 = checksummed(parsed.h160);

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
      ? `  (This counts ${token} only. If the call moves another token, an NFT or anything else the sender must hold, that holding and the token's minimum balance were not checked: read them with read_storage.)`
      : `  covers it: NO, short by ${nativeAmount(need - free, network)}. Send that much ${token} to ${holder.holderSs58} first.`,
  ].filter((l): l is string => typeof l === 'string');

  if (isContract) {
    text.push(`  ${h160} is a contract. A contract has no key, so it cannot send this call; only its own code can make calls.`);
    return { text, ethKey, next: null };
  }
  if (!ethKey) {
    if (facesEth) text.push(`  No Ethereum key exists for ${h160} (it is derived from the native account by a hash), so it cannot use route b below. Sign natively with ${holder.linked}.`);
    return { text, ethKey, next: null };
  }

  // An Ethereum key: it can only use route b, an Ethereum transaction to the pallets address.
  if (!network.evm) {
    text.push(`  A 0x account can send this call only through an Ethereum transaction (route b below), and the ${network.label} has no public Ethereum RPC (checked Nov 13, 2026), so MetaMask, cast and viem have nowhere to send it there today.`);
    return { text, ethKey, next: null };
  }
  const reading = await readEthSide(conn, { from: parsed.h160, to: PALLETS_ADDRESS, data: built.hex, value: 0n });
  const via = reading.path === 'rpc' ? `the Ethereum RPC ${network.evmCopy}` : `the node's runtime API, because the Ethereum RPC gave no usable answer (${reading.fallbackReason})`;
  text.push('', `Route b for this 0x account, read just now through ${via}:`);
  if (reading.estimate === null) {
    text.push(`  eth_estimateGas failed: ${untrusted(reading.failure?.message ?? 'no estimate', 600)}${reading.failure?.code !== null && reading.failure?.code !== undefined ? ` (code ${reading.failure.code})` : ''}. explain_error reads this message.`);
    return { text, ethKey, next: null };
  }
  const { gasLimit, maxFee, needed } = ethLimits(reading.estimate, reading.gasPrice, 0n);
  text.push(
    `  gas estimate: ${reading.estimate}; gas price: ${reading.gasPrice} wei per gas`,
    `  gas limit ${gasLimit} (estimate + 10 percent), max fee per gas ${maxFee} wei (gas price + one eighth), max priority fee 0`,
    `  balance needed to be accepted: gas limit x max fee = ${weiAmount(needed, network)}. Expect the node to refuse the transaction with error 1010 when the balance is lower.`,
    `  balance now (eth_getBalance: free less the existential deposit, or less the frozen amount when that is larger, plus dust): ${weiAmount(reading.balance, network)}`,
    reading.balance >= needed ? '  enough to be accepted: yes' : `  enough to be accepted: NO, short by ${weiAmount(needed - reading.balance, network)}. Send that much ${token} to ${holder.holderSs58} first.`,
    reading.nonceLatest === reading.noncePending
      ? `  nonce to use: ${reading.noncePending}`
      : `  nonce: WARNING, latest ${reading.nonceLatest} but pending ${reading.noncePending}: a transaction from this account is still waiting. Wait for it, or use nonce ${reading.noncePending} to send after it.`,
    "  The call's own native amounts are taken from the same balance when it runs.",
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
    'or as an Ethereum transaction to the pallets address from a 0x (MetaMask) account. With "sender": the fee, the balance, and whether it covers fee + amounts + the 0.1 existential deposit; for a 0x sender also the gas limits of the Ethereum route. ' +
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
      .describe('Optional: who will send it, as a 5... address or a 0x address, for example "5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z". Adds the fee estimate and a balance check. Public addresses only, never a key or a secret phrase.'),
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

    return lines(
      `${built.item.module}.${built.item.name} on the ${network.label} (runtime ${index.specVersion}): module ${module?.index ?? '?'}, call ${built.item.index ?? '?'}, so the bytes start 0x${hex2(module?.index ?? 0)}${hex2(built.item.index ?? 0)}. ` +
        "Encoded just now from the chain's own metadata. Nothing was signed or sent.",
      '',
      `Call bytes (${length} bytes):`,
      built.hex.length <= SHOW_HEX_MAX ? built.hex : `${built.hex.slice(0, 200)}... (cut: ${length} bytes in all. Build them in your code with api.tx.${built.item.section}.${built.item.name}(...).method.toHex().)`,
      '',
      'What the chain reads from these bytes (check every value before signing):',
      echo.lines,
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
        'The call then runs as that account\'s fallback account (the 20 bytes followed by twelve 0xEE bytes), which pays the fee.',
      `   ${PALLETS_ROUTE_BASIS}`,
      network.evm
        ? '   estimate_eth_transaction with that "to" and these bytes as "data" gives the gas limit, the fee and the fields to copy.'
        : `   Not available on the ${network.label} today: it has no public Ethereum RPC (checked Nov 13, 2026), so a wallet has nowhere to send such a transaction.`,
      '',
      sent?.next ?? (senderParsed ? 'Next: explain_error reads any error the node gives back when you send it.' : 'Next: call encode_call again with "sender" for the fee and a balance check; explain_error reads any error the node gives back when you send it.'),
    );
  },
});
