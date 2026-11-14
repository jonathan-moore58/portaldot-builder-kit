// Our own words about the chain's modules: what each one is for, the everyday jobs and the call that
// does each, and plain notes on the calls a newcomer meets first. Each line was compared with the
// chain's own text for that module or call on Nov 13, 2026. "POT" is swapped for the network's own
// symbol (tPOT on the testnet) when a line is shown.

export interface Group {
  id: string;
  name: string;
  sub: string;
  members: string[];
}

export const GROUPS: Group[] = [
  { id: 'money', name: 'Money and accounts', sub: 'Sending POT, paying fees and account tools',
    members: ['Balances', 'TransactionPayment', 'Multisig', 'Proxy', 'Identity', 'Vesting', 'Indices', 'Recovery', 'MetaTx', 'AssetConversionTxPayment', 'SkipFeelessPayment', 'VerifySignature'] },
  { id: 'assets', name: 'Tokens, NFTs and swaps', sub: 'Tokens anyone can create, NFTs and the built-in exchange',
    members: ['AssetConversion', 'Assets', 'Nfts', 'Uniques', 'PoolAssets', 'NftFractionalization', 'Oracle', 'AssetRate', 'AssetsFreezer', 'Lottery', 'AssetConversionMigration'] },
  { id: 'contracts', name: 'Smart contracts', sub: 'Solidity (Revive) and ink! (Contracts)',
    members: ['Revive', 'Contracts', 'AssetsPrecompiles', 'AssetsPrecompilesPermit', 'VestingPrecompiles'] },
  { id: 'staking', name: 'Staking', sub: 'Validators, nominators and pools',
    members: ['Staking', 'NominationPools', 'ElectionProviderMultiPhase', 'VoterList', 'FastUnstake', 'DelegatedStaking'] },
  { id: 'consensus', name: 'Blocks and finality', sub: 'Who makes blocks and how they become final',
    members: ['Babe', 'Grandpa', 'Beefy', 'Mmr', 'MmrLeaf', 'Authorship', 'Session', 'ImOnline', 'AuthorityDiscovery', 'Offences', 'Historical'] },
  { id: 'runtime', name: 'Basics', sub: 'Parts every block relies on',
    members: ['System', 'Timestamp', 'Utility', 'Scheduler', 'Parameters', 'TransactionStorage', 'Remark', 'Statement', 'MultiBlockMigrations', 'TxPause', 'SafeMode', 'Mixnet'] },
  { id: 'governance', name: 'Governance and treasury', sub: 'The admin key, the committee and the treasury',
    members: ['Treasury', 'Sudo', 'TechnicalCommittee', 'TechnicalMembership', 'Bounties', 'ChildBounties', 'MultiAssetBounties', 'Preimage'] },
  { id: 'crosschain', name: 'Other chains', sub: 'Parachains and blockspace',
    members: ['MessageQueue', 'Broker', 'RegistrarPara', 'RegistrarRelay'] },
];

export const GROUP_OF = new Map<string, Group>();
for (const g of GROUPS) for (const m of g.members) GROUP_OF.set(m, g);

