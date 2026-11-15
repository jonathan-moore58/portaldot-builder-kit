// The chain's own answer to a native call from a given sender, read without sending anything.
//
// An Ethereum-style dry run (eth_estimateGas) to the pallets address, with the bytes of a native call
// as its data, runs that call as the sender. The node answers with a gas figure, or with code -32000
// and "Failed to dispatch call: <the dispatch error>". We checked this on the testnet on Nov 15, 2026
// with 143 dry runs in 18 modules. From the 0x form of a native account that the chain links to it,
// the call ran as that native account itself. From a 0x address that no native account is linked to
// (an Ethereum key), it ran as that address's fallback account. The mainnet has no Ethereum RPC, so
// there the node's runtime API (ReviveApi eth_estimate_gas) is asked, as readEthSide does.
//
// Nothing here can sign or send.
import { findCallItem, reviveCall, type EthReading } from './calls.ts';
import { ethQuantity, ethRpc, type Conn } from './chain.ts';
import { EthRpcError, ToolError } from './errors.ts';
import { clip } from './format.ts';
import { fullName, type ChainIndex } from './meta.ts';
import { PALLETS_ADDRESS } from './networks.ts';
import { hideInvisible, messageText, redact, untrusted } from './text.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

export interface CallDryRun {
  /** 'rpc': eth_estimateGas on the Ethereum RPC; 'runtime': the node's runtime API. */
  path: 'rpc' | 'runtime';
  /** The gas figure, when the call ran without an error. */
  estimate: bigint | null;
  /** The JSON-RPC error code of a refusal (the Ethereum RPC only). */
  code: number | null;
  /** The node's message for a refusal, as it came. */
  message: string | null;
  /** Set when the network has an Ethereum RPC but it gave no usable answer, so the runtime API was asked. */
  fallbackReason?: string;
}

async function byRuntime(conn: Conn, from: string, data: string): Promise<CallDryRun> {
  // The same transaction shape as readEthSide's runtime path (calls.ts), with value 0.
  const tx = {
    from,
    to: PALLETS_ADDRESS,
    value: null,
    input: { input: data, data: null },
    accessList: null,
    authorizationList: [],
    blobVersionedHashes: [],
    blobs: [],
    chainId: null,
    gas: null,
    gasPrice: null,
    maxFeePerBlobGas: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    nonce: null,
    r_type: null,
  };
  const json = await reviveCall(conn, 'eth_estimate_gas', [tx, { timestampOverride: null, performBalanceChecks: null, stateOverrides: null }]);
  if (json && json.ok !== undefined && json.ok !== null) return { path: 'runtime', estimate: BigInt(json.ok), code: null, message: null };
  const err = json?.err;
  const message = typeof err?.message === 'string' ? err.message : JSON.stringify(err ?? json) ?? 'no answer';
  return { path: 'runtime', estimate: null, code: null, message };
}

/**
 * Dry-runs the call bytes from a 0x address through the pallets address: one eth_estimateGas where
 * there is an Ethereum RPC, the runtime API otherwise or when the RPC gives no usable answer.
 * Returns the reason as text when neither answers.
 */
export async function dryRunCall(conn: Conn, fromH160: string, callHex: string): Promise<CallDryRun | { unavailable: string }> {
  const reason = (err: unknown): string => messageText(err instanceof Error ? err.message : String(err), 240);
  if (conn.network.evm) {
    try {
      // One short try: the runtime API below gives the same answer, so a slow Ethereum RPC must not hold the whole answer for 40 s.
      const v = await ethRpc<string>(conn.network, 'eth_estimateGas', [{ from: fromH160, to: PALLETS_ADDRESS, data: callHex }], { tries: 1, timeoutMs: 8_000 });
      return { path: 'rpc', estimate: ethQuantity(v, 'eth_estimateGas'), code: null, message: null };
    } catch (err) {
      if (err instanceof EthRpcError) return { path: 'rpc', estimate: null, code: err.code, message: err.message };
      if (!(err instanceof ToolError)) return { unavailable: reason(err) };
      const rpcReason = err.message.split('. ')[0];
      try {
        return { ...(await byRuntime(conn, fromH160, callHex)), fallbackReason: rpcReason };
      } catch (err2) {
        return { unavailable: `${rpcReason}; the runtime API: ${reason(err2)}` };
      }
    }
  }
  try {
    return await byRuntime(conn, fromH160, callHex);
  } catch (err) {
    return { unavailable: reason(err) };
  }
}

/** The same answer, taken from a reading readEthSide already made (no new request). */
export const fromReading = (r: EthReading): CallDryRun => ({
  path: r.path,
  estimate: r.estimate,
  code: r.failure?.code ?? null,
  message: r.estimate === null ? (r.failure?.message ?? 'no answer') : null,
  ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}),
});

/* ---------- reading the reply ---------- */

export interface DispatchReply {
  /** The text after "Failed to dispatch call: ", or null when the reply is not a dispatch error. */
  error: string | null;
  /** A module error's index and error number, and the name the reply itself gives it. */
  module: { index: number; error: number; message: string | null } | null;
}

const DISPATCH = /^Failed to dispatch call: ([\s\S]+)$/;
// The Rust Debug form measured on Nov 15, 2026: Module(ModuleError { index: 39, error: [1, 0, 0, 0], message: Some("NoAccount") })
const MODULE = /^Module\(ModuleError \{ index: (\d{1,3}), error: \[(\d{1,3}), \d{1,3}, \d{1,3}, \d{1,3}\], message: (?:Some\("([A-Za-z0-9_]{1,80})"\)|None) \}\)$/;
// Token(FundsUnavailable), Arithmetic(Overflow), BadOrigin: shown as they come.
const PLAIN = /^[A-Za-z]{1,40}(\([A-Za-z0-9_]{1,60}\))?$/;

