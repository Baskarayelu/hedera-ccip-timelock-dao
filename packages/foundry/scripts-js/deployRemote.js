/**
 * Deploys the shared remote side on Base Sepolia: the CCIP executor (which clones one account per DAO)
 * and the demo parameter store. One deployment serves every DAO, so judges do not need to run this.
 *
 *   npm run foundry:deploy:remote
 */
import { parseEther } from "viem";

import { writeDeployment } from "./lib/deployments.js";
import { getNetwork } from "./lib/networks.js";
import { openSession } from "./lib/session.js";

const RECEIPT_GAS_LIMIT = BigInt(process.env.RECEIPT_GAS_LIMIT || 300_000);
const SPONSORED_RECEIPTS_PER_DAO = BigInt(process.env.SPONSORED_RECEIPTS_PER_DAO || 10);
const SPONSOR_POOL_ETH = process.env.SPONSOR_POOL_ETH || "0.002";

const session = openSession("base_sepolia");
const hedera = getNetwork("hedera_testnet");
console.log(`Deploying the remote executor to ${session.network.chain.name} from ${session.account.address}`);

const executor = await session.deploy(
  "CrossChainExecutor",
  [session.network.ccipRouter, RECEIPT_GAS_LIMIT, SPONSORED_RECEIPTS_PER_DAO],
  { gas: 3_000_000n },
);
const parameters = await session.deploy("RemoteParameters", [], {
  gas: 800_000n,
});

let sponsorTx = null;
if (Number(SPONSOR_POOL_ETH) > 0) {
  ({ hash: sponsorTx } = await session.send(executor.address, parseEther(SPONSOR_POOL_ETH), {
    label: `fund the receipt sponsor pool with ${SPONSOR_POOL_ETH} ETH`,
  }));
}

const path = writeDeployment(session.network.chain.id, {
  network: session.network.name,
  chainId: session.network.chain.id,
  deployer: session.account.address,
  deployedAt: new Date().toISOString(),
  ccip: {
    router: session.network.ccipRouter,
    chainSelector: session.network.ccipChainSelector,
  },
  config: {
    receiptGasLimit: RECEIPT_GAS_LIMIT,
    sponsoredReceiptsPerDao: SPONSORED_RECEIPTS_PER_DAO,
    receiptsTo: hedera.name,
  },
  contracts: {
    CrossChainExecutor: {
      address: executor.address,
      txHash: executor.hash,
      blockNumber: executor.blockNumber,
    },
    RemoteParameters: {
      address: parameters.address,
      txHash: parameters.hash,
      blockNumber: parameters.blockNumber,
    },
  },
  transactions: { sponsorPool: sponsorTx },
});

console.log(`\nWrote ${path}`);
console.log(`CrossChainExecutor ${session.network.explorerAddress(executor.address)}`);
console.log(`RemoteParameters   ${session.network.explorerAddress(parameters.address)}`);
