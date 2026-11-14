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
