import * as z from 'zod';
import { codeKind, readReviveAccount, resolveHolder } from '../lib/accounts.ts';
import { checksummed, fallbackIdOfH160, parseAddress, specialAddress, SS58_PREFIX, toSs58, type ParsedAddress } from '../lib/address.ts';
import { getConn, type Conn } from '../lib/chain.ts';
import { lines, nativeAmount, toHex } from '../lib/format.ts';
import { pickNetwork, type Network } from '../lib/networks.ts';
import { messageText } from '../lib/text.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

interface OnChain {
  /** The native account linked to the 0x address (revive.originalAccount), as SS58, or null. */
  linked: string | null;
  /** Whether the account that holds the balance exists, and its free balance. */
  exists: boolean;
  free: bigint;
  nonce: number;
  /** Set when the 0x address is a contract. */
  contract: { codeType: string; codeLen: number } | null;
}

async function readOnChain(conn: Conn, parsed: ParsedAddress): Promise<{ onChain: OnChain; holderSs58: string }> {
  const api = conn.api as Loose;
  const holder = await resolveHolder(conn, parsed);
  const [account, revive] = await Promise.all([api.query.system.account(holder.holderId), readReviveAccount(conn, parsed.h160)]);
  const contract = revive?.contract ? { codeType: revive.contract.codeType, codeLen: revive.contract.codeLen } : null;
  const exists = account.providers.toNumber() + account.consumers.toNumber() + account.sufficients.toNumber() > 0;
  return { onChain: { linked: holder.linked, exists, free: BigInt(account.data.free.toString()), nonce: account.nonce.toNumber(), contract }, holderSs58: holder.holderSs58 };
}

const existsLine = (ss58: string, onChain: OnChain, network: Network): string =>
  onChain.exists ? `- ${ss58} exists: free balance ${nativeAmount(onChain.free, network, false)}, nonce ${onChain.nonce}. get_account has the full picture.` : `- ${ss58} does not exist yet: it has never held a balance.`;

