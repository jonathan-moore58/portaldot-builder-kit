// Every tool the server offers, in the order a builder tends to need them.
import type { AnyTool } from '../lib/tool.ts';
import convertAddress from './convert_address.ts';
import convertAmount from './convert_amount.ts';
import describeItem from './describe_item.ts';
import encodeCall from './encode_call.ts';
import estimateEthTransaction from './estimate_eth_transaction.ts';
import explainError from './explain_error.ts';
import getAccount from './get_account.ts';
import getBlock from './get_block.ts';
import getChainFacts from './get_chain_facts.ts';
import getContractEvents from './get_contract_events.ts';
import getTransaction from './get_transaction.ts';
import readGuide from './read_guide.ts';
import readStorage from './read_storage.ts';
import searchChain from './search_chain.ts';
import simulateContractCall from './simulate_contract_call.ts';
import simulateContractDeploy from './simulate_contract_deploy.ts';

export const TOOLS: AnyTool[] = [
  getChainFacts,
  searchChain,
  describeItem,
  convertAddress,
  getAccount,
  convertAmount,
  readStorage,
  encodeCall,
  estimateEthTransaction,
  simulateContractCall,
  simulateContractDeploy,
  getTransaction,
  getBlock,
  getContractEvents,
  explainError,
  readGuide,
];
