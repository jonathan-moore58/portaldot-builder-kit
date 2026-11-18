// What the chain says about an address: which native account holds its balance, and whether it is
// a contract. Shared by every tool that takes an address.
import { toSs58, type ParsedAddress } from './address.ts';
import type { Conn } from './chain.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

export interface Holder {
  /** The native account linked to the address's 0x form (revive.originalAccount), as SS58, or null. */
  linked: string | null;
  /** The account id that really holds the balance. */
  holderId: Uint8Array;
  holderSs58: string;
}

/**
 * The native account that holds an address's balance.
 * For a native address that is the account itself. For a 0x address it is the native account linked
 * to it, or, when none is linked (an Ethereum key, a contract), its fallback account.
 */
export async function resolveHolder(conn: Conn, parsed: ParsedAddress): Promise<Holder> {
  const api = conn.api as Loose;
  const original = await api.query.revive.originalAccount(parsed.h160);
  const linked: string | null = original.isSome ? toSs58(original.unwrap().toU8a()) : null;
  const holderId: Uint8Array = parsed.kind === 'h160' && original.isSome ? original.unwrap().toU8a() : parsed.accountId;
  return { linked, holderId, holderSs58: toSs58(holderId) };
}

export interface ContractInfo {
  codeHash: string;
  /** "Evm" for EVM bytecode, "Pvm" for PolkaVM bytecode. */
  codeType: string;
  /** Size of the stored code in bytes. */
  codeLen: number;
  /** The account that uploaded the code and holds its deposit. */
  codeOwner: string;
  codeDeposit: bigint;
  /** How many contracts use this code. */
  codeRefcount: number;
  trieId: string;
  storageBytes: number;
  storageItems: number;
  storageByteDeposit: bigint;
  storageItemDeposit: bigint;
  storageBaseDeposit: bigint;
  immutableDataLen: number;
}

export interface ReviveAccount {
  /** Wei below one native base unit that pallet-revive keeps for the account (0 to 9999). */
  dust: number;
  contract: ContractInfo | null;
}

const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(v as string | number));

/** pallet-revive's own record of a 0x address: its dust, and its contract data if it is a contract. Null when it has no record. */
export async function readReviveAccount(conn: Conn, h160: string): Promise<ReviveAccount | null> {
  const api = conn.api as Loose;
  const info = await api.query.revive.accountInfoOf(h160);
  if (!info.isSome) return null;
  const json = info.toJSON() as Loose;
  const c = json?.accountType?.contract;
  if (!c?.codeHash) return { dust: Number(json?.dust ?? 0), contract: null };
  const code = await api.query.revive.codeInfoOf(c.codeHash);
  const ci = code.isSome ? (code.toJSON() as Loose) : {};
  return {
    dust: Number(json?.dust ?? 0),
    contract: {
      codeHash: String(c.codeHash),
      codeType: String(ci.codeType ?? 'unknown'),
      codeLen: Number(ci.codeLen ?? 0),
      codeOwner: String(ci.owner ?? ''),
      codeDeposit: big(ci.deposit),
      codeRefcount: Number(ci.refcount ?? 0),
      trieId: String(c.trieId ?? ''),
      storageBytes: Number(c.storageBytes ?? 0),
      storageItems: Number(c.storageItems ?? 0),
      storageByteDeposit: big(c.storageByteDeposit),
      storageItemDeposit: big(c.storageItemDeposit),
      storageBaseDeposit: big(c.storageBaseDeposit),
      immutableDataLen: Number(c.immutableDataLen ?? 0),
    },
  };
}

/** "EVM" or "PolkaVM", from the chain's code type. */
export const codeKind = (codeType: string): string => (codeType === 'Evm' ? 'EVM' : codeType === 'Pvm' ? 'PolkaVM' : codeType);

/* ---------- transactions that wait for a block ---------- */

// Measured on the testnet on Nov 15, 2026 with real sends, native and Ethereum:
// - while a transaction is taken and waits for its block, system_accountNextIndex of the account
//   that pays (for an Ethereum key, its fallback account) is its nonce + 1, and the node's
//   author_pendingExtrinsics holds the transaction;
// - eth_getTransactionCount with "pending" equals "latest" all the same: it does not count them;
// - a transaction signed with a nonce above the next one (a gap) is taken too, but the node holds it
//   apart: it is not in author_pendingExtrinsics and system_accountNextIndex does not count it,
//   until the missing nonce is sent.

export interface PoolNonce {
  /** System.Account.nonce now: how many transactions of the account are in blocks. */
  nonce: number;
  /** system_accountNextIndex: that nonce plus the account's transactions that wait, ready, in the node's pool. */
  next: number;
}

/**
 * The account's nonce and its next index, read live. The next index is read first: a transaction
 * that reaches a block between the two reads then counts as done, not as waiting.
 */
export async function readPoolNonce(conn: Conn, holderSs58: string): Promise<PoolNonce> {
  const api = conn.api as Loose;
  const next = Number((await api.rpc.system.accountNextIndex(holderSs58)).toString());
  const account = await api.query.system.account(holderSs58);
  return { nonce: Number(account.nonce.toString()), next };
}

/** How many of the account's transactions wait for a block, from the two numbers. */
export const waitingCount = (p: PoolNonce): number => Math.max(0, p.next - p.nonce);

/** One sentence: what the node's pool shows for this account, and what it cannot show. */
export function waitingText(p: PoolNonce): string {
  const n = waitingCount(p);
  if (n === 0) {
    return `nothing of this account is waiting for a block (system_accountNextIndex ${p.next} equals the nonce). A transaction signed with a later nonce, above ${p.next}, would not show here: the node holds such a transaction apart, unseen, until the missing nonce is sent.`;
  }
  return (
    `${n === 1 ? '1 transaction' : `${n} transactions`} of this account ${n === 1 ? 'is' : 'are'} waiting for ${n === 1 ? 'its' : 'their'} block: taken by the node, not in a block yet (system_accountNextIndex ${p.next}, nonce ${p.nonce}). ` +
    `A new transaction sent after ${n === 1 ? 'it' : 'them'} takes nonce ${p.next}. One signed with ${n === 1 ? `nonce ${p.nonce}` : `a nonce from ${p.nonce} to ${p.next - 1}`} competes with a waiting one: ` +
    'with the same fees it is refused with 1014 (Priority is too low), with a higher fee or tip it replaces it (measured on Nov 15, 2026).'
  );
}
