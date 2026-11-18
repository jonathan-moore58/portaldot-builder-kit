import * as z from 'zod';
import { codeKind, readPoolNonce, readReviveAccount, resolveHolder, waitingCount, waitingText, type ContractInfo, type PoolNonce } from '../lib/accounts.ts';
import { checksummed, fallbackIdOfH160, parseAddress, specialAddress, SS58_PREFIX, toSs58 } from '../lib/address.ts';
import { ethRpc, getConn, hasEvmRpc, type Conn } from '../lib/chain.ts';
import { EthRpcError } from '../lib/errors.ts';
import { lines, nativeAmount, toHex, weiAmount } from '../lib/format.ts';
import { NATIVE_TO_WEI, PALLETS_ADDRESS, pickNetwork, type Network } from '../lib/networks.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const big = (v: Loose): bigint => BigInt(v.toString());
const sameId = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** "modlpy/trsry" for a module's own account (the text "modl" + its 8-byte id, then zeros), or null. */
function moduleAccountText(id: Uint8Array): string | null {
  const text = Buffer.from(id.subarray(0, 12)).toString('latin1');
  if (!text.startsWith('modl') || !id.subarray(12).every((b) => b === 0)) return null;
  return /^[\x20-\x7e]+$/.test(text.replace(/\0+$/, '')) ? text.replace(/\0+$/, '') : null;
}

/** An 8-byte id such as a lock's "vesting " as text, or as hex when it is not printable. */
function idText(codec: Loose): string {
  const bytes: Uint8Array = codec.toU8a();
  const t = Buffer.from(bytes).toString('latin1').replace(/[\0 ]+$/, '');
  return /^[\x20-\x7e]+$/.test(t) ? `"${t}"` : toHex(bytes);
}

/** {"Revive":"StorageDepositReserve"} as Revive.StorageDepositReserve. */
function reasonText(codec: Loose): string {
  const h = codec.toHuman();
  if (h && typeof h === 'object') {
    const [mod, inner] = Object.entries(h as Record<string, unknown>)[0] ?? [];
    if (mod) return typeof inner === 'string' ? `${mod}.${inner}` : `${mod}.${JSON.stringify(inner)}`;
  }
  return String(h);
}

interface Balances {
  exists: boolean;
  nonce: number;
  providers: number;
  consumers: number;
  sufficients: number;
  free: bigint;
  reserved: bigint;
  frozen: bigint;
}

function readBalances(acc: Loose): Balances {
  return {
    exists: acc.providers.toNumber() + acc.consumers.toNumber() + acc.sufficients.toNumber() > 0,
    nonce: acc.nonce.toNumber(),
    providers: acc.providers.toNumber(),
    consumers: acc.consumers.toNumber(),
    sufficients: acc.sufficients.toNumber(),
    free: big(acc.data.free),
    reserved: big(acc.data.reserved),
    frozen: big(acc.data.frozen),
  };
}

/**
 * The node's own figure for a 0x address's Ethereum-side balance: the runtime API ReviveApi_balance,
 * asked with state_call so it works whatever metadata the connection holds. The answer is a U256.
 */
async function nodeBalance(api: Loose, h160: string, blockHash: string): Promise<bigint | null> {
  try {
    const raw = await api.rpc.state.call('ReviveApi_balance', h160, blockHash);
    return api.createType('U256', raw.toU8a(true)).toBigInt();
  } catch {
    return null;
  }
}

/**
 * The part of free that cannot be spent: the larger of (frozen - reserved) and the existential deposit.
 * A freeze counts against free and reserved together, so reserved is taken off it first. Measured on
 * Nov 14, 2026 on 16 testnet and 3 mainnet accounts with reserved or frozen amounts; no account on
 * either network had both at once, so that case rests on the formula alone.
 */
function untouchableOf(b: Balances, ed: bigint): bigint {
  const frozenPart = b.frozen > b.reserved ? b.frozen - b.reserved : 0n;
  return frozenPart > ed ? frozenPart : ed;
}