function describe(parsed: ParsedAddress, network: Network, onChain: OnChain | null, holderSs58: string, liveNote: string): string {
  const ss58 = toSs58(parsed.accountId);
  const h160 = checksummed(parsed.h160);
  const token = network.token;
  const facesEthereum = parsed.kind === 'h160' || parsed.isFallbackForm;
  const special = specialAddress(parsed.h160);
  const keyCaution =
    parsed.kind === 'accountId'
      ? 'Note: a 0x value of 64 hex characters is read here as a public account id. If what you pasted is a private key, treat it as exposed and move its funds: these tools never need a key.'
      : null;

  if (facesEthereum) {
    // A 0x address, or the 5... address that stands for one (20 bytes followed by twelve 0xEE bytes).
    const fallback = toSs58(fallbackIdOfH160(parsed.h160));
    const linked = onChain?.linked ?? null;
    const wroteFallback = parsed.kind !== 'h160';

    // Not an account at all: the pallets address, a precompile, a token's ERC-20 address.
    if (special && special.kind !== 'zero') {
      return lines(
        `${wroteFallback ? `This 5... address stands for the Ethereum-style address ${h160} (its 20 bytes followed by twelve 0xEE bytes).` : 'An Ethereum-style (0x) address.'} Network: ${network.label}.`,
        '',
        special.text,
        '',
        `0x form:                          ${h160}`,
        `native form of its account id:    ${fallback}  (the 20 bytes followed by twelve 0xEE bytes)`,
        parsed.checksumWarning && `\nWARNING: ${parsed.checksumWarning}`,
        '',
        onChain ? ['Checked on the chain just now:', onChain.contract ? `- the chain records contract code there: ${onChain.contract.codeLen} bytes of ${codeKind(onChain.contract.codeType)} code.` : '- the chain records no contract code at this address.', existsLine(holderSs58, onChain, network)] : `- ${liveNote}`,
        '',
        `Do not send ${token} to it, in either form: no key controls that account.`,
      );
    }

    // The 5... form of a 0x address that is itself linked to a native account: the balance of the 0x
    // address is on that native account, and the 5... address written here is a different, separate account.
    if (wroteFallback && linked && linked !== ss58) {
      return lines(
        `This 5... address is the fallback account of the Ethereum-style address ${h160}: its account id is those 20 bytes followed by twelve 0xEE bytes. Network: ${network.label}.`,
        '',
        `the address you gave:   ${ss58}`,
        `its account id:         ${toHex(parsed.accountId)}`,
        `the 0x address:         ${h160}`,
        `linked native account:  ${linked}`,
        keyCaution,
        '',
        'Checked on the chain just now:',
        `- ${h160} is linked to the native account ${linked} (revive.originalAccount), from which it is derived. So ${token} sent to ${h160} from the Ethereum side arrives on ${linked}, not on the address you gave.`,
        `- the address you gave, ${ss58}, is a separate account that is not used while that link exists. Anything sent to it natively stays on it.`,
        '- only the linked native account could move funds from it, with Revive.dispatchAsFallbackAccount. We have not tested that call.',
        '',
        'Which form to use:',
        `- To pay this account from a native wallet: send to ${linked}.`,
        `- From the Ethereum side: pay ${h160}.`,
        `- Do not send to ${ss58}.`,
      );
    }

    const head = wroteFallback
      ? `This 5... address stands for an Ethereum-style address: its account id is the 20 bytes of ${h160} followed by twelve 0xEE bytes. It is where that 0x address keeps its ${token}.`
      : 'An Ethereum-style (0x) address.';
    return lines(
      `${head} Network: ${network.label}.`,
      '',
      `0x form (Solidity, MetaMask, cast, the Ethereum RPC):  ${h160}`,
      `native form (wallets, explorers, native calls):        ${linked ?? fallback}${linked ? '  <- the native account this 0x address belongs to' : '  <- its fallback account: the 20 bytes followed by twelve 0xEE bytes'}`,
      `account id of that native form:                        ${toHex(linked ? parseAddress(linked).accountId : fallbackIdOfH160(parsed.h160))}`,
      parsed.checksumWarning && `\nWARNING: ${parsed.checksumWarning}`,
      special && `\n${special.text}`,
      '',
      'Checked on the chain just now:',
      onChain
        ? [
            linked
              ? `- the native account ${linked} is linked to this 0x address (revive.originalAccount), which is derived from it. Its balance is that account's balance.`
              : '- no native account is linked to this 0x address (revive.originalAccount is empty). That is normal for an address from an Ethereum key (MetaMask) and for a contract: its balance sits on the fallback account above.',
            onChain.contract ? `- it is a contract: ${onChain.contract.codeLen} bytes of ${codeKind(onChain.contract.codeType)} code.` : '- it is not a contract.',
            existsLine(holderSs58, onChain, network),
          ]
        : `- ${liveNote}`,
      '',
      'Which form to use:',
      special
        ? `- Do not send ${token} to it.`
        : `- To pay it from a native wallet, or with Balances.transferKeepAlive: send to ${linked ?? fallback}. ${linked ? '' : 'The balance then shows in MetaMask (less the 0.1 existential deposit).'}`.trimEnd(),
      `- In Solidity, MetaMask, cast and Ethereum JSON-RPC calls: use ${h160}.`,
      !special && `- A faucet or form that takes only 5... addresses: give it ${linked ?? fallback}.`,
      onChain?.contract ? `- It is a contract, so pay it through its own functions. ${token} sent to its account with a plain transfer arrives, but the contract's code is not run, so its own bookkeeping never counts it.` : null,
      linked
        ? '- No private key exists for this 0x address: it is a hash of the native account id. It cannot sign Ethereum transactions, and tokens sent to it on any other EVM chain can never be moved.'
        : !onChain
          ? '- If this address comes from a native (5...) account rather than an Ethereum key, no private key exists for it: never use it on another EVM chain.'
          : null,
    );
  }

  // A native account (sr25519, ed25519 or a module/multisig account).
  const linkedToItself = onChain?.linked === ss58;
  return lines(
    `A native account. Network: ${network.label}.`,
    '',
    `native form (wallets, explorers, native calls):        ${ss58}`,
    parsed.kind === 'ss58' && parsed.ss58Prefix !== SS58_PREFIX ? `  (you wrote it with SS58 prefix ${parsed.ss58Prefix}; Portaldot uses prefix ${SS58_PREFIX}. It is the same account, and on Portaldot it is written as above.)` : null,
    `account id:                                            ${toHex(parsed.accountId)}`,
    `0x form (what contracts see as msg.sender):            ${h160}  <- the last 20 bytes of keccak-256 of the account id`,
    keyCaution,
    '',
    'Checked on the chain just now:',
    onChain
      ? [
          onChain.exists ? `- the account exists: free balance ${nativeAmount(onChain.free, network, false)}, nonce ${onChain.nonce}. get_account has the full picture.` : '- the account does not exist yet: it has never held a balance.',
          linkedToItself
            ? `- it is linked to its 0x address: revive.originalAccount(${h160}) names it.`
            : onChain.linked
              ? `- WARNING: revive.originalAccount(${h160}) names another account, ${onChain.linked}.`
              : `- it is NOT linked to its 0x address${onChain.exists ? '' : ', because it does not exist yet (accounts are linked when they are created)'}.`,
        ]
      : `- ${liveNote}`,
    '',
    'Which form to use:',
    `- From a native wallet or a native call (Balances.transferKeepAlive, Assets.transfer): use ${ss58}.`,
    onChain && !linkedToItself
      ? `- Do NOT pay ${h160} from the Ethereum side yet: while the account is not linked, ${token} sent there lands on a fallback account that no Ethereum key controls. Fund ${ss58} natively first; that creates and links it. (Revive.dispatchAsFallbackAccount exists to recover such funds; we have not tested it.)`
      : `- From the Ethereum side (MetaMask, a contract that sends value): pay ${h160}. It reaches this account because the account is linked${onChain ? '' : ' (which holds only once the account exists)'}.`,
    `- When this account calls a contract (Revive.call), the contract sees msg.sender = ${h160}.`,
    `- Never give ${h160} as your address on another EVM chain: no private key exists for it (it is a hash of the account id), so tokens sent to it there can never be moved.`,
  );
}

