import { ethRpc, getConn, hasEvmRpc } from '../lib/chain.ts';
import { duration, formatUnits, lines, nativeAmount, untrusted } from '../lib/format.ts';
import { getIndex } from '../lib/meta.ts';
import { PALLETS_ADDRESS, pickNetwork } from '../lib/networks.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const big = (v: Loose): bigint => BigInt(v.toString());

/** A name the node gives (its chain name, runtime name, token symbol) as it is when it is plain, and quoted when it is not. */
const plainName = (v: unknown, max = 60): string => {
  const s = String(v ?? '');
  return /^[A-Za-z0-9 -]*$/.test(s) && s.length <= max ? s : untrusted(s, max);
};

/** A 0x number of the Ethereum RPC's answer, or a rejection so the line reads as not answering. */
const ethNumber = (v: unknown): bigint => {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  throw new Error('not a 0x number');
};

export default defineTool({
  name: 'get_chain_facts',
  title: 'Portaldot V3: basic facts, read live',
  description:
    'Use it first when writing connection code, configuration or constants for Portaldot V3 (tokens POT and tPOT), and when requests fail. Returns the facts that code and configuration need, read from the chain just now: ' +
    'RPC endpoints, Ethereum chain id, token symbol and decimals (14 native, 18 on the Ethereum side), address format, existential deposit, the gas price now, ' +
    'storage-deposit prices, and whether the chain and its Ethereum RPC are answering. Also dated notes on tooling: MetaMask settings, the explorer, test tokens. ' +
    'When requests fail, it shows whether the chain is still producing blocks. Example: {"network": "mainnet"}; with no arguments it reads the testnet.',
  input: { network: networkField },
  readsChain: true,
  handler: async ({ network: key }) => {
    const network = pickNetwork(key);
    const conn = await getConn(network.key);
    const api = conn.api as Loose;
    const index = getIndex(conn);

    const [chainName, header, finalizedHash, now, runtimeGasPrice] = await Promise.all([
      api.rpc.system.chain(),
      api.rpc.chain.getHeader(),
      api.rpc.chain.getFinalizedHead(),
      api.query.timestamp.now(),
      api.call.reviveApi?.gasPrice ? api.call.reviveApi.gasPrice().catch(() => null) : null,
    ]);
    const finalized = await api.rpc.chain.getHeader(finalizedHash);
    const best = header.number.toNumber();
    const fin = finalized.number.toNumber();
    const age = (Date.now() - now.toNumber()) / 1000;

    const token: string = plainName(api.registry.chainTokens[0] ?? network.token, 20);
    const chainText = plainName(chainName.toString());
    const specText = plainName(api.runtimeVersion.specName.toString());
    const decimals: number = api.registry.chainDecimals[0] ?? 14;
    const ss58: number = api.registry.chainSS58 ?? 42;
    const genesis: string = api.genesisHash.toHex();
    const ed = big(api.consts.balances.existentialDeposit);
    const revive = api.consts.revive;

    // The Ethereum side: asked once, quickly, so a slow RPC does not hold this answer back.
    let evmLines: string[];
    if (network.evmProblem) {
      evmLines = [`- Ethereum RPC: ${network.evmProblem}`];
      if (runtimeGasPrice) evmLines.push(`- gas price now, read through the node instead: ${big(runtimeGasPrice)} wei per gas.`);
    } else if (hasEvmRpc(network)) {
      const quick = { tries: 1, timeoutMs: 8_000 };
      const settled = await Promise.allSettled([
        ethRpc<unknown>(network, 'eth_chainId', [], quick).then(ethNumber),
        ethRpc<unknown>(network, 'eth_gasPrice', [], quick).then(ethNumber),
        ethRpc<unknown>(network, 'eth_blockNumber', [], quick).then(ethNumber),
      ]);
      // A value that is not a 0x number counts as no answer.
      const [chainId, gasPrice, blockNumber] = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
      if (chainId !== null && blockNumber !== null) {
        const id = Number(chainId);
        evmLines = [
          `- JSON-RPC ${network.evm}: answering, at block ${blockNumber}, chain id ${id}${id === network.evmChainId ? '' : ` (NOT the expected ${network.evmChainId})`}`,
          gasPrice !== null ? `- gas price now: ${gasPrice} wei per gas. It moves from day to day (38840 on Oct 19, 2026; 15825 on Nov 14), so read it each time and never hard-code it. A priority fee of 0 is accepted.` : '- gas price: the RPC did not answer eth_gasPrice just now.',
        ];
      } else {
        evmLines = [`- JSON-RPC ${network.evm}: NOT answering just now. The Substrate node is, so the chain itself is up; try the Ethereum RPC again in a moment.`];
        if (runtimeGasPrice) evmLines.push(`- gas price now, read through the node instead: ${big(runtimeGasPrice)} wei per gas.`);
      }
    } else {
      evmLines = [
        '- No public Ethereum JSON-RPC exists for this network (checked Nov 13, 2026), so MetaMask, cast, Hardhat and other Ethereum tools cannot reach it today. The tools here read its Ethereum side through the node instead.',
        runtimeGasPrice ? `- gas price now, read through the node: ${big(runtimeGasPrice)} wei per gas.` : null,
      ].filter((l): l is string => l !== null);
    }

    let reviveLines: string[] = [];
    if (revive) {
      const perByte = big(revive.depositPerByte);
      const perItem = big(revive.depositPerItem);
      const perChildItem = big(revive.depositPerChildTrieItem);
      const ratio = big(revive.nativeToEthRatio);
      const lockup = Number(big(revive.codeHashLockupDepositPercent)) / 1e7; // a Perbill
      const slot = perByte * 64n + perChildItem;
      const autoMap = revive.autoMap.toString() === 'true';
      reviveLines = [
        `- chain id ${revive.chainId.toString()} (0x${BigInt(revive.chainId.toString()).toString(16)})`,
        ...evmLines,
        `- the same token shows with 18 decimals there: 1 native base unit = ${ratio} wei, so 1 ${token} = 10^18 wei. Use convert_amount instead of doing this by hand.`,
        '- gas includes the storage deposit, so gas estimates and gas used look very large: about 10^12 for a plain transfer and about 10^14 for a contract call that writes new storage (measured Oct 19 to Nov 14, 2026). estimate_eth_transaction turns an estimate into tokens and checks the balance rule behind error 1010.',
        `- ${revive.allowEVMBytecode.toString() === 'true' ? 'EVM bytecode from solc runs as it is (allowEVMBytecode is true): no resolc or PolkaVM build is needed.' : 'allowEVMBytecode is false: plain EVM bytecode is not accepted.'}`,
        `- ${autoMap ? 'autoMap is on: every native account is linked to its 0x address when it is created, and Revive.mapAccount does nothing. Ignore advice to "call mapAccount first".' : 'autoMap is OFF: a native account must call Revive.mapAccount before it can use contracts.'}`,
        `- storage deposits: ${formatUnits(perByte, decimals)} ${token} per byte, ${formatUnits(perItem, decimals)} per item, ${formatUnits(perChildItem, decimals)} per contract storage entry; code-hash lockup ${lockup}%.`,
        `- one new 32-byte contract storage slot holds ${formatUnits(slot, decimals)} ${token} (64 bytes x ${formatUnits(perByte, decimals)} + ${formatUnits(perChildItem, decimals)}), paid by the sender and returned when the slot is cleared (measured Oct 19-20, 2026).`,
        `- deploying EVM code whose runtime code is L bytes holds 0.078 x L + 13.11 ${token}, before any storage its constructor writes: (L + 70) x 0.06 for the code, 30% of that again as lockup, and 7.65 for the contract's own record. Dry runs for 1 to 24576 bytes of code and the on-chain records of more than 20 contracts gave exactly this on Nov 14, 2026 (899 bytes: 83.232). Code that is already stored on the chain is not charged its own part again. simulate_contract_deploy gives the figure for your code.`,
        `- a 0x account runs a native call by sending an Ethereum transaction to the pallets address ${PALLETS_ADDRESS} with the SCALE-encoded call as data (proven on the testnet on Nov 13, 2026). encode_call builds the data.${hasEvmRpc(network) ? '' : ' On this network there is no public Ethereum RPC to send such a transaction through.'}`,
        `- a token of the Assets module has an ERC-20 address for contracts and Ethereum tools: its id in the first 4 bytes, then 12 zero bytes, then 0x0001 and 0x0000 (asset 2 is 0x0000000200000000000000000000000000010000; measured on the testnet on Nov 14, 2026).`,
      ];
    }

    const health =
      age > 45
        ? `- WARNING: the newest block (${best}) is ${duration(age)} old, and a block should come every 6 s. The chain looks stopped. The testnet stopped twice in Oct 2026 (for 13 h 24 min and 5 h 16 min). Wait and check again; it is not a fault in your code. (If your computer's clock is wrong, this reading is wrong too.)`
        : `- head: block ${best}, finalized ${fin}; the newest block is ${duration(age)} old (a block comes every 6 s). The chain is producing blocks.`;

    const isTestnet = network.key === 'testnet';
    return lines(
      `${network.label}: basic facts`,
      'Read from the chain just now, unless a line gives a date. Dated lines were measured by the Bridge Zero team, who make this tool and are independent of the Portaldot team.',
      '',
      'Chain',
      `- name ${chainText.startsWith('"') ? chainText : `"${chainText}"`}, runtime ${specText} spec ${index.specVersion}, transaction version ${api.runtimeVersion.transactionVersion.toNumber()}`,
      `- genesis ${genesis}${genesis === network.genesis ? '' : ' (NOT the recorded one, see the warning above)'}`,
      health,
      fin < best - 20 && `- WARNING: finality is ${best - fin} blocks behind the head (normally about 2). Do not treat recent transactions as settled.`,
      `- ${index.modules.length} modules. search_chain finds a module or call by what it does; describe_item gives exact arguments.`,
      '',
      'Token and amounts',
      `- native token ${token} with ${decimals} decimals: 1 ${token} = ${10n ** BigInt(decimals)} base units (10n ** ${decimals}n in code)`,
      `- existential deposit, the smallest balance an account may hold: ${nativeAmount(ed, network)}`,
      '- use BigInt for amounts in JavaScript: a Number stops being exact near 90 tokens in base units.',
      isTestnet && token === 'tPOT' && '- tPOT is the test network\'s token and has no real value.',
      '',
      'Addresses',
      `- native accounts: SS58 with prefix ${ss58}, so addresses start with 5. Wallets make sr25519 keys by default.`,
      '- contracts and Ethereum wallets use 0x addresses. Each account has both forms, linked by a rule and not by a shared key: convert_address shows both and says which to use.',
      '',
      'Ethereum side (the Revive module: Solidity contracts, MetaMask)',
      revive ? reviveLines : '- this runtime has no Revive module.',
      '',
      'Endpoints',
      `- Substrate RPC: ${network.ws} (the same host also answers over https)`,
      `- Ethereum RPC: ${network.evm ?? 'none public'}`,
      `- explorer: ${network.explorer} (Substrate side only: it does not look up 0x transaction hashes and has no contract pages; checked Nov 13, 2026).${hasEvmRpc(network) ? ' get_transaction does look up a 0x hash.' : ''}`,
      isTestnet && `- MetaMask: add the network by hand, because no chain list has it (checked Nov 13, 2026): chain id ${revive ? revive.chainId.toString() : network.evmChainId}, RPC ${network.evmCopy}, symbol ${token}, 18 decimals, block explorer left empty.`,
      isTestnet && hasEvmRpc(network) && !network.overridden && `- the Ethereum RPC host also answers on wss:// (${String(network.evm).replace(/^https:/, 'wss:')}). There eth_subscribe takes "newBlockHeaders" and "logs", not the usual "newHeads" (measured Nov 14, 2026).`,
      isTestnet && '- test tokens: there is no self-serve official faucet (checked Nov 13, 2026). Builders report that tPOT is given through a ticket in the Portaldot Discord, and a new contract needs tens of tPOT in deposits, so ask early.',
      !isTestnet && '- this network held no contracts, tokens, swap pools or NFT collections on Nov 13, 2026: only accounts, staking and session data. Build and test on the testnet.',
      '',
      'Good to know',
      '- All public endpoints are run by one operator, and we know of no status page. If requests hang, look at the head line above before blaming your code.',
      isTestnet && "- The endpoints in the older testnet guide (*.feso-apps.xyz) no longer answer; the ones above replaced them. That guide's token name tPOTv3 is also out of date: the chain says tPOT.",
      '- The docs at portaldot-dev.readthedocs.io describe the chain before V3. For V3, rely on what these tools read from the chain.',
      '- explain_error takes any error text (1010, "State already discarded", a module error) and gives the likely cause and fix.',
    );
  },
});
