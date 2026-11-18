import * as z from 'zod';
import { codeKind, readPoolNonce, readReviveAccount, resolveHolder, waitingCount, type PoolNonce } from '../lib/accounts.ts';
import { checksummed, fallbackIdOfH160, parseAddress, toSs58 } from '../lib/address.ts';
import { callNames, innerCallNotes } from '../lib/nativedryrun.ts';
import { callName, decodeCallBytes, depositScale, ethLimits, findCallItem, isPalletsAddress, readEthSide, RUNTIME_PATH_BASIS, specialOriginNote, type EthQuery, type EthReading } from '../lib/calls.ts';
import { ethQuantity, ethRpc, getConn, isEthHex, type Conn } from '../lib/chain.ts';
import { ToolError } from '../lib/errors.ts';
import { acceptanceOf, decodeRevert, verdictText, type Acceptance } from '../lib/evm.ts';
import { clip, isHex, lines, parseUnits, untrusted, weiAmount } from '../lib/format.ts';
import { getIndex } from '../lib/meta.ts';
import { EVM_DECIMALS, NATIVE_TO_WEI, pickNetwork, type Network } from '../lib/networks.ts';
import { defineTool, networkField } from '../lib/tool.ts';

/** Hex longer than this is written as a placeholder in code lines. */
const INLINE_HEX_MAX = 200;

// What the node does with an Ethereum transaction was measured by real sends of value transfers on
// the testnet on Nov 15, 2026; the rule itself is in lib/evm.ts (acceptanceOf).
const RULE_BASIS = 'its rule, measured by real sends of value transfers on the testnet on Nov 15, 2026';
const ALSO_REFUSED =
  '  refused the same way: a gas limit below what the transaction uses (1 percent below was refused, 0.5 percent above was taken) and a max fee below the base fee get the same bare 1010 (measured on Nov 15, 2026). ' +
  'So keep the gas limit at or above the estimate, and estimate again if the base fee rises by more than one eighth before you send.';
const SENT_ANYWAY_REVERT =
  '  Sent anyway with a gas limit of its own, it is not stopped by the node: when the balance covers gas limit x base fee it is taken, it FAILS in its block (receipt status 0x0), and gas used x base fee is charged (measured on Nov 15, 2026, testnet block 477827).';
const SENT_ANYWAY_DISPATCH =
  '  Sent anyway, it is taken and FAILS in its block: the receipt shows status 0x0, gasUsed 0 and effectiveGasPrice 0, and the native fee is charged all the same (measured on Nov 15, 2026, testnet block 477826).';

function parseWei(value: string | number | undefined, network: Network): bigint {
  if (value === undefined) return 0n;
  const decimalAdvice = (s: string): string => {
    let hint = '';
    try {
      hint = ` If you mean ${s} ${network.token}, that is "${parseUnits(s, EVM_DECIMALS)}" wei.`;
    } catch {
      /* more than 18 decimals: no hint */
    }
    return `"value" is ${clip(s, 100)}, which has a decimal point. It is counted in wei, a whole number: 1 ${network.token} is 1000000000000000000 wei on the Ethereum side.${s.length <= 80 ? hint : ''} convert_amount does this conversion and shows both sides; pass its result as a string.`;
  };
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new ToolError(decimalAdvice(String(value)));
    if (!Number.isSafeInteger(value)) throw new ToolError(`"value" is ${value}, larger than 9007199254740991 (2^53 - 1), so it has already lost precision as a JSON number. Pass it as a string of digits, in wei.`);
    if (value < 0) throw new ToolError('"value" cannot be negative.');
    return BigInt(value);
  }
  const s = value.trim();
  if (s === '') throw new ToolError('"value" is empty. Leave it out, or write "0", for a transaction that sends no tokens.');
  if (/^\d+$/.test(s) || /^0x[0-9a-fA-F]+$/.test(s)) {
    if (s.length > 80) throw new ToolError('"value" is far too long to be an amount of wei. Nothing was sent.');
    const wei = BigInt(s);
    if (wei >= 2n ** 128n) {
      throw new ToolError(`"value" is larger than 2^128 wei, more ${network.token} than could ever exist, so it is not an amount. Nothing was sent. If you pasted a 32-byte key or hash here by mistake and it was a private key, it has not left this computer.`);
    }
    return wei;
  }
  if (/^\d*\.\d*$/.test(s) && /\d/.test(s)) throw new ToolError(decimalAdvice(s));
  throw new ToolError(`"value" is "${clip(s, 100)}", which is not a whole number of wei. Write it with digits only, for example "10000000000000000" for 0.01 ${network.token}, or as 0x hex: no commas, units or exponent.`);
}