/** What the Ethereum side should show: (free - untouchable) x 10000 + dust. */
function expectedWei(b: Balances, ed: bigint, dust: bigint): bigint {
  const untouchable = untouchableOf(b, ed);
  return (b.free > untouchable ? b.free - untouchable : 0n) * NATIVE_TO_WEI + dust;
}

async function reasonLines(at: Loose, id: Uint8Array, b: Balances, network: Network): Promise<string[]> {
  const [holds, reserves, freezes, locks] = await Promise.all([at.query.balances.holds(id), at.query.balances.reserves(id), at.query.balances.freezes(id), at.query.balances.locks(id)]);
  const out: string[] = [];
  let named = 0n;
  for (const h of holds) {
    named += big(h.amount);
    out.push(`- held for ${reasonText(h.id)}: ${nativeAmount(big(h.amount), network)}`);
  }
  for (const r of reserves) {
    named += big(r.amount);
    out.push(`- reserved under the name ${idText(r.id)}: ${nativeAmount(big(r.amount), network)}`);
  }
  if (b.reserved > named) {
    out.push(
      `- ${named ? 'the rest of the reserved amount, ' : ''}${nativeAmount(b.reserved - named, network)}${named ? ',' : ''} has no named record. Deposits taken the older way, for example by the Assets module (asset and metadata deposits) and by Identity, are not named in balances.holds or balances.reserves (seen on the testnet on Nov 14, 2026); the deposit field of that module's own record shows them.`,
    );
  }
  for (const f of freezes) out.push(`- frozen for ${reasonText(f.id)}: ${nativeAmount(big(f.amount), network)}`);
  for (const l of locks) out.push(`- locked as ${idText(l.id)} (reasons ${l.reasons.toString()}): ${nativeAmount(big(l.amount), network)}`);
  if (b.frozen > 0n && !freezes.length && !locks.length) out.push('- frozen, but no freeze or lock names a reason.');
  return out;
}

function contractLines(c: ContractInfo, network: Network, holderSs58: string, storageHold: bigint | null): string[] {
  const storageTotal = c.storageByteDeposit + c.storageItemDeposit + c.storageBaseDeposit;
  return [
    '',
    'Contract (revive.accountInfoOf and revive.codeInfoOf):',
    `- code: ${codeKind(c.codeType)}, ${c.codeLen} bytes, code hash ${c.codeHash}`,
    `- contracts that use this code: ${c.codeRefcount}`,
    `- storage: ${c.storageBytes} bytes in ${c.storageItems} item${c.storageItems === 1 ? '' : 's'}${c.immutableDataLen ? `; immutable data ${c.immutableDataLen} bytes` : ''}; trie id ${c.trieId}`,
    `- storage byte deposit: ${nativeAmount(c.storageByteDeposit, network)}`,
    `- storage item deposit: ${nativeAmount(c.storageItemDeposit, network)}`,
    `- storage base deposit: ${nativeAmount(c.storageBaseDeposit, network)}`,
    `- the three together: ${nativeAmount(storageTotal, network)}, held on the contract's own account ${holderSs58}${storageHold === null ? '' : storageHold === storageTotal ? ' (its Revive.StorageDepositReserve hold is exactly this)' : ` (its Revive.StorageDepositReserve hold is ${nativeAmount(storageHold, network)}, which differs)`}`,
    `- code deposit: ${nativeAmount(c.codeDeposit, network)}, paid by ${c.codeOwner || 'an unknown account'} when the code was uploaded. Code deposits are held on the Revive module's own account (5EYCAe5ijiYfhaAUBd6H9WGRTsvwFFc7GnhQkiHvBYxdvpbV, "modlpy/reviv"), not on the payer's: on the testnet on Nov 14, 2026 its Revive.CodeUploadDepositReserve hold equalled the sum of all code deposits.`,
    `- A storage slot's deposit is returned when the slot is cleared (measured on the testnet, Oct 19-20, 2026). When the base deposit and the code deposit come back was not measured.`,
  ];
}