/** One line on what each module is for. */
export const MODULE_NOTES: Record<string, string> = {
  Babe: 'Chooses which validator makes each block, in 6-second slots.',
  Authorship: 'Records who made each block.',
  Session: "Rotates the validators' session keys.",
  Grandpa: 'Finality: the validators vote blocks final.',
  Beefy: 'A second round of signatures on final blocks, compact enough for bridges.',
  Mmr: 'A Merkle Mountain Range over all blocks, used in BEEFY proofs.',
  MmrLeaf: 'Builds the MMR entry for each block, with the BEEFY key set.',
  ImOnline: 'Heartbeats that show the validators are online.',
  AuthorityDiscovery: 'Helps validators find each other on the network.',
  Offences: 'Records validator misbehaviour.',
  Historical: 'Keeps past validator sets, so offences can be proven.',
  Balances: "The chain's own token, POT: every balance, and the calls that send it.",
  TransactionPayment: 'Works out and charges transaction fees.',
  AssetConversionTxPayment: 'Lets fees be paid in other assets, swapped to POT.',
  SkipFeelessPayment: 'Skips the fee for calls marked feeless.',
  Indices: 'Short account numbers instead of long addresses.',
  Identity: 'Names and verified identities for accounts.',
  Recovery: 'Recover an account with the help of trusted friends.',
  Vesting: 'Unlocks POT gradually over time.',
  Proxy: 'Lets one account act for another, within limits.',
  Multisig: 'Accounts that need several signers to approve.',
  MetaTx: 'Meta-transactions: someone else submits and pays.',
  VerifySignature: 'Checks a signature as part of a transaction.',
  Assets: 'Tokens anyone can create and manage.',
  PoolAssets: 'Tokens that stand for a share of a swap pool (LP tokens).',
  AssetsFreezer: 'Freezes part of an asset balance.',
  AssetRate: 'Exchange rates between assets and POT.',
  AssetConversion: 'The built-in exchange: pools and swaps between tokens.',
  AssetConversionMigration: 'Maintenance for the swap pools.',
  Uniques: 'The older, simpler NFT module. New projects use Nfts.',
  Nfts: 'The current NFT module: collections, items, attributes, prices and swaps.',
  NftFractionalization: 'Splits an NFT into fungible shares.',
  Oracle: 'Price feeds posted by approved members.',
  Lottery: 'An on-chain lottery.',
  Revive: 'Smart contracts written in Solidity, with Ethereum-style addresses and transactions.',
  Contracts: 'Smart contracts written in ink!, a Rust language (WebAssembly).',
  AssetsPrecompiles: 'Lets contracts use assets as ERC-20 tokens.',
  AssetsPrecompilesPermit: 'ERC-20 permit (signed approvals) for those tokens.',
  VestingPrecompiles: 'Lets contracts use vesting.',
  Staking: 'Bonding POT, picking validators, rewards and slashing.',
  ElectionProviderMultiPhase: 'Runs the election that picks the validators.',
  VoterList: 'Keeps nominators sorted by stake for the election.',
  NominationPools: 'Lets small holders stake together.',
  FastUnstake: 'Quick unbonding for stakers who were not active.',
  DelegatedStaking: 'Staking with funds that others delegated.',
  Sudo: 'One admin key that can make any change.',
  TechnicalCommittee: 'A committee that can act on proposals.',
  TechnicalMembership: 'Who sits on the technical committee.',
  Treasury: "The chain's treasury and its spending. Transaction fees are paid into it.",
  Bounties: 'Treasury-funded bounties for work.',
  ChildBounties: 'Smaller bounties inside a bounty.',
  MultiAssetBounties: 'Bounties paid in any token: POT or another one.',
  Preimage: 'Stores the full content of proposals for later use.',
  RegistrarPara: 'The parachain side of joining a relay chain.',
  RegistrarRelay: 'The relay side of registering parachains.',
  Broker: 'Sells coretime, the block-making time that other chains rent.',
  MessageQueue: 'Queues incoming messages, for example from other chains.',
  System: 'The base layer: accounts, blocks and events.',
  Timestamp: 'Sets the time of each block.',
  Utility: 'Bundles several calls into one.',
  Scheduler: 'Runs calls at a later block.',
  Parameters: 'Runtime settings that can change without an upgrade.',
  MultiBlockMigrations: 'Runs large upgrades over several blocks.',
  TxPause: 'Pauses chosen calls in an emergency.',
  SafeMode: 'Puts the whole chain in a restricted safe mode.',
  Remark: 'Stores a note off chain, found by its hash, and records the hash in an event.',
  Statement: 'A store for signed statements shared between nodes.',
  TransactionStorage: 'Stores data off chain for a set number of blocks, unless it is renewed.',
  Mixnet: 'Private message routing between nodes.',
};

export type ItemKind = 'call' | 'event' | 'error' | 'constant' | 'storage';

export interface Job {
  id: string;
  /** The job in everyday words. */
  text: string;
  /** Words a search for this job may use. A query word matches when one of these starts with it. */
  words: string;
  module: string;
  kind: ItemKind;
  item: string;
}