/** The nonce to sign with: the node's next index, which counts waiting transactions, unless the Ethereum RPC has seen a newer block. */
function nonceToUse(r: EthReading, pool: PoolNonce | null): bigint {
  if (!pool) return r.noncePending;
  const next = BigInt(pool.next);
  return next > r.nonceLatest ? next : r.nonceLatest;
}

function nonceLine(r: EthReading, pool: PoolNonce | null): string {
  if (!pool) return `${r.noncePending}. The node did not answer system_accountNextIndex just now, so a transaction of this account that still waits for its block may not be counted here: get_account shows it.`;
  const use = nonceToUse(r, pool);
  const n = waitingCount(pool);
  if (n === 0) return `${use} (system_accountNextIndex: nothing of this account is waiting for a block)`;
  const one = n === 1;
  return (
    `${use}. WARNING: ${one ? '1 transaction' : `${n} transactions`} of this account ${one ? 'is' : 'are'} still waiting for ${one ? 'its' : 'their'} block (nonce ${pool.nonce} in blocks, system_accountNextIndex ${pool.next}). ` +
    `Nonce ${use} sends after ${one ? 'it' : 'them'}; wait for ${one ? 'it' : 'them'} first if this transaction depends on ${one ? 'it' : 'them'}. ` +
    `A wallet that takes its nonce from eth_getTransactionCount "pending" gets ${pool.nonce} here, the nonce of a waiting transaction: on this chain that count leaves waiting transactions out (measured on Nov 15, 2026).`
  );
}

/** One eth_estimateGas of the same transaction without its value, to learn its gas when the value cannot be paid. Null when that fails too. */
async function estimateWithoutValue(conn: Conn, reading: EthReading, q: EthQuery): Promise<bigint | null> {
  try {
    if (reading.path === 'rpc') {
      const tx: Record<string, string> = { from: q.from };
      if (q.to) tx.to = q.to;
      if (q.data && q.data !== '0x') tx.data = q.data;
      return ethQuantity(await ethRpc<string>(conn.network, 'eth_estimateGas', [tx]), 'eth_estimateGas');
    }
    return (await readEthSide(conn, { ...q, value: 0n })).estimate;
  } catch {
    return null;
  }
}

/** The lines of the node's two balance checks and the verdict. */
function acceptanceLines(a: Acceptance, value: bigint, network: Network, fundTarget: string, balanceLine: string): string[] {
  return [
    `  to be taken:     gas limit x base fee = ${weiAmount(a.toBeTaken, network)}. The max fee, the priority fee and the value are not counted.`,
    value > 0n &&
      `  to succeed:      gas limit x base fee + the value = ${weiAmount(a.toSucceed, network)}. In its block the chain first takes gas limit x base fee, and the value must fit in what is left.`,
    balanceLine,
    `  verdict:         ${verdictText(a, network, fundTarget)}`,
  ].filter((l): l is string => typeof l === 'string');
}

