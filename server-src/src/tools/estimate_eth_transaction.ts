import * as z from 'zod';
import { codeKind, readReviveAccount, resolveHolder } from '../lib/accounts.ts';
import { checksummed, parseAddress, toSs58 } from '../lib/address.ts';
import { callName, decodeCallBytes, depositScale, ethLimits, findCallItem, isPalletsAddress, readEthSide, RUNTIME_PATH_BASIS, specialOriginNote, type EthReading } from '../lib/calls.ts';
import { getConn, isEthHex } from '../lib/chain.ts';
import { ToolError } from '../lib/errors.ts';
import { decodeRevert } from '../lib/evm.ts';
import { clip, isHex, lines, parseUnits, untrusted, weiAmount } from '../lib/format.ts';
import { getIndex } from '../lib/meta.ts';
import { EVM_DECIMALS, NATIVE_TO_WEI, pickNetwork, type Network } from '../lib/networks.ts';
import { defineTool, networkField } from '../lib/tool.ts';

/** Hex longer than this is written as a placeholder in code lines. */
const INLINE_HEX_MAX = 200;

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

function nonceLine(r: EthReading): string {
  if (r.nonceLatest === r.noncePending) return `${r.noncePending} (latest and pending agree)`;
  return (
    `${r.noncePending}. WARNING: the latest nonce is ${r.nonceLatest} but the pending one is ${r.noncePending}, so ${r.noncePending - r.nonceLatest} transaction(s) from this account are still waiting. ` +
    `Wait until they are in a block, or use nonce ${r.noncePending} to send after them.`
  );
}