/** Everyday jobs, each with the exact call (or stored value) that does it. */
export const JOBS: Job[] = [
  { id: 'send', text: 'Send POT to another account', words: 'send transfer pay payment pot tpot money coin native funds', module: 'Balances', kind: 'call', item: 'transferKeepAlive' },
  { id: 'balance', text: 'Check the balance of an account', words: 'balance check read account funds query holdings', module: 'System', kind: 'storage', item: 'account' },
  { id: 'deploy', text: 'Deploy a Solidity contract', words: 'deploy contract solidity evm ethereum instantiate smart create', module: 'Revive', kind: 'call', item: 'instantiateWithCode' },
  { id: 'callc', text: 'Call a Solidity contract', words: 'call contract solidity evm ethereum invoke execute smart', module: 'Revive', kind: 'call', item: 'call' },
  { id: 'token', text: 'Create your own token', words: 'create token asset erc20 issue new coin fungible', module: 'Assets', kind: 'call', item: 'create' },
  { id: 'minttoken', text: 'Mint units of your token', words: 'mint token asset supply issue', module: 'Assets', kind: 'call', item: 'mint' },
  { id: 'sendtoken', text: 'Send a token other than POT', words: 'send transfer token asset pay', module: 'Assets', kind: 'call', item: 'transfer' },
  { id: 'swap', text: 'Swap one token for another', words: 'swap exchange trade dex convert token asset', module: 'AssetConversion', kind: 'call', item: 'swapExactTokensForTokens' },
  { id: 'collection', text: 'Create an NFT collection', words: 'nft collection create new', module: 'Nfts', kind: 'call', item: 'create' },
  { id: 'nft', text: 'Mint an NFT', words: 'nft mint collectible item', module: 'Nfts', kind: 'call', item: 'mint' },
  { id: 'stake', text: 'Stake POT', words: 'stake staking bond lock earn rewards', module: 'Staking', kind: 'call', item: 'bond' },
  { id: 'pool', text: 'Stake through a pool', words: 'stake staking pool join nomination', module: 'NominationPools', kind: 'call', item: 'join' },
  { id: 'batch', text: 'Send several calls in one transaction', words: 'batch bundle several many multiple together atomic', module: 'Utility', kind: 'call', item: 'batchAll' },
  { id: 'ink', text: 'Deploy an ink! contract', words: 'deploy contract ink wasm rust instantiate smart', module: 'Contracts', kind: 'call', item: 'instantiateWithCode' },
  { id: 'multisig', text: 'Approve or run a call from a multisig account', words: 'multisig multi signature approve threshold signers', module: 'Multisig', kind: 'call', item: 'asMulti' },
  { id: 'remark', text: 'Write a note into a block', words: 'remark note memo message text', module: 'System', kind: 'call', item: 'remarkWithEvent' },
];

/** One plain sentence or two for the items a newcomer meets first, keyed "Module.item". */
export const PLAIN_NOTES: Record<string, string> = {
  'Balances.transferKeepAlive': "Sends POT with a safety check: it refuses to take your own balance below the smallest amount an account may hold, so your account cannot be removed by accident. transferAllowDeath is the same transfer without the check. The two differ only when a transfer would leave you below that amount. It is the safer choice for an everyday send, even though the chain's own note points to transferAllowDeath.",
  'Balances.transferAllowDeath': 'Sends POT. If your balance ends up below the smallest amount an account may hold, your account is removed and the little that was left is lost. transferKeepAlive is the same transfer with a check against that. The two differ only in that one case.',
  'Balances.transferAll': 'Sends everything you are free to spend. Set keepAlive to true to leave the smallest allowed balance behind and keep your account.',
  'System.account': "How to read a balance. The answer holds the account's data.free, the POT it owns outright, beside its reserved and frozen amounts and its nonce.",
  'System.remark': 'Writes a note into a block. It changes nothing else.',
  'System.remarkWithEvent': 'Writes a note into a block and reports it in a Remarked event that names the sender. It changes nothing else.',
  'Revive.instantiateWithCode': "Uploads a contract's compiled code and creates the contract in one step. value is POT sent to the new contract, and the two limits cap what the deployment may cost you. For EVM bytecode the constructor arguments are appended to the code, and data is 0x.",
  'Revive.call': "Calls a contract at its Ethereum-style address. data is the encoded function call, the same bytes an Ethereum transaction would carry. value is in native units (14 decimals); the contract sees msg.value as 10,000 times that, in wei.",
  'Revive.mapAccount': "Links a normal account to its Ethereum-style address, so that it can work with contracts. When this module's autoMap setting is on, as it is on this chain today, every account is linked by itself and this call does nothing.",
  'Revive.ethTransact': 'How Ethereum tools reach this module: an Ethereum JSON-RPC server wraps each Ethereum transaction in this call. You do not send it yourself.',
  'Revive.dispatchAsFallbackAccount': 'A recovery call: lets a native account act as the fallback account of its own 0x address, to move funds that were sent to that 0x address before the account was linked.',
  'Contracts.instantiateWithCode': "Uploads an ink! contract's compiled code and creates the contract in one step. value is POT sent to the new contract, and the two limits cap what the deployment may cost you.",
  'Assets.create': 'Creates a new token under an id number that is not in use yet. You name its admin and the smallest balance an account may hold of it. It starts with no supply, which mint then adds, and a deposit is reserved from you.',
  'Assets.mint': "Creates new units of a token and gives them to an account. Only the token's issuer may do it.",
  'Assets.transfer': 'Sends units of a token, not POT, to another account.',
  'AssetConversion.swapExactTokensForTokens': 'Swaps an exact amount of one token for another through the built-in pools. amountOutMin is the least you accept in return: if the price is worse, the swap fails and you keep your tokens.',
  'Nfts.create': 'Creates a new NFT collection that you own, for a deposit. Its items are then added with mint.',
  'Nfts.mint': 'Creates one NFT inside a collection, under the item number you choose, and gives it to mintTo. The collection must exist first.',
  'Staking.bond': 'Locks an amount of your POT for staking and says where the rewards go. It is the first step: nominate then picks the validators you back.',
  'Staking.nominate': 'Picks the validators that your bonded POT backs.',
  'NominationPools.join': 'Stakes through a pool instead of on your own: you add an amount to the pool that has this id number.',
  'Utility.batchAll': 'Runs several calls as one transaction. If any of them fails, none of them takes effect.',
  'Utility.batch': 'Runs several calls as one transaction. If one fails, the calls before it still count and the rest are skipped.',
  'Multisig.asMulti': "Approves a call from a multisig account and runs it once enough signers have approved. The first approval must be asMulti with the full call, because the chain stores only the call's hash. otherSignatories must be sorted by account id, and the transaction succeeds even when the inner call fails: read the result in the MultisigExecuted event.",
};