export default defineTool({
  name: 'estimate_eth_transaction',
  title: 'Portaldot V3: cost and acceptance of an Ethereum transaction',
  description:
    'Before an Ethereum transaction is sent on Portaldot V3 (MetaMask, cast, viem, ethers): what it will really cost and what the node will do with it. Gas here includes the storage deposit, so estimates look enormous. ' +
    'The verdict is one of three, by the rule we measured with real sends: TAKEN and it should succeed; TAKEN but it will FAIL in its block and still cost the fee (the value does not fit in the balance left after gas limit x base fee); or REFUSED with error 1010 (gas limit x base fee is more than the balance; the max fee, the priority fee and the value are not counted). ' +
    'Returns the gas estimate, the base fee, the expected cost in tokens, what is really charged, the gas limit (+10 percent), the max fee (+1/8), priority fee 0, both balance checks and the balance now, the verdict with what to change, ' +
    "the nonce to use (counting transactions that still wait in the node's pool, which eth_getTransactionCount \"pending\" leaves out here), and fields to copy for viem, ethers and cast. Explains a revert. On the mainnet it asks the node's own runtime API. Use it for contract calls, value transfers, deployments (leave out \"to\") and native calls sent to the pallets address. " +
    'Never signs. Example (the sender is the Treasury in its 0x form, which no key can sign for, so the answer has the figures but no fields to copy): {"from": "0x8ddee436166f311ddeed36d714b08f512670d16e", "to": "0x6d6f646c70792f70616464720000000000000000", "data": "0x0007946e61746976652063616c6c2066726f6d2061203078206163636f756e742c20746573742031"}.',
  input: {
    from: z
      .string()
      .min(1)
      .describe('The sender: the 0x address that will sign, usually a MetaMask account. A 5... address is turned into its 0x form. An estimate needs no signature, so any address works, but the fields to copy are given only for the address of an Ethereum key: the 0x form of a native 5... account cannot sign an Ethereum transaction. Never a key or a secret phrase.'),
    to: z
      .string()
      .optional()
      .describe('The recipient or contract: 0x and 40 hex characters. Leave it out for a contract deployment. The pallets address 0x6d6f646c70792f70616464720000000000000000 runs a native call (data from encode_call).'),
    data: z
      .string()
      .optional()
      .describe('The data: 0x hex. ABI-encoded calldata such as "0x06fdde03", the init code for a deployment, or call bytes from encode_call. Leave it out for a plain transfer.'),
    value: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Tokens to send, in wei (18 decimals) as a string of digits: "10000000000000000" is 0.01 tPOT. Default "0". Keep it a multiple of 10000 wei (a whole native unit); convert_amount converts.'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ from, to, data, value, network: key }) => {
    const network = pickNetwork(key);
    const token = network.token;
    const fromParsed = parseAddress(from);
    let toH160: string | undefined;
    let toChecksumWarning: string | undefined;
    if (to !== undefined && to.trim() !== '') {
      const p = parseAddress(to);
      if (p.kind !== 'h160') {
        throw new ToolError(`"to" must be a 0x address (0x and 40 hex characters). ${to.trim()} is a native address; its 0x form is ${checksummed(p.h160)}. convert_address says which form to use where.`);
      }
      toH160 = p.h160;
      toChecksumWarning = p.checksumWarning;
    }
    const dataHex = data === undefined || data.trim() === '' ? undefined : data.trim();
    if (dataHex !== undefined && !isHex(dataHex)) {
      throw new ToolError(`"data" must be 0x and an even number of hex characters: ABI-encoded calldata, init code, or call bytes from encode_call. Got "${clip(dataHex, 40)}".`);
    }
    const hasData = dataHex !== undefined && dataHex !== '0x';
    if (!toH160 && !hasData) throw new ToolError('Without "to" this is a contract deployment, and a deployment needs its init code in "data". To send tokens to an address, give "to".');
    const valueWei = parseWei(value, network);
    const isDeploy = !toH160;
    const toPallets = toH160 !== undefined && isPalletsAddress(toH160);

    const conn = await getConn(network.key);
    const index = getIndex(conn);
    const fromH160 = fromParsed.h160;
    const query: EthQuery = { from: fromH160, to: toH160, data: hasData ? dataHex : undefined, value: valueWei };
    // The pool's view of the nonce is read from the account that pays, once it is known.
    const [{ holder, pool }, fromRevive, toRevive, reading] = await Promise.all([
      resolveHolder(conn, fromParsed).then(async (h) => ({ holder: h, pool: await readPoolNonce(conn, h.holderSs58).catch((): PoolNonce | null => null) })),
      readReviveAccount(conn, fromH160),
      toH160 && !toPallets ? readReviveAccount(conn, toH160) : Promise.resolve(null),
      readEthSide(conn, query),
    ]);
    const nonce = nonceToUse(reading, pool);

    // Who can sign: only an Ethereum key. A native account's 0x form is a hash, and a contract has no key.
    const nativeInput = fromParsed.kind !== 'h160' && !fromParsed.isFallbackForm;
    const nativeOwner = nativeInput ? toSs58(fromParsed.accountId) : fromParsed.kind === 'h160' ? holder.linked : null;
    const fromContract = Boolean(fromRevive?.contract);
    const canSign = !nativeOwner && !fromContract;
    const fromC = checksummed(fromH160);

    let palletsCall: string | null = null;
    let palletsProblem: string | null = null;
    let palletsOrigin: string | null = null;
    let palletsNotes: string[] = [];
    if (toPallets) {
      if (!hasData) palletsProblem = 'there is no data, so there is no native call to run.';
      else {
        try {
          const call = decodeCallBytes({ conn, index, network }, dataHex as string, '"data"');
          palletsCall = callName(index, call);
          const item = findCallItem(index, call);
          palletsOrigin = item ? specialOriginNote(item) : null;
          palletsNotes = innerCallNotes(callNames(index, call));
        } catch (err) {
          palletsProblem = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const toText = isDeploy
      ? 'none: this is a contract deployment, and "data" is its init code'
      : toPallets
        ? `${checksummed(toH160 as string)}, the pallets address: this runs a native call${palletsCall ? `, ${palletsCall}` : ''}`
        : toRevive?.contract
          ? `${checksummed(toH160 as string)}, a contract: ${toRevive.contract.codeLen} bytes of ${codeKind(toRevive.contract.codeType)} code`
          : `${checksummed(toH160 as string)}, an account with no contract code`;
    const dataText = !hasData ? 'none' : `${((dataHex as string).length - 2) / 2} bytes${!isDeploy && !toPallets && (dataHex as string).length >= 10 ? `, function selector ${(dataHex as string).slice(0, 10)}` : ''}`;

    const via =
      reading.path === 'rpc'
        ? `Read just now through the Ethereum RPC ${network.evmCopy} (eth_estimateGas, eth_gasPrice, eth_getBalance, eth_getTransactionCount) and the node (system_accountNextIndex). Nothing was signed or sent.`
        : reading.fallbackReason
          ? `The Ethereum RPC gave no usable answer just now (${reading.fallbackReason}), so this was read through the node's runtime API (ReviveApi) instead. ${RUNTIME_PATH_BASIS} Sending still needs the Ethereum RPC. Nothing was signed or sent.`
          : `Read just now through the node's runtime API (ReviveApi: ethEstimateGas, gasPrice, balance, nonce), because the ${network.label} has no public Ethereum RPC (checked Nov 13, 2026). ${RUNTIME_PATH_BASIS} Nothing was signed or sent.`;

    const warnings: Array<string | null | undefined | false> = [
      fromParsed.checksumWarning && `WARNING (from): ${fromParsed.checksumWarning}`,
      toChecksumWarning && `WARNING (to): ${toChecksumWarning}`,
      nativeOwner &&
        `WARNING: ${fromC} is the 0x form of the native account ${nativeOwner}. No Ethereum key can sign for that address (it is derived from the account id by a hash), so it cannot send an Ethereum transaction at all. ` +
          'It calls contracts with the native call Revive.call, for which simulate_contract_call gives the limits, and sends other native calls with its own key (encode_call). The figures below are for information only.',
      fromContract && `WARNING: ${fromC} is a contract. A contract has no key, so it cannot send a transaction. The figures below are for information only.`,
      valueWei % NATIVE_TO_WEI !== 0n &&
        `WARNING: the value, ${valueWei} wei, is not a whole number of native units (1 unit = 10000 wei): it is ${valueWei / NATIVE_TO_WEI} units and ${valueWei % NATIVE_TO_WEI} wei more. ` +
          'Measured on Nov 15, 2026 (testnet block 477828): 0.001 tPOT + 1 wei was sent and charged in full; the receiver\'s native balance rose by 0.001 tPOT only, and the extra wei shows on its Ethereum side alone (eth_getBalance), kept as dust. Send a multiple of 10000 wei unless that is what you want.',
      toPallets &&
        (nativeOwner
          ? `Note: "to" is the pallets address, so this runs a native call. ` +
            (holder.linked
              ? `From the 0x form of a native account, as here, the node runs it as that native account itself, ${nativeOwner}, so the figures below are that account's (checked by dry run on Nov 15, 2026). `
              : `${nativeOwner} is not linked to its 0x form yet (a native account is linked when it is created), so the node runs the call as that 0x form's fallback account ${toSs58(fallbackIdOfH160(fromH160))}, not as ${nativeOwner}. `) +
            "Sent from an Ethereum key, such a transaction runs the call as the key's fallback account instead; its receipt shows gasUsed 0 and no logs, and its result is in the Substrate events of the same block. " +
            'This was proven on Nov 13, 2026 with System.remarkWithEvent and Balances.transferKeepAlive; other calls were dry-run this way on Nov 15, 2026 (143 dry runs of calls across 18 modules), not sent.'
          : `Note: "to" is the pallets address, so this transaction runs a native call as the sender's fallback account (the 20 bytes followed by twelve 0xEE bytes), which pays its fee. Its receipt will show gasUsed 0 and no logs; its result is in the Substrate events of the same block. ` +
            'This was proven on Nov 13, 2026 with System.remarkWithEvent and Balances.transferKeepAlive; other calls were dry-run this way on Nov 15, 2026 (143 dry runs of calls across 18 modules), not sent.'),
      palletsProblem && `WARNING: ${palletsProblem}`,
      ...palletsNotes,
      palletsOrigin && `WARNING: the chain's own notes for ${palletsCall} say: "${palletsOrigin}" A call that needs a special origin (root) cannot work through the pallets address.`,
      toPallets && valueWei > 0n && 'WARNING: a value sent together with a native call is refused: on Nov 14, 2026 eth_estimateGas answered "Invalid call: Call" (code -32000) to every such transaction we tried. Send value 0 and let the call itself move any tokens.',
      !isDeploy && !toPallets && !toRevive?.contract && hasData &&
        `WARNING: ${checksummed(toH160 as string)} has no contract code on the ${network.label}, so the data will not run any code${valueWei > 0n ? ' (the value is still sent)' : ''}. Check the address and the network.`,
      isDeploy &&
        'Note: deployments by Ethereum transaction succeed on the testnet in other builders\' transactions (for example in block 354887; read on Nov 14, 2026). The Bridge Zero team has not sent one itself. The native path, Revive.instantiateWithCode, is the one we proved; simulate_contract_deploy gives its limits and the deposit for your code.',
    ];

    const head = [
      `Ethereum transaction on the ${network.label}: cost, limits, and what the node will do with it.`,
      via,
      '',
      'Transaction',
      `  from:  ${fromC}${nativeOwner ? ` (the 0x form of the native account ${nativeOwner})` : ''}`,
      `  to:    ${toText}`,
      `  value: ${weiAmount(valueWei, network)}`,
      `  data:  ${dataText}`,
      ...(warnings.filter(Boolean).length ? ['', ...(warnings.filter(Boolean) as string[])] : []),
    ];
    const fundTarget = `${holder.holderSs58}${canSign ? ' (its native form: send from a native wallet), or to the 0x address from another Ethereum account' : ''}`;
    const balanceLine = `  balance now:     ${weiAmount(reading.balance, network)}, as eth_getBalance reports it: the free balance less the 0.1 ${token} existential deposit (or less the frozen amount when that is larger), plus dust`;
    const priceLine = `  gas price now:   ${reading.gasPrice} wei per gas (the base fee)`;

    // The estimate failed: a revert, a balance below the value, or another refusal.
    if (reading.estimate === null) {
      const f = reading.failure;
      const codeText = f?.code !== null && f?.code !== undefined ? ` (code ${f.code})` : '';
      const tail: Array<string | false> = [];
      if (f?.revert) {
        const revert = decodeRevert(f.data);
        tail.push(
          'The estimate failed: the transaction reverts.',
          `  node message: ${untrusted(f.message, 600)}${codeText}`,
          f.data !== null &&
            `  revert data: ${!isEthHex(f.data) ? `${untrusted(f.data, 200)} (not 0x hex, as the node should write it)` : f.data.length <= 400 ? f.data : `${f.data.slice(0, 400)}... (${(f.data.length - 2) / 2} bytes)`}`,
          `  ${revert.text}`,
          '  Sending it now would fail the same way.',
          SENT_ANYWAY_REVERT,
          `  gas price now: ${reading.gasPrice} wei per gas (the base fee)`,
          balanceLine,
          `  nonce to use:  ${nonceLine(reading, pool)}`,
          '',
          isDeploy
            ? 'Next: simulate_contract_deploy runs the deployment as a dry run and shows where the constructor fails.'
            : 'Next: simulate_contract_call runs the same call as a dry run and decodes the result; explain_error reads the message.',
        );
      } else if (f && /insufficient funds/i.test(f.message)) {
        // eth_estimateGas refuses a value the balance cannot pay, but the node does not count the value
        // (measured on Nov 15, 2026), so the gas is estimated again without it to give the verdict.
        const bare = await estimateWithoutValue(conn, reading, query);
        tail.push(
          'The estimate failed: the balance does not cover the value. eth_estimateGas refuses such a transaction; the node itself does not count the value before the block.',
          `  node message:    ${untrusted(f.message, 600)}${codeText}`,
          `  value:           ${weiAmount(valueWei, network)}`,
          priceLine,
        );
        if (bare !== null) {
          const { gasLimit, maxFee } = ethLimits(bare, reading.gasPrice, 0n);
          tail.push(
            `  without the value the estimate is ${bare} gas, so a gas limit of ${gasLimit} (estimate + 10 percent). With that gas limit, the node's two checks (${RULE_BASIS}):`,
            ...acceptanceLines(acceptanceOf({ gasLimit, baseFee: reading.gasPrice, value: valueWei, balance: reading.balance, maxFee }), valueWei, network, fundTarget, balanceLine),
          );
        } else {
          tail.push(
            balanceLine,
            `  verdict:         the gas could not be estimated without the value either. By the node's rule (${RULE_BASIS}), a balance that covers gas limit x base fee gets such a transaction taken, and it then FAILS in its block and costs the fee; a smaller balance gets it refused with 1010. Lower the value, or send ${token} to ${fundTarget} first, then estimate again.`,
          );
        }
        tail.push(`  nonce to use:    ${nonceLine(reading, pool)}`);
      } else {
        tail.push(
          'The estimate failed.',
          `  node message: ${untrusted(f?.message ?? 'no answer', 600)}${codeText}`,
          f !== null && /Failed to dispatch call/i.test(f.message) && SENT_ANYWAY_DISPATCH,
          priceLine,
          balanceLine,
          `  nonce to use:    ${nonceLine(reading, pool)}`,
          '',
          'Next: explain_error reads this message.',
        );
      }
      return lines(...head, '', ...tail.filter((l): l is string => typeof l === 'string'));
    }

    const estimate = reading.estimate;
    const cost = estimate * reading.gasPrice;
    const { gasLimit, maxFee } = ethLimits(estimate, reading.gasPrice, valueWei);
    const acceptance = acceptanceOf({ gasLimit, baseFee: reading.gasPrice, value: valueWei, balance: reading.balance, maxFee });

    const inline = (h: string | undefined): string => (h === undefined ? '0x' : h.length <= INLINE_HEX_MAX ? h : 'DATA');
    const dataInline = inline(hasData ? dataHex : undefined);
    const toField = isDeploy ? '' : `to: '${checksummed(toH160 as string)}', `;
    const viem = `{ ${toField}data: ${dataInline === 'DATA' ? 'DATA' : `'${dataInline}'`}, value: ${valueWei}n, nonce: ${nonce}, gas: ${gasLimit}n, maxFeePerGas: ${maxFee}n, maxPriorityFeePerGas: 0n, chainId: ${network.evmChainId}, type: 'eip1559' }`;
    const ethers = `{ ${toField}data: ${dataInline === 'DATA' ? 'DATA' : `'${dataInline}'`}, value: ${valueWei}n, nonce: ${nonce}, gasLimit: ${gasLimit}n, maxFeePerGas: ${maxFee}n, maxPriorityFeePerGas: 0n, chainId: ${network.evmChainId}, type: 2 }`;
    const castData = dataInline === 'DATA' ? '"$DATA"' : dataInline;
    const castOpts = `--rpc-url ${network.evmCopy} --chain ${network.evmChainId} --nonce ${nonce} --gas-limit ${gasLimit} --gas-price ${maxFee} --priority-gas-price 0 --value ${valueWei} --account <keystore name>`;

    const fieldsHead =
      acceptance.outcome === 'ok'
        ? 'Fields to copy (estimate again just before sending: the base fee moves from block to block):'
        : acceptance.outcome === 'fails'
          ? 'Fields to copy, for after you lower the value or add funds (sent as they are now, the transaction fails in its block and costs the fee):'
          : 'Fields to copy, for after you add funds (sent now, the node refuses them with 1010):';
    let fields: string[];
    if (!canSign) {
      fields = ['No fields to copy: no key can sign for this sender (see the warning above).'];
    } else if (!network.evm) {
      fields = [
        `There is nowhere to send this transaction on the ${network.label} today: it has no public Ethereum RPC (checked Nov 13, 2026), so MetaMask, cast and viem cannot reach it. If one appears, the fields would be:`,
        `  viem:   ${viem}`,
        `  ethers: ${ethers}`,
      ];
    } else {
      fields = [
        fieldsHead,
        `  viem:   ${viem}`,
        `  ethers (v6): ${ethers}`,
        '  cast (signs with your own keystore; this tool never needs a key):',
        isDeploy ? `    cast mktx ${castOpts} --create ${castData}` : `    cast mktx ${checksummed(toH160 as string)} ${castData} ${castOpts}`,
        `    cast publish <the raw transaction that mktx printed> --rpc-url ${network.evmCopy}`,
        isDeploy && '    (the options go before --create, which takes the init code)',
        dataInline === 'DATA' && `  DATA is the data you passed (${((dataHex as string).length - 2) / 2} bytes).`,
      ].filter((l): l is string => typeof l === 'string');
    }

    const next = nativeOwner
      ? 'Next: simulate_contract_call gives the limits of the native Revive.call for this account.'
      : isDeploy
        ? 'Next: simulate_contract_deploy shows the deposit for this code and the address the contract will get.'
        : toPallets
          ? 'Next: once it is sent, get_transaction reads the result from the Substrate events.'
          : 'Next: once it is sent, get_transaction reads the receipt and the Substrate events; explain_error reads any error the node gives back.';

    return lines(
      ...head,
      '',
      'Cost',
      `  gas estimate:  ${estimate} gas`,
      `  gas price now: ${reading.gasPrice} wei per gas (the base fee: on Nov 16, 2026 eth_gasPrice equalled the newest block's baseFeePerGas)`,
      `  expected cost: estimate x gas price = ${weiAmount(cost, network)}.`,
      `  On Portaldot V3 gas includes the storage deposit, so this is the fee and the storage deposit together. The deposit part is held while the storage exists. On the native path it is returned when the storage is cleared (measured Oct 19-20, 2026); whether that also holds for a deposit paid through an Ethereum transaction was not tested.`,
      toPallets
        ? '  charged:       the native fee of the call, which only the node\'s events show (TransactionFeePaid). The receipt shows gasUsed 0 and effectiveGasPrice 0, also when the call fails and the fee is paid (testnet block 477826, Nov 15, 2026). How close that fee comes to the expected cost above was not measured.'
        : '  charged:       gas used x base fee, also when the transaction fails in its block. Unused gas, the room up to the max fee and the priority fee are not charged (measured on Nov 15, 2026). ' +
          'Gas used is a little below the estimate: a value transfer used 4.6 percent less (testnet block 477814), and the gas used by one transfer changed with the size of the signed transaction.',
      `  For scale: ${depositScale(token)}.`,
      '',
      'Limits to sign with',
      `  gas limit:       ${gasLimit} (estimate + 10 percent)`,
      `  max fee per gas: ${maxFee} wei (gas price + one eighth: room for the base fee to rise; it is not charged)`,
      '  max priority fee per gas: 0 (not charged on this chain either, but it ranks transactions with the same nonce)',
      '',
      `What the node will do (${RULE_BASIS})`,
      ...acceptanceLines(acceptance, valueWei, network, fundTarget, balanceLine),
      ALSO_REFUSED,
      `  nonce to use:    ${nonceLine(reading, pool)}`,
      '',
      ...fields,
      '',
      next,
    );
  },
});
