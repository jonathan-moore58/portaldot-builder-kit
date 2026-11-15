// explain_error: what an error text means on Portaldot V3, and what to do about it.
// Four sources, most specific first: module errors named from the chain's metadata; Solidity revert
// data; standard Substrate and JSON-RPC codes; and the entries of references/errors.md, matched by
// the patterns kept in this file. Only module errors need the chain. A text that holds none is
// answered without opening a connection, and when the node cannot be reached, module errors are
// named from the metadata saved with the tool.
import { gunzipSync } from 'node:zlib';
import { Metadata, TypeRegistry } from '@polkadot/types';
import * as z from 'zod';
import { ERROR_ENTRIES, type ErrorEntry } from '../generated/errors.ts';
import { SAVED_METADATA } from '../generated/metadata.ts';
import { checksummed } from '../lib/address.ts';
import { getConn } from '../lib/chain.ts';
import { ToolError } from '../lib/errors.ts';
import { CUSTOM_BY_SELECTOR, decodeRevert, readCustomArgs } from '../lib/evm.ts';
import { lines } from '../lib/format.ts';
import { getIndex, normName } from '../lib/meta.ts';
import { measuredFor } from '../lib/mistakes.ts';
import { pickNetwork, type Network, type NetworkKey } from '../lib/networks.ts';
import { holdsRecoveryPhrase } from '../lib/secrets.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** Shortens a text, marking the cut with plain ASCII. */
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** The longest text read. A pasted log can be long; the error is near the top. */
const MAX_INPUT = 20_000;
/** How long a module-error lookup waits for the node before it names the error from the saved metadata. */
const LIVE_WAIT_MS = 15_000;
/** The weight from which an entry is about the text, and is shown in full. Below it, an entry is only related. */
const FULL_SCORE = 6;

const SUBSTRATE = 'standard Substrate meaning, not measured by us on this chain';
const JSONRPC = 'standard JSON-RPC 2.0 meaning';
const MEASURED = 'measured on this chain on Nov 14, 2026';
const MEASURED_15 = 'measured on this chain on Nov 15, 2026';

/* ---------- 1. the entries of errors.md: patterns over the lower-cased text ---------- */

type Pat = [RegExp, number];

/** A numeric error code in a context that makes it a code: "code":1014, (code 1014), 1014: Priority..., error 1014. */
const code = (n: number): RegExp => new RegExp(`(?:\\bcode\\W{0,4}${n}\\b|\\berror\\W{1,3}${n}\\b|^\\W*${n}\\W*$|\\b${n}\\s*:{1,2}\\s*[a-z])`);
const either = (...res: RegExp[]): RegExp => new RegExp(res.map((r) => r.source).join('|'));

/**
 * The texts are compared in lower case, so the Ethereum RPC's own refusal {"code":-32000,"message":"Invalid transaction"}
 * (E35) and the pool's {"code":1010,"message":"Invalid Transaction"} (E1) are told apart by their codes.
 */
const RPC_OWN_INVALID = /^(?![\s\S]*\b1010\b)[\s\S]*(?:-32000\b[\s\S]{0,80}invalid transaction|invalid transaction[\s\S]{0,80}-32000\b)/;
/** "invalid transaction" in a text without the code -32000: the pool's refusal, or a text with no code at all. */
const POOL_INVALID = /^(?![\s\S]*-32000\b)[\s\S]*invalid transaction/;

/**
 * For every entry of errors.md, the texts that point to it, each with a weight: 10 for an exact error
 * text or name that only this entry explains, down to 3 for a loose hint. The best entry is the one
 * with the highest weight; further matches raise it a little.
 */