/** Words the chain's own text uses without explaining them. */
export const GLOSSARY: Array<{ term: string; meaning: string }> = [
  { term: 'origin', meaning: 'who is making the call: usually the account that signed the transaction' },
  { term: 'root', meaning: "the chain's admin origin. On this chain the key held in the Sudo module can act as root" },
  { term: 'extrinsic', meaning: 'a transaction, or any other call a block carries' },
  { term: 'pallet', meaning: 'the Substrate word for a module' },
  { term: 'existential deposit', meaning: 'the smallest balance an account may hold. Below it the account is removed, which the text calls killed or reaped' },
  { term: 'keep alive, allow death', meaning: 'whether a transfer may take the sender below that smallest balance' },
  { term: 'weight', meaning: 'a measure of computing work, with two parts (refTime and proofSize); a weight limit works like a gas limit' },
  { term: 'storage deposit', meaning: 'POT held while a contract or other item occupies chain storage, and returned when the storage is cleared' },
];

/** Everyday words and the chain's words for the same thing. A search for one also looks for the others. */
export const SYNONYMS: Record<string, string[]> = {
  send: ['transfer'],
  pay: ['transfer'],
  payment: ['transfer'],
  token: ['asset', 'assets'],
  tokens: ['asset', 'assets'],
  coin: ['asset', 'balances'],
  erc20: ['asset', 'assets', 'precompiles'],
  nft: ['nfts', 'uniques', 'item', 'collection'],
  nfts: ['nfts', 'uniques', 'item', 'collection'],
  erc721: ['nfts', 'uniques'],
  contract: ['revive', 'contracts'],
  contracts: ['revive', 'contracts'],
  solidity: ['revive'],
  evm: ['revive', 'eth'],
  ethereum: ['revive', 'eth'],
  ink: ['contracts'],
  wasm: ['contracts'],
  deploy: ['instantiate', 'upload'],
  swap: ['assetconversion', 'swap'],
  dex: ['assetconversion', 'pool'],
  liquidity: ['assetconversion', 'liquidity'],
  stake: ['staking', 'bond', 'nominate'],
  unstake: ['unbond', 'withdraw'],
  delegate: ['nominate', 'proxy'],
  fee: ['transactionpayment', 'fee'],
  fees: ['transactionpayment', 'fee'],
  gas: ['weight', 'fee'],
  admin: ['sudo', 'root'],
  vote: ['technicalcommittee', 'vote'],
  governance: ['technicalcommittee', 'treasury', 'sudo'],
  batch: ['utility', 'batch'],
  note: ['remark'],
  memo: ['remark'],
  wallet: ['account', 'balances'],
  burn: ['burn'],
  airdrop: ['transfer', 'batch'],
  schedule: ['scheduler'],
  timelock: ['scheduler', 'vesting'],
  price: ['oracle', 'assetrate', 'price'],
  name: ['identity'],
  username: ['identity'],
};

/** Swaps "POT" for the network's own symbol. */
export const withToken = (text: string, token: string): string => text.replace(/\bPOT\b/g, token);