export function readDispatchReply(message: string): DispatchReply {
  const m = DISPATCH.exec(message.trim());
  if (!m) return { error: null, module: null };
  const error = m[1].trim();
  const mod = MODULE.exec(error);
  return { error, module: mod ? { index: Number(mod[1]), error: Number(mod[2]), message: mod[3] ?? null } : null };
}

/** "Assets.NoAccount (module 39, error 1): The account to alter does not exist.", named from the live metadata. */
export function moduleErrorText(index: ChainIndex, mod: NonNullable<DispatchReply['module']>): string {
  const item = index.modules.find((m) => m.index === mod.index)?.errors.find((e) => e.index === mod.error);
  if (!item) return `module ${mod.index}, error ${mod.error}${mod.message ? ` (the reply calls it ${mod.message})` : ''}, which runtime ${index.specVersion} has no name for`;
  const docs = clip(item.docs.join(' ').replace(/\s+/g, ' ').trim(), 300);
  const differs = mod.message !== null && mod.message !== item.name ? ` (the reply calls it ${mod.message})` : '';
  return `${fullName(item)} (module ${mod.index}, error ${mod.error})${differs}${docs ? `: ${docs}` : ''}`;
}

/** The verdict after "Dry run from this sender (...): ". */
export function verdictText(index: ChainIndex, run: CallDryRun): string {
  if (run.estimate !== null) return 'the chain accepts it.';
  const reply = readDispatchReply(run.message ?? '');
  if (reply.module) {
    const named = moduleErrorText(index, reply.module);
    return `the chain refuses it: ${named}${/[.!?]$/.test(named) ? '' : '.'}`;
  }
  if (reply.error !== null) return `the chain refuses it: ${PLAIN.test(reply.error) ? reply.error : untrusted(redact(reply.error), 300)}.`;
  return 'the node did not run the call (its reply is below).';
}

/** The reply once, as it came, in the form explain_error reads. */
export function replyText(run: CallDryRun): string {
  if (run.estimate !== null) return `a gas figure of ${run.estimate}, with no error`;
  const message = clip(redact(run.message ?? ''), 1000);
  if (run.path === 'rpc') return hideInvisible(JSON.stringify(run.code === null ? { message } : { code: run.code, message }));
  return `${untrusted(message, 1000)} (the runtime API's error message)`;
}

/* ---------- calls whose dry run says little ---------- */

// Calls that run another call and succeed whatever it does. true: measured by dry run on Nov 15, 2026.
const HIDES_INNER: Record<string, boolean> = {
  'Utility.batch': true,
  'Utility.forceBatch': true,
  'Proxy.proxy': true,
  'Sudo.sudo': true,
  'Sudo.sudoAs': true,
  'Utility.dispatchAs': false,
  'Proxy.proxyAnnounced': false,
  'Sudo.sudoUncheckedWeight': false,
};

const CALL_TYPE = /^(Box<)?Call>?$/;

/** The names of a call and of every call inside it ("Utility.batch", "Balances.forceSetBalance"). */
export function callNames(index: ChainIndex, call: Loose, depth = 0): string[] {
  const item = findCallItem(index, call);
  const out = [item ? fullName(item) : `${call.section}.${call.method}`];
  if (depth >= 6) return out;
  const args: Loose[] = [...(call.args ?? [])];
  args.forEach((codec, i) => {
    const type = item?.args[i]?.type ?? '';
    if (CALL_TYPE.test(type)) out.push(...callNames(index, codec, depth + 1));
    else if (type === 'Vec<Call>') for (const c of codec) out.push(...callNames(index, c, depth + 1));
  });
  return out;
}

const list = (names: string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The notes that go with a dry run of such calls. */
export function innerCallNotes(names: string[]): string[] {
  const out: string[] = [];
  const hiders = [...new Set(names.filter((n) => n in HIDES_INNER))];
  if (hiders.length) {
    const unmeasured = hiders.filter((n) => !HIDES_INNER[n]);
    const batch = hiders.includes('Utility.batch') || hiders.includes('Utility.forceBatch');
    out.push(
      `Note: ${list(hiders)} ${hiders.length === 1 ? 'runs' : 'run'} a call inside, and a dry run reports success for such a call even when the call inside fails ` +
        `(measured on Nov 15, 2026 for Utility.batch, Utility.forceBatch, Proxy.proxy, Sudo.sudo and Sudo.sudoAs${unmeasured.length ? `; expected for ${list(unmeasured)}, not measured` : ''}). ` +
        `So dry-run the inner call by itself, from the account it runs as${batch ? ', or use Utility.batchAll, whose dry run fails when a call inside fails' : ''}.` +
        (hiders.includes('Sudo.sudo') || hiders.includes('Sudo.sudoUncheckedWeight') ? ' A call that only root may make answers BadOrigin when it is dry-run by itself, so what it does under Sudo.sudo cannot be seen this way.' : ''),
    );
  }
  if (names.some((n) => n.startsWith('Multisig.'))) {
    out.push(
      'Note: in a dry run, the timepoint of a new multisig operation is {height: the best block, index: 0}. Approval bytes made with it answered AlreadyApproved at that block and WrongTimepoint at a later one (measured on Nov 15, 2026). ' +
        'Approve a real operation with the timepoint it got in its block.',
    );
  }
  return out;
}