export const ENTRY_PATTERNS: Record<string, Pat[]> = {
  E1: [
    [/inability to pay some fees/, 10],
    [either(code(1010), /\b1010\b.{0,20}invalid transaction/), 9],
    [POOL_INVALID, 8],
    [/transaction call is not expected/, 7],
    [/refused: invalid (?:payment|call)\b|\{\s*"err"\s*:\s*\{\s*"invalid"\s*:/, 8],
    [/transaction has a bad signature|\bbad ?proof\b/, 9],
    [/ancient birth ?block|ancientbirthblock/, 9],
    [/insufficient funds for gas/, 8],
    [either(/temporarily banned/, code(1012)), 7],
    [/account balance too low/, 6],
  ],
  E2: [
    // a gas amount of 10^11 or more (11 to 19 digits; 20 digits is the u64 maximum a node prints as "no limit")
    [/gas.{0,40}?(?:\b\d{11,19}\b|\b0x[0-9a-f]{10,16}\b)|(?:\b\d{11,19}\b|\b0x[0-9a-f]{10,16}\b).{0,20}\bgas\b/, 6],
    [/review alert|metamask.{0,60}alert/, 7],
    [/(?:gas|estimate|fee).{0,40}(?:too (?:large|high|big)|huge|enormous|absurd|insane)/, 6],
    [/storage deposit.{0,40}\bgas\b|\bgas\b.{0,40}storage deposit/, 4],
  ],
  E3: [
    [/balanceconversionfailed|balance conversion failed/, 9],
    [/(?:off|wrong) by (?:a factor of )?10,?000|\b10,?000 ?(?:x|times)\b|\bx ?10,?000\b/, 7],
    [/nativetoethratio/, 6],
    [/parseether|parseunits/, 4],
    [/\b(?:14|18) decimals\b/, 4],
    [/\bdust\b/, 3],
  ],
  E4: [
    [/dispatchasfallbackaccount/, 9],
    [/fallback (?:account|address)|e{24}/, 6],
    [/originalaccount/, 5],
    [/(?:wrong|other) (?:form of (?:the |an )?)?address|wrong address form/, 6],
    [/h160.{0,60}(?:not the same|different|differs)/, 6],
    [/(?:funds?|tpot|tokens?|balance).{0,40}(?:never (?:arrived|showed?)|not (?:arrived|showing|received)|missing|disappeared|vanished)/, 5],
    [/(?:sent|send|paid|transferred).{0,60}(?:0x|metamask|5\.\.\.|ss58|native).{0,80}(?:never|not|didn't|did not) (?:arrive|arrived|show|showed|appear|appeared|receive|received)/, 7],
  ],
  E5: [
    [/state already discarded/, 10],
    [/\bhash not found\b/, 7],
    [/(?:state|block).{0,30}(?:pruned|discarded)/, 6],
    [/eth_getblockby(?:number|hash).{0,80}\bnull\b/, 6],
    [/unknown block/, 5],
    [/ethereum block not found/, 5],
  ],
  E6: [
    [/eth_getlogs.{0,80}(?:\[\]|empty|nothing|no logs|missing|not (?:return|show|serve))|(?:empty|no|missing) logs.{0,60}eth_getlogs/, 10],
    [/contractemitted/, 7],
    [/\blogs\W{0,4}:\s*\[\s*\]/, 6],
    [/(?:no|missing|empty) (?:logs|events)\b/, 6],
    [/eth_getlogs/, 5],
    [/gasused\W{0,4}(?:0x0|0)\b/, 4],
  ],
  E7: [
    [/storagedepositlimitexhausted|more storage was created than allowed/, 10],
    [/storagedepositnotenoughfunds|enough balance to pay the required storage deposits/, 10],
    [/storage ?deposit ?limit/, 7],
    [/maxstoragedeposit|storagedeposit\b/, 4],
  ],
  E8: [
    [/accountunmapped|account ?unmapped/, 10],
    [/automappingenabled/, 10],
    [/mapaccount|map_account/, 8],
    [/(?:account|address) (?:is )?not mapped/, 7],
  ],
  E9: [
    [/ethextrinsicrevert/, 9],
    [/contractreverted/, 9],
    [/extrinsicsuccess.{0,80}revert|revert.{0,80}extrinsicsuccess|reverted.{0,60}(?:shows?|says?|marked) (?:as )?success/, 7],
    [/"?status"?\W{0,4}0x0\b/, 6],
    [/"?bits"?\s*:\s*1\b/, 6],
    [/multisigexecuted/, 4],
  ],
  E10: [
    [/findmetaerror/, 7],
    [/\bindex["']?\s*[:=]\s*["']?\d{1,3}["']?\s*,\s*["']?error["']?\s*[:=]/, 6],
    [/\b(?:module|pallet)\W{1,4}\d{1,3}\W{1,6}error\W{1,4}\d{1,3}\b/, 6],
    [/^\W*\d{1,3}\s*[.:/]\s*\d{1,3}\W*$/, 6],
    [/\boutofgas\b/, 5],
    [/\bmodule(?:error)?\b\W{0,6}\{/, 4],
  ],
  E11: [
    [/unknown signed extensions?|treating them as no-effect/, 10],
    [/authorizecall|ethsetorigin/, 9],
    [/unable to (?:decode|create)|createtype\(|decod(?:e|ing) (?:error|failed)/, 5],
    [/signedextensions/, 5],
  ],
  E12: [
    [either(/priority is too low/, code(1014)), 10],
    [either(/(?:transaction )?already imported/, code(1013)), 10],
    [/nounsignedvalidator/, 8],
    [either(/unknown transaction validity/, code(1011)), 4],
    [/transaction is outdated|\boutdated\b/, 9],
    [/nonce too (?:low|high)|invalid nonce|nonce (?:mismatch|is wrong|already used)/, 9],
    [/will be valid in the future|not accepting future transactions/, 8],
    [/replacement transaction underpriced|\balready known\b/, 7],
    [/\bstale\b/, 6],
    [/\bnonce\b/, 4],
    [/(?:transaction|tx).{0,30}(?:stuck|pending|never confirms|double|twice)/, 4],
  ],
  E13: [
    [/feso-apps|testnetv3-(?:node|eth-rpc)/, 10],
    [/eth_chainid.{0,80}method not found|method not found.{0,80}eth_chainid/, 9],
    [/genesis.{0,40}(?:mismatch|differ|another|wrong|unexpected)|wrong (?:chain|network)|chain ?id.{0,30}(?:mismatch|wrong|differ|invalid)|invalid chain ?id/, 7],
    [/enotfound|getaddrinfo|non-existent domain|could not resolve host|name not resolved/, 6],
  ],
  E14: [
    [/(?:http|status|code|error)\W{0,8}(?:502|503|504|429)\b|\b(?:502|503|504|429)\s+(?:bad gateway|service unavailable|gateway time-?out|too many requests)/, 8],
    [/bad gateway|service unavailable|gateway time-?out|too many requests|rate.?limit/, 8],
    [either(code(1006), /abnormal closure|websocket.{0,40}(?:closed|disconnected|error)|disconnected from wss?:/), 8],
    [/no response received from rpc endpoint|websocket is not connected|could not reach the .{0,40}node|gave no usable answer|did not answer/, 8],
    [/timed? ?out|\betimedout\b|\beconnreset\b|\beconnrefused\b|socket hang up|fetch failed/, 6],
    [/(?:chain|block|head|node).{0,30}(?:stopped|halted?|not moving|stuck)|no new blocks/, 7],
  ],
  E15: [
    [/receipt.{0,40}(?:null|missing|not found|not available)|gettransactionreceipt.{0,80}null/, 9],
    [/gettransactionbyhash.{0,60}null/, 6],
    [/transaction (?:receipt )?not found/, 5],
  ],
  E16: [
    [/maxweighttoolow/, 10],
    [/signatoriesoutoforder/, 10],
    [/alreadyapproved|noapprovalsneeded|toofewsignatories|toomanysignatories|senderinsignatories|unexpectedtimepoint|wrongtimepoint|notimepoint|minimumthreshold/, 8],
    [/multisig|approveasmulti|asmulti/, 7],
    [/call ?hash.{0,40}(?:differ|mismatch|wrong)/, 5],
  ],
  E17: [
    [/expendability|would kill account/, 9],
    [/existential ?deposit|existentialdeposit/, 8],
    [/notexpendable|deadaccount|beneficiary account must pre-exist/, 8],
    [/belowminimum|below (?:the )?minimum/, 6],
    [/\breaped\b|account (?:was |is |got )?(?:removed|killed|deleted|reaped)|account (?:vanished|disappeared)/, 7],
    [/keep ?alive|transferallowdeath|transfer_allow_death/, 3],
    [/insufficientbalance|balance too low to send/, 5],
  ],
  E18: [
    [/faucet/, 7],
    [/(?:not enough|insufficient|no|out of) (?:tpot|funds|tokens?|balance).{0,60}deploy|deploy.{0,60}(?:not enough|insufficient|out of) (?:tpot|funds|tokens?|balance)/, 7],
    [/storagedepositnotenoughfunds/, 6],
    [/insufficient funds for gas/, 5],
  ],
  E19: [
    [/ca11bde05977b3631167028862be2a173976ca11|4e59b44847b379578588920ca78fbf26c0b4956c|000000000022d473030f116ddee9f6b43ac78ba3|0000000071727de22e5e9d8baf0edac6f37da032|914d7fec6aac8cd542e72bca78b30650d45643d7|ba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed/, 10],
    [/multicall3?\b|create2|createx|permit2|entry ?point|singleton factory|safe proxy/, 7],
    [/returned no data|could not decode result data|contractfunctionzerodataerror|bad_data|is not a contract|no contract code|addressemptycode/, 7],
    [/(?:chain|network).{0,30}(?:not supported|unsupported|not configured|unknown)|unsupported chain/, 4],
  ],
  E20: [
    [/(?:not found|cannot find|can't find|no results?).{0,40}explorer|explorer.{0,40}(?:not found|cannot find|can't find|no results?)/, 8],
    [/sourcify|forge verify|verify-contract|source verification|etherscan|blockscout/, 7],
    [/explorer/, 5],
  ],
  E21: [
    [/eth_simulatev1/, 10],
    [/state ?overrides?|stateoverride/, 8],
    [/ethtransactwithconfig/, 6],
  ],
  E22: [
    [/\beperm\b|\bebusy\b|\beacces\b/, 8],
    [/command line is too long|argument list too long|\be2big\b|filename or extension is too long/, 9],
    [/process\.exit/, 6],
    [/(?:wasm|webassembly).{0,40}abort|abort(?!ed due to trap).{0,40}(?:wasm|webassembly)/, 6],
    [/(?:\.env\b|eth_rpc_url|eth_from).{0,60}(?:foundry|forge|cast)|(?:foundry|forge|cast).{0,60}(?:\.env\b|eth_rpc_url|eth_from)/, 6],
  ],
  E23: [
    [/\/\/(?:alice|bob|charlie|dave|eve|ferdie)\b|\bferdie\b/, 8],
    [/(?:dev|development|well-known|test) (?:key|account|mnemonic|phrase)/, 4],
  ],
  E24: [
    [/scheduler.{0,80}badorigin|badorigin.{0,80}scheduler/, 9],
    [/prevrandao|block\.difficulty/, 8],
    [/historydepth|history depth|unclaimed (?:staking )?rewards?|\b84 eras\b/, 8],
    [/\bed25519\b|\bbls\b|staking precompile/, 6],
    [/portaldot wallet.{0,60}(?:cannot|can't|does not|doesn't|won't|unable to).{0,30}sign|sign.{0,60}portaldot wallet/, 6],
    [/\bscheduler\b/, 4],
  ],
  E25: [
    [/nfts.{0,60}nopermission|nopermission.{0,60}nfts/, 10],
    [/approveitemattributes/, 9],
    [/(?:setattribute|attribute).{0,60}\baccount\b.{0,30}namespace|attributenamespace/, 7],
    [/nopermission|no permission to do the operation/, 4],
  ],
  E26: [
    [/execution reverted/, 10],
    [/callexception|call_exception|contractfunctionrevertederror|contractfunctionexecutionerror|transaction reverted|call reverted/, 8],
    [/0x08c379a0|0x4e487b71/, 8],
    [/"code"\s*:\s*3\b|\(code 3\)/, 6],
    [/\breverts?\b|\breverted\b/, 5],
    // name(), symbol() or decimals() at the ERC-20 address of an asset without metadata
    [/metadata not found/, 9],
  ],
  E27: [
    [/invalid call:? payment/, 10],
    [/intrinsic gas too low|gas required exceeds allowance|gas limit (?:is )?too low/, 7],
    [/\bgas\b\W{0,8}(?:21000|0x5208)\b/, 5],
    [/\bout of gas\b/, 4],
  ],
  E28: [
    [/method not found|-32601\b/, 10],
    [/(?:rpc )?method .{0,40}(?:does not exist|is not available|not supported|unsupported)/, 7],
  ],
  E29: [
    [/failed to dispatch call/, 10],
    [/invalid call:? call\b/, 10],
    [/6d6f646c70792f70616464720000000000000000|pallets address/, 6],
  ],
  E30: [
    [/unknown variant\W{0,3}newheads|newheads.{0,80}(?:invalid params|not supported|unknown|refused)/, 10],
    [/newblockheaders/, 9],
    [/\bnewheads\b/, 8],
    [/eth_subscribe/, 7],
    [/newpendingtransactions/, 6],
  ],
  E31: [
    [/invalidinstruction|invalid instruction/, 10],
    [/unsupportedprecompileaddress|unsupported precompile/, 10],
    [/\b(?:blobhash|blobbasefee)\b|\bkzg\b|point evaluation|bls12-?381/, 7],
    [/failed to run contract/, 4],
  ],
  E32: [
    [/consumes more than the allowed weight|overweight_by/, 10],
    [/failed to run contract.{0,120}outofgas/, 8],
    [/(?:too many|batch of).{0,40}(?:staticcalls?|reads|calls).{0,60}(?:fail|weight|out of gas)/, 5],
  ],
  E33: [
    [/failed to filter logs/, 10],
    [/fromblock.{0,40}(?:after|greater than|later than|>|above).{0,20}toblock|toblock.{0,40}(?:beyond|after|past|above).{0,20}(?:the )?(?:head|latest)/, 7],
  ],
  E34: [
    [/could not decode `?opaqueextrinsic/, 10],
    [/client error: could not decode/, 10],
    [/extrinsic has invalid format/, 9],
    [/verification error: runtime error|execution aborted due to trap|wasm `?unreachable`? instruction executed/, 9],
    [/\b1002\W{1,4}verification error/, 8],
    // a code or the words alone also come in texts that are not about transaction bytes: related, not the answer
    [either(code(1040), code(1001), code(1002), /verification error/), 4],
    [/not enough data to decode vector/, 8],
    [/transaction_v1_broadcast|invalid operation id/, 5],
  ],
  E35: [
    [RPC_OWN_INVALID, 10],
    [/(?:legacy|type 0|pre-?eip-?155).{0,60}(?:without|no) (?:a )?chain ?id|(?:without|no) (?:a )?chain ?id.{0,60}(?:legacy|type 0)/, 6],
    [/eth_sendrawtransaction.{0,80}-32000|-32000.{0,80}eth_sendrawtransaction/, 4],
  ],
  E36: [
    [/no more params/, 10],
    [/hex string without 0x prefix/, 10],
    [/\boddlength\b|invalidhexcharacter|invalid hex character/, 9],
    [/invalid type: integer `?\d+`?, expected/, 8],
    [/expected block identifier following eip-1898|both \\?"data\\?" and \\?"input\\?" are set|cannot specify both blockhash and fromblock/, 8],
    [/invalid length \d+, expected a \(both 0x-prefixed or not\) hex string/, 7],
  ],
  E37: [
    [/ethereum block not found/, 10],
    [/account not found for address/, 10],
    [/eth_sendtransaction/, 4],
    [/eth_accounts\W{1,8}\[\s*\]/, 4],
  ],
};

export interface EntryMatch {
  entry: ErrorEntry;
  score: number;
}

/** Words that mark a line as part of an error, in a long text such as a whole tool answer or a log. */
const ERRORISH = /error|fail|refus|revert|invalid|insufficient|not enough|cannot|can't|could not|unable|denied|exceed|too (?:low|high|large|small)|timed? ?out|not found|unknown|banned|outdated|stale|priority|discarded|reject|panic|warn|\bnull\b|missing|\[\]|\b1\d{3}\b|-32\d{3}|0x08c379a0|0x4e487b71|disconnect|closure|enotfound|eperm|ebusy|eacces|alert/i;

/**
 * The part of a text worth matching against the entries. A short text is kept whole. Of a long one
 * (a log, or a whole answer of another tool) only the first line and the lines that look like an
 * error are kept, so that the explanations around an error do not decide which entry fits.
 */
export function focusText(text: string): string {
  const all = text.split(/\r?\n/);
  if (all.length <= 6) return text;
  return all.filter((l, i) => i === 0 || ERRORISH.test(l)).join('\n');
}

/** Every entry whose patterns match, best first. Ties go to the lower number (the more common error). */
export function matchEntries(text: string): EntryMatch[] {
  const low = text.toLowerCase();
  const out: EntryMatch[] = [];
  for (const entry of ERROR_ENTRIES) {
    const weights = (ENTRY_PATTERNS[entry.id] ?? []).filter(([re]) => re.test(low)).map(([, w]) => w).sort((a, b) => b - a);
    if (!weights.length) continue;
    out.push({ entry, score: weights[0] + 0.25 * Math.min(3, weights.length - 1) });
  }
  const num = (id: string): number => Number(id.slice(1));
  return out.sort((a, b) => b.score - a.score || num(a.entry.id) - num(b.entry.id));
}

/* ---------- 2. standard Substrate and JSON-RPC codes ---------- */

interface Standard {
  /** A short name the reader can search for, such as "1014" or "Token(FundsUnavailable)". */
  label: string;
  meaning: string;
  /** How we know: the standard meaning, or what we measured on this chain. */
  basis: string;
  re: RegExp;
}

const tokenRe = (name: string): RegExp => new RegExp(`\\btoken\\W{0,4}${name.toLowerCase()}\\b|\\b${name.toLowerCase()}\\b`);
/**
 * A variant written the way code prints it: Token(Frozen), Token::Frozen, {"token":"Frozen"}, Token: Frozen.
 * Plain words ("token frozen", "arithmetic underflow or overflow" in a Solidity panic) do not count.
 */
const VARIANT_NAMES = 'FundsUnavailable|OnlyProvider|BelowMinimum|CannotCreateHold|CannotCreate|UnknownAsset|Frozen|Unsupported|NotExpendable|Blocked|Underflow|Overflow|DivisionByZero|LimitReached|NoLayer';
/** The forms code prints: Token(Frozen), Token::Frozen, Token.Frozen, TokenError::Frozen, {"token":"Frozen"}, { token: 'Frozen' }, Token(TokenError::Frozen). */
const variantForm = (family: string, names: string): string => `\\b${family}(?:error)?["']?\\s*(?:\\(|::|\\.(?!\\s)|:)\\s*(?:${family}error::)?["']?(?:${names})\\b`;
const variantRe = (family: string, name: string): RegExp => new RegExp(variantForm(family, name.toLowerCase()));
const kindRe = (name: string): RegExp => new RegExp(`\\b${name.toLowerCase()}\\b`);
/** A one-word variant such as Exhausted counts only in an error context, not as an ordinary English word. */
const wordKindRe = (name: string, family: string): RegExp =>
  new RegExp(`${family}\\W{0,4}${name.toLowerCase()}\\b|dispatcherror\\W{0,4}${name.toLowerCase()}\\b|failed to dispatch call\\W{0,4}${name.toLowerCase()}\\b|\\{\\s*"${name.toLowerCase()}"\\s*:\\s*null\\s*\\}|^\\W*${name.toLowerCase()}\\W*$`);

export const STANDARD: Standard[] = [
  // the transaction pool (Substrate RPC author_submitExtrinsic, and the Ethereum RPC's eth_sendRawTransaction)
  { label: '1001 Extrinsic has invalid format', meaning: 'the node could not read the bytes as a transaction: their length does not fit them, for example bytes cut short or a raw Ethereum transaction sent to the Substrate node. author_submitAndWatchExtrinsic answers so; author_submitExtrinsic answers 1040 for the same kind of bytes. See E34', basis: MEASURED_15, re: either(code(1001), /extrinsic has invalid format/) },
  { label: '1002 Verification Error', meaning: 'the runtime could not check the transaction; the text after it gives the reason. With "Runtime error: ... wasm trap", the length fits but what it covers is not a transaction this runtime reads: empty, random bytes, hex text turned into bytes once more, no length prefix, extra bytes inside the length, or a version byte that is neither 0x84 (signed) nor 0x04 (unsigned): 0x83, 0x85, 0x45, 0x05 and 0xff were tried. See E34', basis: `${MEASURED_15} on both submit methods`, re: either(code(1002), /verification error/) },
  { label: '1010 Invalid Transaction', meaning: 'the transaction pool refused the transaction: it failed a validity check before it ran, so it used no nonce and paid no fee. On the Substrate RPC the reason follows the text; the Ethereum RPC gives none (recipe 2f reads it without sending).', basis: `${MEASURED} on both RPCs, see E1`, re: either(code(1010), POOL_INVALID) },
  { label: '1011 Unknown Transaction Validity', meaning: 'the node could not decide whether the transaction is valid, for example because it could not look up data it needs. With "NoUnsignedValidator": the call was sent unsigned, and the runtime has no check that takes it unsigned (an unsigned Balances.transferKeepAlive answered so). Sign it. See E12', basis: `${MEASURED_15} for "NoUnsignedValidator"; the other reasons: ${SUBSTRATE}`, re: either(code(1011), /unknown transaction validity/) },
  { label: '1012 Transaction is temporarily banned', meaning: 'the pool saw these exact bytes a moment ago (refused or already included) and refuses them again for a while. On this chain the same refused bytes sent again got it from 0.6 s to about 37 s later, the longest we waited, while nothing was pending; a resend within a second can get 1013 instead. Before you sign again, check whether the account\'s nonce has passed the transaction\'s: if it has, the transaction was included; do not send it again (E12).', basis: `${MEASURED} for a native extrinsic sent twice, and on Nov 15, 2026 for Ethereum transactions, see E1`, re: either(code(1012), /temporarily banned/) },
  { label: '1013 Transaction Already Imported', meaning: 'the pool already knows these exact bytes. On this chain it also came for refused bytes sent again within about 2 s, while nothing was pending, so it does not prove that a transaction is waiting: check the "pending" nonce or author_pendingExtrinsics before you wait. See E12', basis: `${MEASURED_15} for refused bytes sent again; for a transaction that is pending: ${SUBSTRATE}`, re: either(code(1013), /already imported/) },
  { label: '1014 Priority is too low', meaning: 'a transaction from the same account with the same nonce is already in the pool, and the new one does not pay enough more to replace it. Wait for the first one, or replace it with a higher tip.', basis: SUBSTRATE, re: either(code(1014), /priority is too low/) },
  { label: '1015 Cycle Detected', meaning: 'the transaction would depend on itself through the tags the pool orders transactions by. Rare; check the nonce.', basis: SUBSTRATE, re: either(code(1015), /cycle detected/) },
  { label: '1016 Immediately Dropped', meaning: 'the pool is full, so the transaction could not enter it. Try again later.', basis: SUBSTRATE, re: either(code(1016), /immediately dropped/) },
  { label: '1018 Unactionable', meaning: 'the transaction cannot be passed on to other nodes and this node does not make blocks, so it would never be included.', basis: SUBSTRATE, re: either(code(1018), /\bunactionable\b/) },
  { label: '1019 No tags provided', meaning: 'the transaction provides no tags, so the pool cannot identify it.', basis: SUBSTRATE, re: either(code(1019), /no tags provided/) },
  { label: '1020 Invalid block id', meaning: 'the block the transaction was to be checked against is not known to the node.', basis: SUBSTRATE, re: either(code(1020), /provided block id is not valid/) },
  { label: '1021 Future transaction refused', meaning: 'the pool does not take transactions that only become valid later (a nonce above the next one). Send the missing nonces first.', basis: SUBSTRATE, re: either(code(1021), /not accepting future transactions/) },
  { label: '1017', meaning: 'a transaction-pool code whose meaning we are not sure of. Read the text that came with it.', basis: SUBSTRATE, re: code(1017) },
  { label: '1040 Client error', meaning: 'an error of the node itself. With "Could not decode `OpaqueExtrinsic.0`": author_submitExtrinsic could not read the bytes as a transaction, because their length does not fit them (bytes cut short, a raw Ethereum transaction sent to the Substrate node, or hex with an odd number of digits). See E34', basis: MEASURED_15, re: either(code(1040), /client error: could not decode/) },

  // InvalidTransaction reasons: the text after "1010: Invalid Transaction:"
  { label: 'InvalidTransaction Payment', meaning: 'the account cannot pay the fee, or does not exist yet. Fund it (at least the fee plus the 0.1 existential deposit).', basis: `${MEASURED}: "Inability to pay some fees (e.g. account balance too low)"`, re: /inability to pay some fees|invalid(?:transaction)?\W{1,4}payment\b|\{\s*"?payment"?\s*:\s*null\s*\}/ },
  { label: 'InvalidTransaction BadProof', meaning: 'the signature does not check: the wrong key, a payload signed for another chain or runtime version, or a mortal transaction sent after its validity period.', basis: `${MEASURED}: "Transaction has a bad signature"`, re: /transaction has a bad signature|invalid(?:transaction)?\W{1,4}bad ?proof|\bbadproof\b/ },
  { label: 'InvalidTransaction Stale', meaning: 'the nonce was already used. Read the account nonce again and sign with the next one.', basis: `${SUBSTRATE} ("Transaction is outdated")`, re: /transaction is outdated|invalid(?:transaction)?\W{1,4}stale\b/ },
  { label: 'InvalidTransaction Future', meaning: 'the nonce is higher than the account\'s next nonce, so the transaction waits until the missing ones arrive.', basis: `${SUBSTRATE} ("Transaction will be valid in the future")`, re: /will be valid in the future|invalid(?:transaction)?\W{1,4}future\b/ },
  { label: 'InvalidTransaction AncientBirthBlock', meaning: 'a mortal transaction names a birth block older than the 2400 block hashes the chain keeps (System.blockHashCount, read on Nov 14, 2026). Sign it again against a recent block.', basis: `${MEASURED_15}: "Transaction has an ancient birth block", for a mortal transaction born 3000 blocks back, see E1`, re: /ancient birth ?block|ancientbirthblock/ },
  { label: 'InvalidTransaction ExhaustsResources', meaning: 'the transaction is too heavy or too large for a block, or the block is full. Try again, or split the work.', basis: `${SUBSTRATE} ("Transaction would exhaust the block limits")`, re: /would exhaust the block limits|exhaustsresources/ },
  { label: 'InvalidTransaction Call', meaning: 'the call is not allowed in this transaction, for example an ordinary call sent unsigned. Behind a bare 1010 from the Ethereum RPC, it is the node\'s reason for a transaction signed for another chain id, a blob (type 3) or a set-code (type 4) transaction.', basis: `${MEASURED_15}: "Transaction call is not expected" for an unsigned System.remark, and the node's check of those Ethereum transactions, see E1`, re: /transaction call is not expected|invalidtransaction\W{1,4}call\b|invalid(?:"\s*:\s*"|\s+)call\b(?!\s*:)/ },
  { label: 'InvalidTransaction BadSigner', meaning: 'the signer is not allowed to send this transaction.', basis: `${SUBSTRATE} ("Invalid signing address")`, re: /invalid signing address|\bbadsigner\b/ },
  { label: 'InvalidTransaction Custom', meaning: 'a check specific to this chain refused it; the number after Custom says which. We do not know the meaning of this chain\'s custom codes.', basis: `${SUBSTRATE} ("InvalidTransaction custom error")`, re: /invalidtransaction custom error|invalid(?:transaction)?\W{1,4}custom\b/ },
  { label: 'InvalidTransaction BadMandatory or MandatoryValidation', meaning: 'an internal check on the calls the block author adds itself. An ordinary transaction does not meet it.', basis: SUBSTRATE, re: /labelled as mandatory|dispatch is mandatory|badmandatory|mandatoryvalidation/ },
  { label: 'UnknownTransaction', meaning: 'the node could not look up what it needs to check the transaction, or no check exists for an unsigned one.', basis: SUBSTRATE, re: /could not lookup information required to validate|could not find an unsigned validator|unknowntransaction/ },

  // DispatchError: why a call that ran failed (in events, dry runs and "Failed to dispatch call: ...")
  { label: 'DispatchError BadOrigin', meaning: 'the call was made by an origin it does not accept: for example a signed account where the call needs root, or another account than the one allowed.', basis: `${MEASURED} and ${MEASURED_15.replace('measured on this chain on ', '')} by dry run through the pallets address, see E29`, re: /\bbad ?origin\b/ },
  { label: 'DispatchError CannotLookup', meaning: 'an account or other data the call names could not be found, for example an address the chain cannot look up.', basis: SUBSTRATE, re: kindRe('CannotLookup') },
  { label: 'DispatchError ConsumerRemaining', meaning: 'the account still has something that depends on it (a consumer reference), so it cannot be removed.', basis: SUBSTRATE, re: kindRe('ConsumerRemaining') },
  { label: 'DispatchError NoProviders', meaning: 'the account has nothing that keeps it alive (no provider reference), so it cannot be created this way. Give it a balance first.', basis: SUBSTRATE, re: kindRe('NoProviders') },
  { label: 'DispatchError TooManyConsumers', meaning: 'too many things depend on the account already.', basis: SUBSTRATE, re: kindRe('TooManyConsumers') },
  { label: 'DispatchError RootNotAllowed', meaning: 'the call does not accept the root origin.', basis: SUBSTRATE, re: kindRe('RootNotAllowed') },
  { label: 'DispatchError Exhausted', meaning: 'resources ran out, for example data too large to read or write.', basis: SUBSTRATE, re: wordKindRe('Exhausted', 'dispatcherror') },
  { label: 'DispatchError Corruption', meaning: 'the chain state is corrupt; this does not fix itself.', basis: SUBSTRATE, re: wordKindRe('Corruption', 'dispatcherror') },
  { label: 'DispatchError Unavailable', meaning: 'a resource (for example a preimage) is not available now; it may be later.', basis: SUBSTRATE, re: wordKindRe('Unavailable', 'dispatcherror') },
  { label: 'DispatchError Other', meaning: 'an error with only a text; read the text that came with it.', basis: SUBSTRATE, re: /dispatcherror\W{0,4}other\b|\{\s*"other"\s*:/ },
  { label: 'Token(FundsUnavailable)', meaning: 'the account does not have the funds the call wants to move or hold.', basis: `${MEASURED} and ${MEASURED_15.replace('measured on this chain on ', '')} by dry run through the pallets address, see E29`, re: tokenRe('FundsUnavailable') },
  { label: 'Token(OnlyProvider)', meaning: 'that part of the balance is what keeps the account alive, so it cannot be moved.', basis: SUBSTRATE, re: tokenRe('OnlyProvider') },
  { label: 'Token(BelowMinimum)', meaning: 'the account would hold less than the minimum, so it cannot exist with that amount. For tPOT the minimum is the 0.1 existential deposit; for an Assets token it is the minBalance of that asset (read_storage Assets.asset shows it), counted in the smallest unit of that token. Assets.mint below the minimum answers it before a missing issuer role.', basis: `${MEASURED_15} by dry run through the pallets address: 0.01 tPOT to a new account, and amounts of an Assets token below its minimum`, re: variantRe('token', 'BelowMinimum') },
  { label: 'Token(CannotCreate)', meaning: 'the call would create an account that cannot be created this way: measured for an Assets token that is not sufficient, sent to an account that holds no tPOT. Give the recipient at least the 0.1 tPOT existential deposit first: a Utility.batchAll of that payment and then the same asset transfer was accepted in a dry run.', basis: `${MEASURED_15} by dry run through the pallets address`, re: variantRe('token', 'CannotCreate') },
  { label: 'Token(UnknownAsset)', meaning: 'the asset is not known: check the asset id.', basis: SUBSTRATE, re: tokenRe('UnknownAsset') },
  { label: 'Token(Frozen)', meaning: 'the funds exist but are frozen.', basis: SUBSTRATE, re: variantRe('token', 'Frozen') },
  { label: 'Token(Unsupported)', meaning: 'the asset does not support this operation.', basis: SUBSTRATE, re: variantRe('token', 'Unsupported') },
  { label: 'Token(CannotCreateHold)', meaning: 'an account cannot be created only to hold a balance.', basis: SUBSTRATE, re: tokenRe('CannotCreateHold') },
  { label: 'Token(NotExpendable)', meaning: 'the withdrawal would take funds the account must keep, usually because it would go below the existential deposit (0.1 for tPOT) while the call keeps the account alive. Leave at least that much on it. From an account with no balance, a swap with keepAlive true answered it too (with keepAlive false, FundsUnavailable): there, fund the account.', basis: `${MEASURED_15} by dry run through the pallets address: Balances.transferKeepAlive, and AssetConversion.swapExactTokensForTokens from an empty account`, re: tokenRe('NotExpendable') },
  { label: 'Token(Blocked)', meaning: 'the account cannot receive this asset.', basis: SUBSTRATE, re: variantRe('token', 'Blocked') },
  { label: 'Arithmetic(Underflow)', meaning: 'a number would go below zero, for example a balance smaller than the amount taken from it.', basis: SUBSTRATE, re: variantRe('arithmetic', 'Underflow') },
  { label: 'Arithmetic(Overflow)', meaning: 'a number would go above its largest value.', basis: SUBSTRATE, re: variantRe('arithmetic', 'Overflow') },
  { label: 'Arithmetic(DivisionByZero)', meaning: 'a division by zero.', basis: SUBSTRATE, re: either(variantRe('arithmetic', 'DivisionByZero'), /\bdivisionbyzero\b/) },
  { label: 'Transactional(LimitReached or NoLayer)', meaning: 'too many nested storage layers, or a missing one. Usually too deep a nesting of calls.', basis: SUBSTRATE, re: either(variantRe('transactional', 'LimitReached'), variantRe('transactional', 'NoLayer')) },

  // JSON-RPC 2.0
  { label: 'JSON-RPC -32700 Parse error', meaning: 'the request body is not valid JSON.', basis: `${JSONRPC}; ${MEASURED} on the node and the Ethereum RPC`, re: /-32700\b|\bparse error\b/ },
  { label: 'JSON-RPC -32600 Invalid Request', meaning: 'the JSON is not a valid JSON-RPC request (for example no "jsonrpc": "2.0" or no method).', basis: JSONRPC, re: /-32600\b|\binvalid request\b/ },
  { label: 'JSON-RPC -32602 Invalid params', meaning: 'a parameter has the wrong form or count; the data field says which, for example "invalid length 4, expected ... 20 bytes" for a short address.', basis: `${JSONRPC}; ${MEASURED}`, re: /-32602\b|\binvalid params\b/ },
  { label: 'JSON-RPC -32603 Internal error', meaning: 'the server failed while handling the request. Try again; if it persists, the request may hit a fault in the node.', basis: JSONRPC, re: /-32603\b|\binternal error\b/ },
  { label: 'JSON-RPC -32000 Server error', meaning: 'a refusal defined by the node, explained by its message. On this chain\'s Ethereum RPC it carries, for example, "insufficient funds for gas * price + value", "Invalid call: Payment", "Failed to dispatch call: ...", "hash not found", "Ethereum block not found", "Account not found for address" and "Invalid transaction" (lower-case t, E35).', basis: `${JSONRPC}; the messages measured on this chain on Nov 14 and 15, 2026`, re: /-32000\b/ },

  // the texts of wrong parameters and of the Ethereum RPC's own refusals (E35 to E37)
  { label: 'Invalid params: No more params', meaning: 'a required parameter is missing: for example the block of eth_getBalance (it has no default), the boolean of eth_getBlockByNumber, or the extrinsic of author_submitExtrinsic. See E36', basis: `${MEASURED_15} on both RPCs`, re: /no more params/ },
  { label: 'Invalid params: bad hex (OddLength, InvalidHexCharacter)', meaning: 'the value is not hex of whole bytes: an odd number of hex digits, or a character that is not a hex digit. See E36', basis: `${MEASURED_15} on both RPCs`, re: /\boddlength\b|invalidhexcharacter|invalid hex character/ },
  { label: 'Invalid params: hex string without 0x prefix', meaning: 'a block parameter was read as a hex number: an unknown tag such as "newest", or a decimal number such as "100". Use latest, pending, safe, finalized, earliest or a 0x number. See E36', basis: MEASURED_15, re: /hex string without 0x prefix/ },
  { label: 'Invalid params: invalid type: integer', meaning: 'a JSON number where the RPC wants a hex string: for example eth_feeHistory\'s block count ("0x4", not 4) or a block number. See E36', basis: MEASURED_15, re: /invalid type: integer/ },
  { label: '-32000 Ethereum block not found', meaning: 'the Ethereum RPC does not know that block hash. Use the hash the Ethereum side gives (eth_getBlockByNumber, a receipt\'s blockHash) or the block number. See E37', basis: MEASURED_15, re: /ethereum block not found/ },
  { label: '-32000 Account not found for address', meaning: 'eth_sendTransaction asks the RPC to sign, and the RPC holds no keys (eth_accounts is []). Sign in the wallet or the script, and send with eth_sendRawTransaction. See E37', basis: MEASURED_15, re: /account not found for address/ },
  { label: '-32000 Invalid transaction (the Ethereum RPC\'s own refusal)', meaning: 'eth_sendRawTransaction could not decode the bytes as an Ethereum transaction it takes, so it refused them itself, and nothing reached the pool: malformed or cut-off bytes, a Substrate extrinsic, or a legacy transaction without a chain id. It is not the pool\'s 1010 "Invalid Transaction". See E35', basis: MEASURED_15, re: RPC_OWN_INVALID },
];

export function standardMatches(text: string): Standard[] {
  const low = text.toLowerCase();
  return STANDARD.filter((s) => s.re.test(low));
}

/* ---------- 3. revert data ---------- */

// The known custom errors (OpenZeppelin Contracts 5) and the reader of their arguments live in
// ../lib/evm.ts, so every tool that decodes a revert names them the same way.
export { CUSTOM_BY_SELECTOR };

/** One line on what revert data says. */
export function readRevert(data: string): string {
  const hex = data.trim().toLowerCase();
  const revert = decodeRevert(hex);
  const size = Math.max(0, (hex.length - 2) / 2);
  const shown = hex.length <= 160 ? hex : `${hex.slice(0, 160)}... (${size} bytes)`;
  let text = `${shown}: ${revert.text}`;
  if (revert.kind === 'custom' && (revert.selector === '0x08c379a0' || revert.selector === '0x4e487b71')) {
    const what = revert.selector === '0x08c379a0' ? 'Error(string), a revert with a message' : 'Panic(uint256), a Solidity panic';
    return `${shown}: it starts like ${what}, but the ${size} bytes are too few or malformed to read it. The data was probably cut off: paste the whole data field.`;
  }
  if (revert.kind === 'custom' && revert.selector) {
    const known = CUSTOM_BY_SELECTOR.get(revert.selector);
    if (known) {
      const args = readCustomArgs(known, hex.slice(10));
      text = `${shown}: a custom error. Its selector ${revert.selector} is that of ${known.signature} from ${known.from}${args ? `: ${args}` : ''}. Four bytes can match more than one signature, so confirm it with the contract's ABI.`;
    }
  }
  if (revert.kind === 'panic' && revert.panicCode === 0x11) text += ' In a token contract this often means a balance or an allowance smaller than the amount taken from it.';
  return text;
}

/** The revert data in a text: Error(string) and Panic(uint256) anywhere, and any data given as revert data. */
export function findReverts(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/0x(?:08c379a0|4e487b71)[0-9a-f]*/gi)) found.add(m[0].toLowerCase());
  const revertContext = /revert|"code"\s*:\s*3\b|\(code 3\)/i.test(text);
  if (revertContext) {
    for (const m of text.matchAll(/"data"\s*:\s*"(0x[0-9a-f]*)"/gi)) found.add(m[1].toLowerCase());
    for (const m of text.matchAll(/revert(?:ed)?(?: with)? data\W{0,4}(0x[0-9a-f]*)/gi)) found.add(m[1].toLowerCase());
  }
  return [...found];
}

/** What a text that is nothing but 0x hex probably is. */
function hexOnly(hex: string): string[] {
  const h = hex.toLowerCase();
  const bytes = (h.length - 2) / 2;
  if (!/^0x([0-9a-f]{2})*$/.test(h)) return [`${cut(h, 80)} is not whole bytes of hex (an odd number of hex digits). Check that nothing was cut off.`];
  if (bytes === 0) return ['0x is empty data. As revert data it means a revert without a reason; as the result of eth_call it means no return data, which is also what a call to an address with no code returns (E19).'];
  if (bytes === 20) return [`${checksummed(h)} is a 0x address, not an error. convert_address shows both of its forms; get_account shows what it holds and whether it is a contract.`];
  if (bytes === 32 && !/^0x(?:08c379a0|4e487b71)/.test(h)) return [`${h} is 32 bytes: a transaction or block hash, an account id or a storage value, not an error. get_transaction looks up a transaction by its hash (also an Ethereum 0x hash); get_block a block.`];
  return [`Read as revert data: ${readRevert(h)}`];
}

/* ---------- 4. module errors, named from the chain's metadata ---------- */

/** Every module error the text names by numbers. Pure: no metadata needed. */
export function findModulePairs(text: string): Array<{ module: number; error: number }> {
  const out: Array<{ module: number; error: number }> = [];
  const add = (m: string, e: number): void => {
    const module = Number(m);
    if (module <= 255 && e <= 255 && !out.some((p) => p.module === module && p.error === e)) out.push({ module, error: e });
  };
  const flat = text.replace(/\\"/g, '"');
  // {"index":6,"error":"0x02000000"}, { index: '6', error: '0x02000000' }, index: 80, error: [12, 0, 0, 0], "index": 6, "error": 2
  for (const m of flat.matchAll(/\bindex["']?\s*[:=]\s*["']?(\d{1,3})["']?\s*,\s*["']?error["']?\s*[:=]\s*(?:\[\s*(\d{1,3})[\d\s,]*\]|["']?0x([0-9a-fA-F]{2})[0-9a-fA-F]*["']?|["']?(\d{1,3})["']?(?![\dx]))/gi)) {
    add(m[1], m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number.parseInt(m[3], 16) : Number(m[4]));
  }
  // the other order: { error: '0x02000000', index: 6 }
  for (const m of flat.matchAll(/\berror["']?\s*[:=]\s*(?:\[\s*(\d{1,3})[\d\s,]*\]|["']?0x([0-9a-fA-F]{2})[0-9a-fA-F]*["']?)\s*,\s*["']?index["']?\s*[:=]\s*["']?(\d{1,3})\b/gi)) {
    add(m[3], m[1] !== undefined ? Number(m[1]) : Number.parseInt(m[2], 16));
  }
  // module 6 error 2, module 80, error 4 (as the dry-run tools print it), pallet 6 error 2
  for (const m of flat.matchAll(/\b(?:module|pallet)\s*(?:index\s*)?(?:[:#=]\s*)?(\d{1,3})\s*(?:[,;]\s*)?(?:and\s+)?error\s*(?:index\s*)?(?:[:#=]\s*)?(\d{1,3})\b/gi)) add(m[1], Number(m[2]));
  // the whole text is "6.2" or "80:24"
  const bare = /^\s*(\d{1,3})\s*[.:/]\s*(\d{1,3})\s*$/.exec(flat);
  if (bare) add(bare[1], Number(bare[2]));
  return out;
}

// Used only with matchAll, which copies the expression, so the shared lastIndex never matters.
const CAMEL = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
const QUALIFIED = /\b([A-Za-z][A-Za-z0-9_]*)(?:\.|::)([A-Z][A-Za-z0-9]*)\b/g;

interface ErrInfo {
  module: string;
  moduleIndex: number;
  name: string;
  index: number;
  text: string;
}

interface ErrSource {
  /** How the names were read, for the reader. */
  how: string;
  specVersion: number;
  modules: Map<string, { name: string; index: number }>;
  byPair: Map<string, ErrInfo>;
  byName: Map<string, ErrInfo[]>;
}

function makeSource(how: string, specVersion: number, all: ErrInfo[], modules: Array<{ name: string; index: number }>): ErrSource {
  const byPair = new Map<string, ErrInfo>();
  const byName = new Map<string, ErrInfo[]>();
  for (const e of all) {
    byPair.set(`${e.moduleIndex}.${e.index}`, e);
    byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  }
  return { how, specVersion, modules: new Map(modules.map((m) => [normName(m.name), m])), byPair, byName };
}

const savedSources = new Map<NetworkKey, ErrSource | null>();

// The two transaction extensions @polkadot/api does not know, declared so that no warning is printed.
const V3_EXTENSIONS = { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } };

/** The error list of the metadata saved with the tool. Built once, without any connection (about 150 ms). */
function savedSource(network: Network): ErrSource | null {
  if (savedSources.has(network.key)) return savedSources.get(network.key) ?? null;
  let source: ErrSource | null = null;
  const saved = SAVED_METADATA[network.key];
  try {
    if (saved) {
      const registry = new TypeRegistry();
      const metadata = new Metadata(registry, `0x${gunzipSync(Buffer.from(saved.gzipBase64, 'base64')).toString('hex')}` as `0x${string}`);
      registry.setMetadata(metadata, undefined, V3_EXTENSIONS, true);
      const all: ErrInfo[] = [];
      const modules: Array<{ name: string; index: number }> = [];
      for (const p of metadata.asLatest.pallets as Loose[]) {
        const module = p.name.toString();
        const moduleIndex = p.index.toNumber();
        modules.push({ name: module, index: moduleIndex });
        if (p.errors.isNone) continue;
        const variants = (registry.lookup.getSiType(p.errors.unwrap().type) as Loose).def.asVariant.variants as Loose[];
        for (const v of variants) {
          const text = (v.docs as Loose[]).map((d) => d.toString().trim()).filter(Boolean).join(' ');
          all.push({ module, moduleIndex, name: v.name.toString(), index: v.index.toNumber(), text });
        }
      }
      source = makeSource(`the ${network.label} metadata saved with this tool (runtime ${saved.specVersion})`, saved.specVersion, all, modules);
    }
  } catch {
    source = null;
  }
  savedSources.set(network.key, source);
  return source;
}

/** The error list of the live chain, from the shared index (meta.ts). */
function liveSource(conn: Loose, network: Network): ErrSource {
  const index = getIndex(conn);
  const all: ErrInfo[] = index.modules.flatMap((m) =>
    m.errors.filter((e) => e.index !== null).map((e) => ({ module: m.name, moduleIndex: m.index, name: e.name, index: e.index as number, text: e.docs.join(' ').replace(/\s+/g, ' ').trim() })),
  );
  return makeSource(`the ${network.label}'s live metadata (runtime ${index.specVersion})`, index.specVersion, all, index.modules.map((m) => ({ name: m.name, index: m.index })));
}

/** Any variant of the dispatch error, in any of the forms above. Only the known variant names count, so Token(NoPermission) still names the module error. */
const VARIANT_FORM = new RegExp(variantForm('(?:token|arithmetic|transactional)', VARIANT_NAMES), 'gi');

/** The module-error names a text holds, checked against a source's error list. */
function findNames(text: string, source: ErrSource): Array<{ module?: string; error: string }> {
  const out: Array<{ module?: string; error: string }> = [];
  const seen = new Set<string>();
  const add = (module: string | undefined, error: string): void => {
    const key = `${module ?? ''}.${error}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ module, error });
    }
  };
  const flat = text.replace(/\\"/g, '"');
  for (const m of flat.matchAll(QUALIFIED)) {
    if (source.modules.has(normName(m[1])) && source.byName.has(m[2])) add(m[1], m[2]);
  }
  // Token(BelowMinimum) and Arithmetic(Overflow) are variants of the dispatch error itself, not a module's error of the same name
  const noVariants = flat.replace(VARIANT_FORM, ' ');
  for (const m of noVariants.matchAll(CAMEL)) if (source.byName.has(m[0])) add(undefined, m[0]);
  // a one-word name (Unknown, Frozen, Expendability) counts when it is the whole text, or the message of a ModuleError
  const whole = /^\W*([A-Z][A-Za-z0-9]*)\W*$/.exec(flat);
  if (whole && source.byName.has(whole[1])) add(undefined, whole[1]);
  for (const m of flat.matchAll(/message\W{0,3}some\W{0,3}"([A-Z][A-Za-z0-9]*)"/gi)) if (source.byName.has(m[1])) add(undefined, m[1]);
  // a bare name that also came with its module is shown once, with the module
  return out.filter((n) => n.module || !out.some((o) => o.module && o.error === n.error));
}

/** True when the text could hold a module-error name, judged offline with the saved error list. */
function mayNameModuleError(text: string, network: Network): boolean {
  // Most texts hold no word that could be an error name: answer those without building the saved list.
  if (![CAMEL, QUALIFIED, /^\W*[A-Z][A-Za-z0-9]*\W*$/, /message\W{0,3}some\W{0,3}"[A-Z]/i].some((re) => new RegExp(re.source, re.flags.replace('g', '')).test(text))) return false;
  const saved = savedSource(network);
  if (!saved) return new RegExp(CAMEL.source).test(text);
  return findNames(text, saved).length > 0;
}

interface Named {
  title: string;
  info: ErrInfo | null;
  note?: string;
  /** True for one of several modules' errors of the same name, given without a module. */
  ambiguous?: boolean;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What our list says about a named module error: the entries that mention it, and a short note when
 * one of them explains it in brackets, as E10 does for "`Revive.TransferFailed` (a value larger than the balance)".
 */
export function listNotes(module: string, name: string): { note: string | null; ids: string[] } {
  const full = `${module}.${name}`;
  const bracket = new RegExp(`\`(?:${escapeRe(module)}\\.)?${escapeRe(name)}\`\\s*\\(([^)]+)\\)`);
  const ids: string[] = [];
  let note: string | null = null;
  for (const e of ERROR_ENTRIES) {
    if (!e.body.includes(full) && !e.body.includes(`\`${name}\``)) continue;
    ids.push(e.id);
    const m = bracket.exec(e.body);
    const said = m?.[1].trim() ?? '';
    if (!note && said && !said.startsWith('"') && !/^module \d/.test(said) && !/^E\d+$/.test(said) && said.length <= 160) note = `${said} (${e.id})`;
  }
  return { note, ids };
}

function nameModuleErrors(text: string, pairs: Array<{ module: number; error: number }>, source: ErrSource): Named[] {
  const out: Named[] = [];
  const shown = new Set<ErrInfo>();
  for (const p of pairs) {
    const info = source.byPair.get(`${p.module}.${p.error}`) ?? null;
    if (info && shown.has(info)) continue;
    if (info) shown.add(info);
    const moduleKnown = [...source.modules.values()].find((m) => m.index === p.module);
    out.push({
      title: info ? `${info.module}.${info.name} (module ${p.module}, error ${p.error})` : `module ${p.module}, error ${p.error}`,
      info,
      note: info ? undefined : moduleKnown ? `The ${moduleKnown.name} module (index ${p.module}) has no error ${p.error} in runtime ${source.specVersion}. The error may come from another runtime version: name it with the metadata of its block (E10).` : `No module has index ${p.module} in runtime ${source.specVersion}. Check the numbers, or the network.`,
    });
  }
  for (const n of findNames(text, source)) {
    const candidates = (source.byName.get(n.error) ?? []).filter((e) => !n.module || normName(e.module) === normName(n.module));
    // A bare name that numbers in the same text already pin down, such as the message of a ModuleError, adds nothing.
    if (!n.module && candidates.some((c) => shown.has(c))) continue;
    for (const info of candidates) {
      if (shown.has(info)) continue;
      shown.add(info);
      out.push({ title: `${info.module}.${info.name} (module ${info.moduleIndex}, error ${info.index})`, info, ambiguous: candidates.length > 1 });
    }
  }
  return out;
}

/* ---------- safety ---------- */

function refuseSecrets(text: string): void {
  const refuse = (what: string): never => {
    throw new ToolError(`That text holds what looks like ${what}. Never paste a secret phrase or a private key into a tool: these tools are read-only and need only the error message. Remove it and ask again. If it is real, treat the account as exposed and move its funds.`);
  };
  // A phrase counts when it is the whole text, one of its lines, or a quoted part of it (see lib/secrets.ts).
  if (holdsRecoveryPhrase(text)) refuse('a secret recovery phrase');
  if (/(?:private|secret)[\s_-]*key\W{0,8}(?:0x)?[0-9a-f]{64}\b/i.test(text)) refuse('a private key');
  if (/^\s*[0-9a-fA-F]{64}\s*$/.test(text)) refuse('a private key (64 hex characters without 0x). A transaction or block hash is written with 0x in front: give it to get_transaction or get_block');
}

/* ---------- what to do next ---------- */

const NEXT: Record<string, string> = {
  E1: 'estimate_eth_transaction checks the balance rule of an Ethereum transaction before you sign; encode_call with "sender" checks a native one.',
  E2: 'estimate_eth_transaction turns the gas into tokens and gives the limits to use.',
  E3: 'convert_amount converts exactly between tokens, native base units and wei.',
  E4: 'convert_address shows both forms of an address and whether they are linked; get_account shows where the balance sits.',
  E5: 'read_storage with "at_block" reads old state through the node.',
  E6: 'get_contract_events reads a contract\'s events from both sides, including those eth_getLogs does not serve.',
  E7: 'simulate_contract_call or simulate_contract_deploy gives the deposit limit to pass and checks the balance.',
  E8: 'convert_address shows whether a native account is linked to its 0x form.',
  E9: 'get_transaction shows the receipt status and the EthExtrinsicRevert event of a transaction.',
  E10: 'describe_item with the error\'s Module.Name shows the chain\'s full text for it.',
  E12: 'get_account shows the nonce, and on the testnet whether a transaction is pending.',
  E13: 'get_chain_facts shows the live endpoints, genesis hashes and chain ids.',
  E14: 'get_chain_facts shows whether the chain is producing blocks.',
  E15: 'get_transaction reads the transaction from the node\'s side when the receipt is missing.',
  E16: 'encode_call builds the inner call; describe_item "Multisig.asMulti" shows the arguments.',
  E17: 'get_account shows the balance fields; convert_amount converts amounts.',
  E18: 'simulate_contract_deploy shows the deposit your code needs before you ask for tPOT.',
  E19: 'get_account shows whether an address holds code.',
  E20: 'get_transaction reads a transaction by its 0x hash; get_block reads a block.',
  E21: 'simulate_contract_call runs a call as a dry run through the node.',
  E25: 'describe_item "Nfts.approveItemAttributes" shows the arguments.',
  E26: 'simulate_contract_call runs the call as a dry run and decodes the revert.',
  E27: 'estimate_eth_transaction gives the gas limit and fees to use.',
  E28: 'get_chain_facts lists the endpoints and what each one serves.',
  E29: 'encode_call with "sender" dry-runs the call from that sender and names the chain\'s refusal, besides the fee and the balance.',
  E30: 'get_chain_facts lists the endpoints, the wss:// one of the Ethereum RPC included.',
  E31: 'simulate_contract_call runs the call as a dry run through the node; references/evm-checks.md lists the opcodes and precompiles that work.',
  E32: 'simulate_contract_call shows the weight a call needs.',
  E33: 'get_chain_facts shows the newest block; get_contract_events reads a contract\'s events block by block.',
  E34: 'encode_call builds the bytes of a call from the chain\'s own metadata and echoes what they decode to; E34\'s fix shows how to ask the runtime about extrinsic bytes before you send them (recipe 2f checks Ethereum transactions only).',
  E35: 'estimate_eth_transaction gives the fields of a type-2 transaction for chain id 420420777 to sign. Recipe 2f does not help here: the RPC refused the bytes before the node saw them, and the node\'s check answers Call for malformed bytes and Payment for a legacy transaction without a chain id.',
  E36: 'get_block reads a block by its number or by either of its hashes; convert_address turns a 5... address into its 0x form.',
  E37: 'get_block shows both hashes of a block (the node\'s and the Ethereum side\'s) and turns either into the block.',
};

const UNDERSTANDS = [
  'module errors as numbers or names: {"index":80,"error":"0x18000000"}, Module { index: 6, error: [2, 0, 0, 0] }, "module 6 error 2", "6.2", "Balances.InsufficientBalance" or "InsufficientBalance"',
  'Solidity revert data (0x08c379a0..., 0x4e487b71..., or a custom error)',
  'transaction codes 1001 to 1040 and their reasons, DispatchError kinds such as BadOrigin or Token(FundsUnavailable), and JSON-RPC codes such as -32000, -32601 and -32602 with their measured texts',
  `the error texts and symptoms of the Bridge Zero team's list of errors and traps (E1 to E${ERROR_ENTRIES.length}); give an id such as "E7" to read one entry, or "list" for all titles`,
];

/* ---------- the tool ---------- */

const entryLine = (e: ErrorEntry): string => `- ${e.id}. ${e.title}`;

function fullEntry(e: ErrorEntry): string[] {
  return [`${e.id}. ${e.title}`, ...e.body.split('\n')];
}

/** At most this many measured cases are shown under one named error. */
const MAX_SEEN = 4;
/** What E29 says in one line, when a "Failed to dispatch call" text names its error and the error comes first. */
const E29_SHORT = '- The node ran the native call as a dry run (through the pallets address) and the call failed with the error named above. Ask explain_error for "E29" to read the whole entry: how the route works and what the estimate does not check.';

/** "An amount that ..." reads "..., an amount that ...": a plain first word is lower-cased, a name such as Nfts.mint is not. */
const asClause = (s: string): string => s.trim().replace(/\.\s*$/, '').replace(/^([A-Z])([a-z]*)(?=[\s,])/, (_, a: string, b: string) => `${a.toLowerCase()}${b}`);
const asSentence = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** The cases of references/native-call-errors.md whose reply is this error, as lines to print under it. */
function seenLines(module: string, name: string): string[] {
  return measuredFor(module, name)
    .slice(0, MAX_SEEN)
    .map((c) => `  Seen in our testnet dry runs of Nov 15, 2026: ${c.call}, ${asClause(c.mistake)}. ${asSentence(c.fix)}`);
}

export default defineTool({
  name: 'explain_error',
  title: 'Portaldot V3: what an error means, and what to do',
  description:
    'Explains a Portaldot V3 error: paste any error text, code, JSON or revert data as it is (JSON as text or as an object). ' +
    'Names module errors such as {"index":80,"error":"0x18000000"}, "module 6 error 2" or "Balances.InsufficientBalance" from the chain\'s own metadata; ' +
    'decodes Solidity revert data (Error(string), Panic(uint256), common custom errors); explains transaction codes 1001 to 1040, DispatchError kinds and JSON-RPC codes; ' +
    `and matches the text against the Bridge Zero team's list of ${ERROR_ENTRIES.length} errors and traps measured on this chain (1010 Invalid Transaction, huge gas numbers, State already discarded, missing logs, storage deposit limits, nonces, 502 and 429, and more), with the cause and the fix. ` +
    'Use it whenever a transaction, dry run, RPC request or script fails. A text without a module error is answered without contacting the chain. ' +
    'Example: {"error": "1010: Invalid Transaction: Inability to pay some fees (e.g. account balance too low)"}.',
  input: {
    error: z
      .union([z.string().min(1), z.number(), z.record(z.string(), z.unknown()), z.array(z.unknown())], { error: 'Give the error as text (for example "1010: Invalid Transaction"), as a number such as 1010, or as the JSON object or array that was shown.' })
      .describe('The error exactly as it was shown: a message, a code, JSON, a log line or 0x revert data. Examples: "1014: Priority is too low", {"module":{"index":80,"error":"0x18000000"}}, "Revive.StorageDepositLimitExhausted", "0x08c379a0...". An entry id such as "E7" returns that entry; "list" returns all titles. Never include a private key or a secret phrase.'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ error, network: key }) => {
    const network = pickNetwork(key);
    let text = (typeof error === 'string' ? error : typeof error === 'number' ? String(error) : JSON.stringify(error)).trim();
    if (!text) throw new ToolError('The error text is empty. Paste the message, code or revert data exactly as it was shown.');
    const shortened = text.length > MAX_INPUT;
    if (shortened) text = text.slice(0, MAX_INPUT);
    refuseSecrets(text);

    // An entry by its id, or the list of all entries
    const byId = /^\s*E0*(\d{1,3})\s*\.?\s*$/i.exec(text);
    if (byId) {
      const entry = ERROR_ENTRIES.find((e) => e.id === `E${Number(byId[1])}`);
      if (!entry) throw new ToolError(`There is no entry E${byId[1]}: the list has E1 to E${ERROR_ENTRIES.length}. Ask for "list" to see their titles.`);
      return lines(`From the Bridge Zero team's list of errors and traps on Portaldot V3 (references/errors.md of the knowledge pack):`, '', ...fullEntry(entry), NEXT[entry.id] ? `\nNext: ${NEXT[entry.id]}` : null);
    }
    if (/^\s*(?:list|all|index|entries)\s*$/i.test(text)) {
      return lines(
        `The Bridge Zero team's list of errors and traps on Portaldot V3: ${ERROR_ENTRIES.length} entries (references/errors.md of the knowledge pack). E1 to E7 are met most often.`,
        ...ERROR_ENTRIES.map(entryLine),
        '',
        'Next: explain_error with an id such as "E7" returns that entry in full, or paste an error text to find the right one.',
      );
    }

    // 1. module errors: only these need the chain's metadata
    const pairs = findModulePairs(text);
    const wholeIdentifier = /^\W*[A-Za-z][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z][A-Za-z0-9_]*)?\W*$/.test(text);
    let named: Named[] = [];
    let source: ErrSource | null = null;
    let reachNote: string | null = null;
    const focused = focusText(text);
    const pureEntries = matchEntries(focused);
    const pureStandard = standardMatches(focused);
    const wantsChain = pairs.length > 0 || mayNameModuleError(text, network) || (wholeIdentifier && !pureEntries.length && !pureStandard.length);
    if (wantsChain) {
      try {
        const pending = getConn(network.key);
        pending.catch(() => undefined);
        const conn = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), LIVE_WAIT_MS).unref())]);
        if (!conn) throw new Error(`no answer within ${LIVE_WAIT_MS / 1000} s`);
        source = liveSource(conn, network);
      } catch (e) {
        source = savedSource(network);
        const why = e instanceof Error ? cut(e.message.replace(/\s+/g, ' '), 160) : String(e);
        reachNote = source
          ? `The ${network.label} node could not be reached (${why}), so module errors were named from ${source.how}. The live chain may have changed since.`
          : `The ${network.label} node could not be reached (${why}), and no saved metadata could be read, so module errors could not be named.`;
      }
      if (source) named = nameModuleErrors(text, pairs, source);
    }

    // the entries, matched again with the names found, so that "80.24" also finds E7
    // A name that several modules share, given without its module, says nothing about which entry applies.
    const nameText = named.map((n) => (n.info && !n.ambiguous ? `${n.info.module}.${n.info.name}` : '')).filter(Boolean).join(' ');
    const entries = nameText ? matchEntries(`${focused}\n${nameText}`) : pureEntries;
    const standard = nameText ? standardMatches(`${focused}\n${nameText}`) : pureStandard;
    /** Adds an entry as related, or raises one already found to at least this score. */
    const relate = (id: string, score: number): void => {
      const have = entries.find((m) => m.entry.id === id);
      const entry = ERROR_ENTRIES.find((e) => e.id === id);
      if (have) have.score = Math.max(have.score, score);
      else if (entry) entries.push({ entry, score });
    };
    const listNote = new Map<Named, string>();
    for (const n of named) {
      if (!n.info) continue;
      const { note, ids } = listNotes(n.info.module, n.info.name);
      if (note) listNote.set(n, note);
      for (const id of ids) relate(id, n.ambiguous ? 4 : 5);
    }
    // Once a module error is named, E10 (how to name one) is background, not the answer.
    const e10 = entries.find((m) => m.entry.id === 'E10');
    if (e10 && named.length && named.every((n) => n.info)) e10.score = Math.min(e10.score, FULL_SCORE - 1);

    // 2. revert data
    const reverts = findReverts(text);
    const hexAlone = /^\s*0x[0-9a-fA-F]*\s*$/.test(text) ? hexOnly(text.trim()) : [];
    const readAsRevert = reverts.length > 0 || hexAlone.some((h) => h.startsWith('Read as revert data'));
    if (readAsRevert) relate('E26', 5);
    entries.sort((a, b) => b.score - a.score || Number(a.entry.id.slice(1)) - Number(b.entry.id.slice(1)));

    const what: string[] = [];
    let seenAny = false;
    /** The measured cases go under their error; the first group also names the file they come from, once. */
    const addSeen = (to: string[], seen: string[]): void => {
      to.push(...seen);
      if (seen.length && !seenAny) to.push('  More measured cases, call by call (all by dry run; none confirmed by a sent transaction): references/native-call-errors.md of the knowledge pack.');
      if (seen.length) seenAny = true;
    };
    if (named.length) {
      what.push(`${named.length === 1 ? 'Module error' : 'Module errors'}, named from ${source?.how}:`);
      for (const n of named) {
        what.push(`- ${n.title}${n.info?.text ? `. The chain's text: "${cut(n.info.text, 400)}"` : n.info ? ". The chain's metadata has no text for it." : ''}`);
        addSeen(what, n.info ? seenLines(n.info.module, n.info.name) : []);
        if (listNote.has(n)) {
          const m = /^(.*) \((E\d+)\)$/.exec(listNote.get(n) ?? '');
          if (m) what.push(`  Our list (${m[2]}) gives the cause: ${m[1]}.`);
        }
        if (n.note) what.push(`  ${n.note}`);
      }
      const modulesNamed = new Set(named.map((n) => n.info?.module).filter(Boolean));
      if (modulesNamed.has('Revive') && modulesNamed.has('Contracts')) what.push('  Solidity (EVM) contracts run in Revive (module 80); Contracts (module 21) runs ink! contracts.');
      if (pairs.length && named.some((n) => n.info)) what.push(`  The numbers belong to runtime ${source?.specVersion}. An error from an older block may use other numbers: name it with the metadata of its block (E10).`);
    } else if (wantsChain && source && wholeIdentifier) {
      what.push(`- No module error is named "${cut(text.trim(), 100)}" in ${source.how}. search_chain with kinds ["error"] finds error names by a part of the name.`);
    }
    const rest: string[] = [];
    for (const r of reverts) rest.push(`- Revert data ${readRevert(r)}`);
    if (!reverts.length) for (const h of hexAlone) rest.push(`- ${h}`);
    for (const s of standard) {
      rest.push(`- ${s.label}: ${s.meaning.replace(/\.$/, '')} (${s.basis}).`);
      // Token(BelowMinimum), Arithmetic(Underflow), DispatchError BadOrigin: the cases we measured for that error
      const variant = /^(Token|Arithmetic)\((\w+)\)$/.exec(s.label);
      const word = /^DispatchError (\w+)$/.exec(s.label);
      addSeen(rest, variant ? seenLines(variant[1], variant[2]) : word ? seenLines('DispatchError', word[1]) : []);
    }
    if (named.length && rest.length) what.push('Other parts of the text:');
    what.push(...rest);

    // An entry is shown in full only when the text is clearly about it; a loose hint is listed as related.
    const best = entries[0] && entries[0].score >= FULL_SCORE ? entries[0] : undefined;
    const also = entries.filter((m) => m !== best).slice(0, 6);
    // "Failed to dispatch call: <error>": the named error and its measured cases say more than E29, so E29 is shown short.
    const errorNamed = named.some((n) => n.info) || standard.some((s) => /^(?:DispatchError |Token\(|Arithmetic\(|Transactional\()/.test(s.label));
    const shortE29 = best?.entry.id === 'E29' && /failed to dispatch call/i.test(text) && errorNamed;
    const bestLines = best ? (shortE29 ? [`${best.entry.id}. ${best.entry.title}`, E29_SHORT] : fullEntry(best.entry)) : [];
    const nothing = !named.length && !reverts.length && !hexAlone.length && !standard.length && !entries.length;

    if (nothing) {
      return lines(
        reachNote,
        `Nothing in this text matches what explain_error knows on the ${network.label}: "${cut(text.replace(/\s+/g, ' '), 200)}".`,
        what.filter(Boolean).length ? what.filter(Boolean) : null,
        'It understands:',
        ...UNDERSTANDS.map((u) => `- ${u}`),
        '',
        'No cause is guessed here. Next: search_chain with kinds ["error"] finds an error name of the chain by a part of it; describe_item explains one; get_transaction or get_block shows the events of a failed transaction.',
      );
    }

    const nextLines: string[] = [];
    const firstNamed = named.find((n) => n.info)?.info;
    if (firstNamed) {
      nextLines.push(named.filter((n) => n.info).length > 1 ? 'describe_item with one of the names above shows that error and the other errors of its module' : `describe_item "${firstNamed.module}.${firstNamed.name}" shows the error and the other errors of its module`);
    }
    const unnamedModule = !firstNamed && pairs.length && source ? [...source.modules.values()].find((m) => m.index === pairs[0].module) : undefined;
    if (unnamedModule) nextLines.push(`describe_item "${unnamedModule.name}" lists the errors that module has now`);
    if (best && NEXT[best.entry.id] && !(best.entry.id === 'E10' && (firstNamed || pairs.length))) nextLines.push(NEXT[best.entry.id]);
    if (readAsRevert && !nextLines.some((l) => l.startsWith('simulate_contract_call'))) nextLines.push('simulate_contract_call runs the call again as a dry run and decodes its result');

    const found = [
      named.length && `${named.length === 1 ? 'a module error' : 'module errors'} named from the chain's metadata`,
      readAsRevert && 'the revert data decoded',
      hexAlone.length && !readAsRevert && 'what the hex value is',
      standard.length && 'standard Substrate or JSON-RPC codes',
      entries.length && `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} of the Bridge Zero team's list of errors and traps (references/errors.md; each entry says how and when it was checked)`,
    ].filter(Boolean);
    return lines(
      `What this error means on Portaldot V3: ${found.join('; ')}.`,
      shortened && `Only the first ${MAX_INPUT} characters of the text were read.`,
      reachNote,
      what.filter(Boolean).length ? ['', 'What the text says', ...what.filter(Boolean)] : null,
      best ? ['', `Best match in our list: ${best.entry.id}`, ...bestLines] : null,
      also.length ? ['', `${best ? 'Also matches' : 'Related entries'} (ask explain_error for the id, such as "${also[0].entry.id}", to read one in full):`, ...also.map((m) => entryLine(m.entry))] : null,
      nextLines.length ? `\nNext: ${nextLines.map((l) => l.replace(/\.$/, '')).join('; ')}.` : null,
    );
  },
});
