import * as z from 'zod';
import { codeKind, readReviveAccount } from '../lib/accounts.ts';
import { checksummed } from '../lib/address.ts';
import { getConn } from '../lib/chain.ts';
import {
  budgetLines,
  byteLen,
  depositLimitOf,
  depositText,
  explainDryRunError,
  feeOf,
  hexShown,
  parseContractAddress,
  parseHexInput,
  parseNativeValue,
  readBalance,
  readDryRun,
  resolveSender,
  reviveDryRun,
  senderLine,
  weightCode,
  weightLimitOf,
  weightText,
} from '../lib/dryrun.ts';
import { ToolError } from '../lib/errors.ts';
import { decodeRevert, describeReturn } from '../lib/evm.ts';
import { lines, nativeAmount, weiAmount } from '../lib/format.ts';
import { NATIVE_TO_WEI, PALLETS_ADDRESS, pickNetwork } from '../lib/networks.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const MAX_DATA_BYTES = 131_072;

/** Addresses whose first 18 bytes are zero: where Ethereum and pallet-revive put built-in precompiles. */
const isLowAddress = (h160: string): boolean => /^0x0{36}/.test(h160);

export default defineTool({
  name: 'simulate_contract_call',
  title: 'Portaldot V3: dry-run a contract call',
  description:
    'Dry-runs a Solidity contract call on Portaldot V3 in the node itself (reviveApi.call): nothing is sent and no key is needed. ' +
    'Returns what a view function returns (the raw data, read as a number, bool or address when it is one word), whether the call reverts and why ' +
    '(Error(string), Panic, a custom error selector, or a chain error by name), and whether "to" is a contract at all. ' +
    'For sending it as the native call Revive.call, it gives the weight limit and storage deposit limit to pass, the fee, and the total cost against the balance of "from". ' +
    'It also says what the contract sees: msg.sender and msg.value in wei. For a call sent as an Ethereum transaction (MetaMask, viem), estimate_eth_transaction gives the gas fields. ' +
    'Use it to read contract state, to check a call before sending it, and to find out why a call fails. Works on the testnet and the mainnet. ' +
    'Example: {"from": "5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z", "to": "0x0000000200000000000000000000000000010000", "data": "0x313ce567"}.',
  input: {
    from: z.string().min(1).describe('Who makes the call: a native 5... address or a 0x address (MetaMask). A 0x address runs as the native account that holds its balance. Public addresses only. Example: "5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z".'),
    to: z.string().min(1).describe('The contract: 0x and 40 hex characters, not a 5... address. Example: "0x0000000200000000000000000000000000010000" (the ERC-20 address of Assets token 2; a deployed contract has its own 0x address).'),
    data: z.string().max(300_000).optional().describe('ABI-encoded calldata, 0x hex: the 4-byte selector and the arguments, as cast calldata or viem encodeFunctionData make it. Default "0x". Example: "0x313ce567" (decimals()).'),
    value: z.union([z.string().max(60), z.number()]).optional().describe('Native tokens to send with the call, in native base units (14 decimals), as a string of digits: "100000000000000" is 1 tPOT. Default "0". Not wei: the contract sees value x 10000 wei, and estimate_eth_transaction takes wei.'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ from, to, data, value, network: key }) => {
    const network = pickNetwork(key);
    const dest = parseContractAddress(to);
    const input = parseHexInput(data ?? '0x', 'data', { maxBytes: MAX_DATA_BYTES });
    const val = parseNativeValue(value ?? '0');

    const conn = await getConn(network.key);
    const api = conn.api as Loose;
    if (!api.tx.revive?.call) throw new ToolError(`The ${network.label} runtime has no Revive module, so there are no Solidity contracts to call.`);
    const sender = await resolveSender(conn, from);
    const [json, target, bal] = await Promise.all([
      reviveDryRun(conn, 'call', [sender.holderId, dest, val, null, null, input]),
      readReviveAccount(conn, dest),
      readBalance(conn, sender.holderId),
    ]);
    const dry = readDryRun(json, 'call');
    const ed = BigInt(api.consts.balances.existentialDeposit.toString());
    const contract = target?.contract ?? null;
    const isPallets = dest === PALLETS_ADDRESS;
    const destShown = checksummed(dest);

    /* ---- what is at "to" ---- */
    let toLine: string;
    if (contract) {
      toLine = `- to: ${destShown} is a contract: ${contract.codeLen} bytes of ${codeKind(contract.codeType)} code (code hash ${contract.codeHash}).`;
    } else if (isPallets) {
      toLine =
        `- to: the runtime's pallets address. An Ethereum transaction sent there runs the SCALE-encoded native call in its data (encode_call builds it). ` +
        'This dry run does not show what that native call would do: on Nov 14, 2026 it answered with no data and no weight both for a valid call and for junk bytes.';
    } else {
      toLine = `- to: there is no contract at ${destShown} on the ${network.label}.${network.key === 'mainnet' ? ' On Nov 14, 2026 the mainnet had no contracts at all, so this is the normal answer there: deploy and test on the testnet.' : ''}`;
    }

    /* ---- the result ---- */
    const result: string[] = [];
    let sendable = false;
    if (dry.err) {
      const e = explainDryRunError(api, dry.err);
      result.push(`Result: the chain refuses this call: ${e.title}.`, ...e.lines.map((l) => `  ${l}`));
      if (e.name === 'Revive.TransferFailed') result.push(`  value: ${nativeAmount(val, network)}; free balance of ${sender.holderSs58}: ${nativeAmount(bal.free, network)}.`);
    } else if (dry.ok?.reverted) {
      const r = decodeRevert(dry.ok.data);
      result.push(`Result: it reverts. ${r.text}`, byteLen(dry.ok.data) ? `- revert data (${byteLen(dry.ok.data)} bytes): ${hexShown(dry.ok.data)}` : '- revert data: none');
      if (!contract && !isPallets) result.push('- no contract is stored at that address, so the revert comes from a built-in precompile.');
      result.push(`Sending it as it is would fail. Check the selector and the arguments, and what "from" is allowed to do${val > 0n ? '. Check the value too: a Solidity function that is not payable reverts when it receives value' : ''}.`);
    } else if (dry.ok) {
      sendable = true;
      const n = byteLen(dry.ok.data);
      if (contract) {
        result.push(`Result: it succeeds and returns ${describeReturn(dry.ok.data)}.`, n ? `- return data: ${hexShown(dry.ok.data)}` : '- return data: none (0x)');
      } else if (n > 0) {
        result.push(`Result: it returns data although no contract is stored at that address, so the address is a built-in precompile. It returns ${describeReturn(dry.ok.data)}.`, `- return data: ${hexShown(dry.ok.data)}`);
      } else if (isPallets) {
        result.push('Result: it succeeds and returns nothing. See the note on the pallets address below.');
      } else if (isLowAddress(dest)) {
        result.push('Result: it succeeds and returns nothing. No contract is stored at this low address. Low addresses are kept for built-in precompiles; this one returned no data for this input.');
      } else {
        result.push(`Result: it succeeds and returns nothing: there is no contract at that address, so the call is a plain transfer of ${val > 0n ? nativeAmount(val, network, false) : 'no value'}.`);
      }
    }

    /* ---- the call as given ---- */
    const dataBytes = byteLen(input);
    const theCall = [
      'The call',
      senderLine(sender, network),
      toLine,
      `- data: ${dataBytes === 0 ? 'none (0x)' : `${dataBytes} bytes${dataBytes >= 4 ? `, selector ${input.slice(0, 10)}` : ', shorter than a 4-byte selector'}`}`,
      `- value: ${nativeAmount(val, network)}`,
      val >= 10n ** 18n && `  That is a large amount. If this number is in wei (18 decimals), the native amount is value / 10000 = ${val / NATIVE_TO_WEI} base units: the native side has 14 decimals.`,
    ];

    const sees = contract || (dry.ok !== null && byteLen(dry.ok.data) > 0) ? ['', 'What the contract sees', `- msg.sender = ${sender.msgSender} (the 0x form of "from")`, `- msg.value = ${weiAmount(val * NATIVE_TO_WEI, network)}: value x 10000, because the Ethereum side shows 18 decimals`] : [];

    /* ---- the money side ---- */
    const money: Array<string | false> = [];
    if (sendable) {
      const wl = weightLimitOf(dry.weight);
      const dl = depositLimitOf(dry.net, dry.max);
      const tx = api.tx.revive.call(dest, val, { refTime: wl.refTime, proofSize: wl.proofSize }, dl, input);
      const { fee, why } = await feeOf(tx, sender.holderSs58);
      const budget = budgetLines(network, { value: val, depositLimit: dl, fee, ed }, bal, sender.holderSs58);
      const dataArg = input.length <= 202 ? `'${input}'` : 'data';
      money.push(
        '',
        'To send it as the native call Revive.call(dest, value, weightLimit, storageDepositLimit, data)',
        network.key === 'mainnet' && '  This is the mainnet: POT has real value, and the amounts below are taken or held from it. Try the same call on the testnet first.',
        `- weight required: ${weightText(dry.weight)}. weightLimit to pass (+10%): ${weightText(wl)}`,
        `- storage deposit: net ${depositText(dry.net, network)}; the most held during the call: ${dry.max === null ? 'not reported by the node' : depositText(dry.max, network)}`,
        `- storageDepositLimit to pass (the larger of the two, +2%; it must cover the maximum even when the net is 0): ${nativeAmount(dl, network)}`,
        !contract && val > 0n && dry.net === ed && `  The ${nativeAmount(ed, network, false)} is the existential deposit of the account this transfer creates at that address (seen on Nov 14, 2026: the same transfer to an existing account holds no deposit).`,
        dry.weight.refTime === 0n && dl === 0n
          ? '  The node reports no weight and no deposit for this call, so both limits are 0. We have not sent a Revive.call with limits of 0 ourselves.'
          : dl === 0n && '  The call holds no deposit, so the limit is 0. We have not sent a Revive.call with a deposit limit of 0 ourselves.',
        fee === null ? `- fee: could not be estimated (${why}).` : `- fee (paymentInfo, with these limits): ${nativeAmount(fee, network)}`,
        ...budget.lines,
        `- in code (@polkadot/api): api.tx.revive.call('${dest}', ${val}n, ${weightCode(wl)}, ${dl}n, ${dataArg})`,
        `  Sign it with your own ${network.key === 'mainnet' ? 'key' : 'test key'} or wallet; these tools never sign. Limits read now can change with the state, so dry-run again right before sending.`,
      );
    }

    /* ---- reminders ---- */
    const notes = [
      '',
      'Good to know',
      '- Events a contract emits in a call sent this way (Revive.call, or any native extrinsic) are not served by eth_getLogs. They are only Revive.ContractEmitted events in the block; get_contract_events reads them.',
      '- A storage deposit is held, not spent: it stays locked while that storage exists. A later call that clears the storage gets it back (seen by the Bridge Zero team in October 2026); a dry run of such a call shows a refund.',
      '- Dry-run values were read live just now. The rules quoted with a date were measured by the Bridge Zero team on that date.',
    ];

    const next = network.evm
      ? 'Next: estimate_eth_transaction prices the same call as an Ethereum transaction (MetaMask, cast); explain_error explains an error text; get_contract_events reads events after it is sent.'
      : `Next: the ${network.label} has no public Ethereum RPC, so the native call above is the way to send it there; explain_error explains an error text.`;

    return lines(
      `Dry run of a contract call on the ${network.label}, made by the node just now (reviveApi.call). Nothing was sent and no key was used.`,
      '',
      ...result,
      '',
      ...theCall,
      ...sees,
      ...money,
      ...notes,
      '',
      next,
    );
  },
});