export default defineTool({
  name: 'estimate_eth_transaction',
  title: 'Portaldot V3: cost and acceptance of an Ethereum transaction',
  description:
    'Before an Ethereum transaction is sent on Portaldot V3 (MetaMask, cast, viem, ethers): what it will really cost and whether the node will accept it. Gas here includes the storage deposit, so estimates look enormous, ' +
    'and the node refuses a transaction with error 1010 when gas limit x base fee, plus the value, is more than the balance (this tool checks with the max fee, which is stricter). Returns the gas estimate, the gas price, the expected cost in tokens, the gas limit (+10 percent), the max fee (+1/8), priority fee 0, ' +
    'the balance needed and the balance now, a verdict, the nonce, and fields to copy for viem, ethers and cast. Explains a revert. On the mainnet it asks the node\'s own runtime API. Use it for contract calls, value transfers, deployments (leave out "to") and native calls sent to the pallets address. ' +
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
    const [holder, fromRevive, toRevive, reading] = await Promise.all([
      resolveHolder(conn, fromParsed),
      readReviveAccount(conn, fromH160),
      toH160 && !toPallets ? readReviveAccount(conn, toH160) : Promise.resolve(null),
      readEthSide(conn, { from: fromH160, to: toH160, data: hasData ? dataHex : undefined, value: valueWei }),
    ]);

    // Who can sign: only an Ethereum key. A native account's 0x form is a hash, and a contract has no key.
    const nativeInput = fromParsed.kind !== 'h160' && !fromParsed.isFallbackForm;
    const nativeOwner = nativeInput ? toSs58(fromParsed.accountId) : fromParsed.kind === 'h160' ? holder.linked : null;
    const fromContract = Boolean(fromRevive?.contract);
    const canSign = !nativeOwner && !fromContract;
    const fromC = checksummed(fromH160);

    let palletsCall: string | null = null;
    let palletsProblem: string | null = null;
    let palletsOrigin: string | null = null;
    if (toPallets) {
      if (!hasData) palletsProblem = 'there is no data, so there is no native call to run.';
      else {
        try {
          const call = decodeCallBytes({ conn, index, network }, dataHex as string, '"data"');
          palletsCall = callName(index, call);
          const item = findCallItem(index, call);
          palletsOrigin = item ? specialOriginNote(item) : null;
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
        ? `Read just now through the Ethereum RPC ${network.evmCopy} (eth_estimateGas, eth_gasPrice, eth_getBalance, eth_getTransactionCount). Nothing was signed or sent.`
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
          'The chain keeps native units, plus a remainder below 10000 wei per account; what it does with such a remainder in a transfer was not tested. Send a multiple of 10000 wei.',
      toPallets &&
        `Note: "to" is the pallets address, so this transaction runs a native call as the sender's fallback account, which pays its fee. Its receipt will show gasUsed 0 and no logs; its result is in the Substrate events of the same block. ` +
          'This was proven on Nov 13, 2026 with System.remarkWithEvent and Balances.transferKeepAlive; other calls are expected to work the same way but were not tested.',
      palletsProblem && `WARNING: ${palletsProblem}`,
      palletsOrigin && `WARNING: the chain's own notes for ${palletsCall} say: "${palletsOrigin}" A call that needs a special origin (root) cannot work through the pallets address.`,
      toPallets && valueWei > 0n && 'WARNING: a value sent together with a native call is refused: on Nov 14, 2026 eth_estimateGas answered "Invalid call: Call" (code -32000) to every such transaction we tried. Send value 0 and let the call itself move any tokens.',
      !isDeploy && !toPallets && !toRevive?.contract && hasData &&
        `WARNING: ${checksummed(toH160 as string)} has no contract code on the ${network.label}, so the data will not run any code${valueWei > 0n ? ' (the value is still sent)' : ''}. Check the address and the network.`,
      isDeploy &&
        'Note: deployments by Ethereum transaction succeed on the testnet in other builders\' transactions (for example in block 354887; read on Nov 14, 2026). The Bridge Zero team has not sent one itself. The native path, Revive.instantiateWithCode, is the one we proved; simulate_contract_deploy gives its limits and the deposit for your code.',
    ];

    const head = [
      `Ethereum transaction on the ${network.label}: cost, limits, and whether the node will accept it.`,
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
          `  gas price now: ${reading.gasPrice} wei per gas`,
          balanceLine,
          `  nonce to use:  ${nonceLine(reading)}`,
          '',
          isDeploy
            ? 'Next: simulate_contract_deploy runs the deployment as a dry run and shows where the constructor fails.'
            : 'Next: simulate_contract_call runs the same call as a dry run and decodes the result; explain_error reads the message.',
        );
      } else if (f && /insufficient funds/i.test(f.message)) {
        tail.push(
          'The estimate failed: the balance does not cover the value.',
          `  node message: ${untrusted(f.message, 600)}${codeText}`,
          balanceLine,
          `  value:           ${weiAmount(valueWei, network)}`,
          `  verdict:         REFUSED. The node will not accept this transaction while the balance is below the value plus the gas. Send ${token} to ${fundTarget} first, then estimate again.`,
          `  gas price now:   ${reading.gasPrice} wei per gas`,
          `  nonce to use:    ${nonceLine(reading)}`,
        );
      } else {
        tail.push(
          'The estimate failed.',
          `  node message: ${untrusted(f?.message ?? 'no answer', 600)}${codeText}`,
          `  gas price now:   ${reading.gasPrice} wei per gas`,
          balanceLine,
          `  nonce to use:    ${nonceLine(reading)}`,
          '',
          'Next: explain_error reads this message.',
        );
      }
      return lines(...head, '', ...tail.filter((l): l is string => typeof l === 'string'));
    }

    const estimate = reading.estimate;
    const cost = estimate * reading.gasPrice;
    const { gasLimit, maxFee, needed } = ethLimits(estimate, reading.gasPrice, valueWei);
    const accepted = reading.balance >= needed;
    const verdict = accepted
      ? `ACCEPTED: the balance covers it, with ${weiAmount(reading.balance - needed, network, false)} to spare.`
      : `REFUSED: expect the node to refuse this transaction with error 1010, because the balance is short by ${weiAmount(needed - reading.balance, network)}. Send at least that much ${token} to ${fundTarget}${valueWei > 0n ? ', or lower the value' : ''}. A higher gas limit only raises the balance needed.`;

    const inline = (h: string | undefined): string => (h === undefined ? '0x' : h.length <= INLINE_HEX_MAX ? h : 'DATA');
    const dataInline = inline(hasData ? dataHex : undefined);
    const toField = isDeploy ? '' : `to: '${checksummed(toH160 as string)}', `;
    const viem = `{ ${toField}data: ${dataInline === 'DATA' ? 'DATA' : `'${dataInline}'`}, value: ${valueWei}n, nonce: ${reading.noncePending}, gas: ${gasLimit}n, maxFeePerGas: ${maxFee}n, maxPriorityFeePerGas: 0n, chainId: ${network.evmChainId}, type: 'eip1559' }`;
    const ethers = `{ ${toField}data: ${dataInline === 'DATA' ? 'DATA' : `'${dataInline}'`}, value: ${valueWei}n, nonce: ${reading.noncePending}, gasLimit: ${gasLimit}n, maxFeePerGas: ${maxFee}n, maxPriorityFeePerGas: 0n, chainId: ${network.evmChainId}, type: 2 }`;
    const castData = dataInline === 'DATA' ? '"$DATA"' : dataInline;
    const castOpts = `--rpc-url ${network.evmCopy} --chain ${network.evmChainId} --nonce ${reading.noncePending} --gas-limit ${gasLimit} --gas-price ${maxFee} --priority-gas-price 0 --value ${valueWei} --account <keystore name>`;

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
        'Fields to copy (estimate again just before sending: the gas price moves from block to block):',
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
      `  gas price now: ${reading.gasPrice} wei per gas`,
      `  expected cost: estimate x gas price = ${weiAmount(cost, network)}.`,
      `  On Portaldot V3 gas includes the storage deposit, so this is the fee and the storage deposit together. The deposit part is held while the storage exists. On the native path it is returned when the storage is cleared (measured Oct 19-20, 2026); whether that also holds for a deposit paid through an Ethereum transaction was not tested.`,
      "  The node's estimate can be up to 1.5 percent above what the transaction uses (the chain's own description of its estimate).",
      `  For scale: ${depositScale(token)}.`,
      '',
      'Limits to sign with',
      `  gas limit:       ${gasLimit} (estimate + 10 percent)`,
      `  max fee per gas: ${maxFee} wei (gas price + one eighth, room for the gas price to rise)`,
      '  max priority fee per gas: 0',
      `  balance needed to be accepted: value + gas limit x max fee = ${weiAmount(needed, network)}`,
      balanceLine,
      `  verdict:         ${verdict}`,
      `  nonce to use:    ${nonceLine(reading)}`,
      '',
      ...fields,
      '',
      next,
    );
  },
});