export default defineTool({
  name: 'convert_address',
  title: 'Portaldot V3: both forms of an address',
  description:
    'Converts a Portaldot V3 address between its two forms and says which form to use where. Every account has a native SS58 address that starts with 5 and an Ethereum-style 0x address, ' +
    'linked by a rule (a hash, or twelve 0xEE padding bytes), not by a shared key. Using the wrong form loses funds. Input: any 5... address, a 0x address (40 hex characters) or a 0x account id (64 hex characters). ' +
    'Returns both forms, the account id, and what the chain says just now: whether the forms are linked, whether the account exists, whether it is a contract. It also recognises addresses that are not accounts: the pallets address, precompiles, and the ERC-20 address of an Assets token. ' +
    'Use it before sending to an address on the other side: paying a MetaMask user from a native wallet, paying a native account from a contract, filling a faucet form that wants 5..., or reading msg.sender. For balances, the nonce or contract details, use get_account. ' +
    'Example: {"address": "0x8ddee436166f311ddeed36d714b08f512670d16e"}.',
  input: {
    address: z.string().trim().min(1).describe('The address: SS58 (starts with 5), 0x and 40 hex characters, or a 0x account id of 64 hex characters. Public addresses only, never a key or a secret phrase.'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ address, network: key }) => {
    const network = pickNetwork(key);
    const parsed = parseAddress(address);
    let onChain: OnChain | null = null;
    let holderSs58 = toSs58(parsed.accountId);
    let liveNote = '';
    try {
      const conn = await getConn(network.key);
      ({ onChain, holderSs58 } = await readOnChain(conn, parsed));
    } catch (err) {
      // The offline rule still holds when the node cannot be reached; say so instead of failing.
      liveNote = `could not ask the chain (${messageText(err instanceof Error ? err.message.split('. ')[0] : String(err), 300)}). The forms above follow from the rule alone. Whether a native account is linked to a 0x address, and whether the account exists, could not be checked.`;
    }
    return describe(parsed, network, onChain, holderSs58, liveNote);
  },
});