export default defineTool({
  name: 'get_account',
  title: 'Portaldot V3: one account in full, both address forms',
  description:
    'Everything about one Portaldot V3 account in one call, read live: what it is (a native account, a 0x address of an Ethereum key, or a contract with its EVM or PolkaVM code), both address forms, ' +
    'whether it exists, its nonce (one nonce for both sides) and whether a transaction of it is waiting in the node\'s pool for a block (system_accountNextIndex; on this chain eth_getTransactionCount "pending" does not show that), the native balance (free, reserved, frozen, in tokens and base units), the Ethereum-side balance in wei that MetaMask and eth_getBalance show, the dust, ' +
    'what holds any reserved or frozen amount, and for a contract its code size, code hash and storage and code deposits. ' +
    'Use it to check a balance or nonce before or after a transaction, to see whether an earlier transaction still waits before sending the next one, to see why MetaMask shows less than the native wallet, or to inspect a contract. Works on both networks. It shows the native token only: an Assets token balance is read_storage {"item": "Assets.account", "keys": [<asset id>, "5..."]}, and an ERC-20 balance is simulate_contract_call with balanceOf. ' +
    'Example: {"address": "5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z"}.',
  input: {
    address: z.string().min(1).describe('The address in any form: SS58 (starts with 5, for example "5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z"), a 0x address of 40 hex characters, or a 0x account id of 64 hex characters. Public addresses only, never a key or a secret phrase.'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ address, network: key }) => {
    const network = pickNetwork(key);
    const parsed = parseAddress(address);
    const conn = await getConn(network.key);
    const api = conn.api as Loose;
    const token = network.token;

    // Every read below is made at one block, so the numbers fit together.
    const header = await api.rpc.chain.getHeader();
    const blockNumber: number = header.number.toNumber();
    const blockHash: string = header.hash.toHex();
    const at = await api.at(blockHash);
    const pinned = { ...conn, api: at } as Loose as Conn;

    const [holder, revive] = await Promise.all([resolveHolder(pinned, parsed), readReviveAccount(pinned, parsed.h160)]);
    const ed = big(at.consts.balances.existentialDeposit);
    const h160 = checksummed(parsed.h160);
    const isEthForm = parsed.kind === 'h160' || parsed.isFallbackForm;
    const contract = revive?.contract ?? null;
    const dust = BigInt(revive?.dust ?? 0);

    // The account the 0x form's balance lives on: the linked native account, else the fallback account.
    const ethHolderId = holder.linked ? parseAddress(holder.linked).accountId : fallbackIdOfH160(parsed.h160);
    const ethElsewhere = !sameId(ethHolderId, holder.holderId);

    // Waiting transactions are read live, not at the block above: the node's pool has no past. A
    // contract sends no transactions, so it is not asked.
    const [acc, ethAcc, nodeWei, pool] = await Promise.all([
      at.query.system.account(holder.holderId),
      ethElsewhere ? at.query.system.account(ethHolderId) : null,
      nodeBalance(api, parsed.h160, blockHash),
      contract ? null : readPoolNonce(conn, holder.holderSs58).catch((): PoolNonce | null => null),
    ]);
    const b = readBalances(acc);
    const ethB = ethAcc ? readBalances(ethAcc) : b;

    // The Ethereum RPC, testnet only. Asked at the same block number; it may not know the newest block yet.
    let ethLines: string[] = [];
    if (hasEvmRpc(network)) {
      // Each request is tried twice; once the RPC gives no usable answer, the rest are not asked.
      let down = false;
      const ask = async (method: string, params: unknown[]): Promise<string | null> => {
        if (down) return null;
        let v: unknown;
        try {
          v = await ethRpc<string>(network, method, params, { tries: 2, timeoutMs: 8_000 });
        } catch (err) {
          if (err instanceof EthRpcError) throw err;
          down = true;
          return null;
        }
        // An answer that is not a 0x number is not used: it counts as no answer.
        return /^0x[0-9a-fA-F]{1,64}$/.test(String(v)) ? (v as string) : null;
      };
      let tag = `0x${blockNumber.toString(16)}`;
      let balance: bigint | null = null;
      let balanceNote = '';
      try {
        const v = await ask('eth_getBalance', [parsed.h160, tag]);
        balance = v === null ? null : BigInt(v);
      } catch {
        // The Ethereum RPC can be a block behind the node; ask for its latest block instead.
        tag = 'latest';
        const v = await ask('eth_getBalance', [parsed.h160, 'latest']).catch(() => null);
        balance = v === null ? null : BigInt(v);
        balanceNote = ` (asked at its latest block, because it did not know block ${blockNumber} yet)`;
      }
      const settle = (p: Promise<string | null>): Promise<PromiseSettledResult<string>> =>
        p.then((value) => (value === null ? { status: 'rejected' as const, reason: null } : { status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason }));
      const [latest, pending] = await Promise.all([settle(ask('eth_getTransactionCount', [parsed.h160, 'latest'])), settle(ask('eth_getTransactionCount', [parsed.h160, 'pending']))]);
      ethLines = [
        balance === null
          ? '- eth_getBalance: the Ethereum RPC did not answer just now.'
          : nodeWei === null
            ? `- eth_getBalance${balanceNote}: ${weiAmount(balance, network)}`
            : balance === nodeWei
              ? `- eth_getBalance at block ${blockNumber}${balanceNote}: the same, ${balance} wei.`
              : `- eth_getBalance${balanceNote}: ${weiAmount(balance, network)}. It differs from the node's figure by ${balance - nodeWei} wei${tag === 'latest' ? ', probably because the two were read at different blocks' : ''}.`,
      ];
      if (latest.status === 'fulfilled' && pending.status === 'fulfilled') {
        const l = Number(BigInt(latest.value));
        const p = Number(BigInt(pending.value));
        // Measured on Nov 15, 2026: "pending" stayed equal to "latest" while a transaction waited for its block.
        // A contract sends no transactions, so nothing of it can wait: no note.
        const pendingNote = contract
          ? ''
          : p === l
            ? ' On this chain "pending" equals "latest" even while a transaction waits for its block (measured on Nov 15, 2026), so this count cannot show waiting transactions: the "waiting for a block" line above can. Do not take the next nonce from "pending" while a transaction may be waiting.'
            : p > l
              ? ` "pending" is ${p - l} above "latest": this RPC now counts waiting transactions, which it did not on Nov 15, 2026.`
              : ' "pending" is below "latest": the two were probably read at different blocks.';
        ethLines.push(`- eth_getTransactionCount of ${h160}: latest ${l}, pending ${p}.${pendingNote}${l !== ethB.nonce ? ` (The native nonce read at block ${blockNumber} is ${ethB.nonce}; the two were read a moment apart.)` : ''}`);
      } else {
        ethLines.push('- eth_getTransactionCount: the Ethereum RPC did not answer just now.');
      }
    } else {
      ethLines = [`- The ${network.label} has no public Ethereum RPC (checked Nov 13, 2026), so eth_getBalance and eth_getTransactionCount cannot be asked. The figure above comes from the node itself.`];
    }

    const reasons = b.reserved > 0n || b.frozen > 0n ? await reasonLines(at, holder.holderId, b, network) : [];
    let storageHold: bigint | null = null;
    if (contract) {
      const holds = await at.query.balances.holds(holder.holderId);
      storageHold = 0n;
      for (const h of holds) if (reasonText(h.id) === 'Revive.StorageDepositReserve') storageHold += big(h.amount);
    }

    /* ---------- what it is ---------- */
    const nativeForm = holder.holderSs58;
    const moduleText = moduleAccountText(holder.holderId);
    let what: string;
    if (contract) {
      what = `a contract: ${codeKind(contract.codeType)} code, ${contract.codeLen} bytes. No key controls it; call it at its 0x address. Its native form is its fallback account (the 20 bytes followed by twelve 0xEE bytes), which holds its ${token} and its storage deposit.`;
    } else if (isEthForm && holder.linked) {
      what = `the 0x form of the native account ${holder.linked}, derived from it (the last 20 bytes of keccak-256 of its account id). Nobody holds an Ethereum key for this 0x address (it is a hash), so it cannot sign Ethereum transactions; the native account signs native calls instead.`;
    } else if (isEthForm && parsed.h160 === PALLETS_ADDRESS) {
      what =
        'the pallets address, the text "modlpy/paddr" padded with zeros. No key controls it and it holds nothing of its own: ' +
        'a 0x account sends an Ethereum transaction to it, with the bytes of a native call (from encode_call) as data and value 0, to run that native call.';
    } else if (isEthForm && specialAddress(parsed.h160)) {
      what = `a 0x address with no code that is not an ordinary account. ${specialAddress(parsed.h160)?.text ?? ''} Whatever ${token} it shows sits on its fallback account, the 20 bytes followed by twelve 0xEE bytes.`;
    } else if (isEthForm) {
      what =
        'a 0x address with no linked native account and no code. That is an address controlled by an Ethereum key (MetaMask), or one not used yet: the chain cannot tell these apart. ' +
        `It may also be the 0x form of a native account that does not exist yet. Its ${token} sits on its fallback account, the 20 bytes followed by twelve 0xEE bytes.`;
    } else {
      what = `a native account${moduleText ? ` of a runtime module: its account id is the text "${moduleText}" padded with zeros, the form the runtime gives its modules' own accounts` : ''}.`;
    }

    const linkLine = isEthForm
      ? null
      : holder.linked === toSs58(parsed.accountId)
        ? `- linked: revive.originalAccount(${h160}) names this account, so ${token} sent to the 0x form arrives here.`
        : holder.linked
          ? `- WARNING: revive.originalAccount(${h160}) names another account, ${holder.linked}.`
          : `- NOT linked to its 0x form${b.exists ? '' : ', because the account does not exist yet (accounts are linked when they are created)'}. ${token} sent to ${h160} from the Ethereum side now lands on a fallback account that no Ethereum key controls. convert_address explains which form to pay.`;

    /* ---------- the Ethereum side ---------- */
    const expected = expectedWei(ethB, ed, dust);
    const untouchable = untouchableOf(ethB, ed);
    const frozenRules = untouchable > ed;
    const frozenText = ethB.reserved > 0n && ethB.frozen > 0n ? 'frozen - reserved' : 'frozen';
    const ruleText = `(free - the larger of ${frozenText} and the 0.1 ${token} existential deposit) x 10000 + dust`;
    const ruleLine =
      nodeWei === null
        ? '- The node did not answer reviveApi.balance just now.'
        : nodeWei !== expected
          ? `- It differs from ${ruleText}, which is ${expected} wei here. The node's figure is the one the Ethereum side reports.`
          : ethB.free <= untouchable
            ? `- Nothing can be spent from the Ethereum side: free (${nativeAmount(ethB.free, network, false)}) is not more than ${frozenRules ? `the ${frozenText} amount` : `the 0.1 ${token} existential deposit`}, so the figure is ${dust ? 'only the dust' : '0'}. The rule is ${ruleText}.`
            : frozenRules
              ? `- That is (free - ${frozenText}) x 10000 + dust: ${frozenText === 'frozen' ? `frozen ${nativeAmount(ethB.frozen, network, false)}` : `${nativeAmount(untouchable, network, false)} (frozen less reserved, since a freeze counts against both)`} is more than the existential deposit, and the rest is what can be spent.`
              : `- That is (free - the 0.1 ${token} existential deposit) x 10000 + dust: what can be spent while the account stays alive. So MetaMask shows 0.1 ${token} less than free.`;

    const head = `${contract ? 'Contract' : 'Account'} ${isEthForm ? h160 : toSs58(parsed.accountId)} on the ${network.label}, read live at block ${blockNumber} (${blockHash}), the newest block when asked.`;

    return lines(
      head,
      parsed.kind === 'accountId' &&
        'Note: a 0x value of 64 hex characters is read here as a public account id. If what you pasted is a private key, treat it as exposed and move its funds: these tools never need a key.',
      parsed.checksumWarning && `WARNING: ${parsed.checksumWarning}`,
      parsed.ss58Prefix !== undefined && parsed.ss58Prefix !== SS58_PREFIX &&
        `Note: "${parsed.input}" is written with SS58 prefix ${parsed.ss58Prefix}, another network's format. It is the same account id; Portaldot writes it with prefix ${SS58_PREFIX} as ${toSs58(parsed.accountId)}.`,
      '',
      `What it is: ${what}`,
      `- native form (wallets, explorers, native calls):  ${nativeForm}${isEthForm && !holder.linked ? '  <- its fallback account' : ''}`,
      `- 0x form (Solidity, MetaMask, Ethereum RPC):      ${h160}`,
      `- account id of the native form:                   ${toHex(holder.holderId)}`,
      linkLine,
      '',
      `Native side (System.account of ${nativeForm}, 14 decimals):`,
      b.exists
        ? `- exists: yes (providers ${b.providers}, consumers ${b.consumers}, sufficients ${b.sufficients})`
        : `- exists: no. It holds no ${token}: it was never funded, or it was emptied and removed. Sending it at least the 0.1 ${token} existential deposit creates it.`,
      `- nonce: ${b.nonce}. One nonce serves both sides: native extrinsics and Ethereum transactions from this account take numbers from the same sequence.`,
      contract
        ? null
        : pool === null
          ? '- waiting for a block: the node did not answer system_accountNextIndex just now, so whether a transaction of this account is waiting is not known.'
          : `- waiting for a block (read just now): ${waitingText(pool)}${pool.nonce !== b.nonce ? ` (The nonce is ${pool.nonce} now; block ${blockNumber} showed ${b.nonce}. The two were read a moment apart.)` : ''}`,
      `- free:     ${nativeAmount(b.free, network)}`,
      `- reserved: ${nativeAmount(b.reserved, network)}`,
      `- frozen:   ${nativeAmount(b.frozen, network)}`,
      reasons.length ? ['', 'What holds the reserved and frozen amounts (balances.holds, reserves, freezes, locks):', ...reasons] : null,
      '',
      `Ethereum side (18 decimals: what MetaMask, eth_getBalance and contracts see) of ${h160}:`,
      ethElsewhere && !isEthForm
        ? `- Its 0x form is not linked to this account, so the Ethereum side reads another account: the fallback ${toSs58(ethHolderId)}${ethB.exists ? `, free ${nativeAmount(ethB.free, network, false)}` : ', which does not exist'}.`
        : null,
      nodeWei === null ? null : `- reviveApi.balance, the node's own figure: ${weiAmount(nodeWei, network)}`,
      ruleLine,
      dust ? `- dust: ${dust} wei (the dust field of revive.accountInfoOf): a remainder below one base unit that the Revive module keeps for this address. It is part of the figure above.` : null,
      ...ethLines,
      contract ? contractLines(contract, network, nativeForm, storageHold) : null,
      '',
      pool && waitingCount(pool) > 0 && 'get_transaction with the hash of a waiting transaction finds it in the node\'s pool and shows what it carries.',
      contract
        ? `Next: simulate_contract_call runs one of its functions without sending; read_storage reads its records, for example {"item": "Revive.codeInfoOf", "keys": ["${contract.codeHash}"]}; convert_amount turns an amount into the unit an API takes.`
        : `Next: convert_amount turns these amounts into the unit an API takes (base units for native calls, wei for the Ethereum side); read_storage reads this account's other records, for example its tokens with {"item": "Assets.account", "keys": [<asset id>, "${nativeForm}"]}.`,
    );
  },
});
