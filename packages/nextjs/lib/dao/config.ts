import type { Address, Hex } from "viem";
import daoDeployment from "~~/contracts/daoDeployment";

export type HederaDeployment = {
  chainId: number;
  mirrorNode: string;
  ccipRouter: Address;
  ccipChainSelector: string;
  /** Unix seconds; log scans start here. */
  deployedAt: number;
  deployer: Address;
  governanceToken: Address;
  /** The HTS token's symbol, set at deploy time (GOV_TOKEN_SYMBOL); the vote token is "v" + this. */
  governanceSymbol: string;
  governor: Address;
  timelock: Address;
  voteToken: Address;
  faucet: Address;
  /** This DAO's account on Base Sepolia (a clone the executor creates on first use). */
  remoteAccount: Address;
};

export type BaseDeployment = {
  chainId: number;
  ccipRouter: Address;
  ccipChainSelector: string;
  executor: Address;
  remoteParameters: Address;
  usdc: Address;
  deployedBlock: string;
};

/** Written by `foundry:export`; `hedera` is null until the DAO is deployed. */
export const deployment = daoDeployment as unknown as {
  hedera: HederaDeployment | null;
  base: BaseDeployment;
};

export const HEDERA_CHAIN_ID = 296;
export const BASE_CHAIN_ID = deployment.base.chainId;
export const BASE_SELECTOR = BigInt(deployment.base.ccipChainSelector);

export const MIRROR_URL =
  process.env.NEXT_PUBLIC_HEDERA_MIRROR_URL || deployment.hedera?.mirrorNode || "https://testnet.mirrornode.hedera.com";
export const HEDERA_RPC_URL = process.env.NEXT_PUBLIC_HEDERA_TESTNET_RPC_URL || "https://testnet.hashio.io/api";
export const BASE_RPC_URL = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

/** Fixture mode serves scripted scenarios instead of chain reads. Used by the e2e tests only. */
export const FIXTURES_ENABLED = process.env.NEXT_PUBLIC_DAO_FIXTURES === "true";

/** Token symbols shown in the app. Fixtures always use the default, so their screenshots do not depend on a deploy. */
export const GOV_SYMBOL = (!FIXTURES_ENABLED && deployment.hedera?.governanceSymbol) || "HGOV";
export const VOTE_SYMBOL = `v${GOV_SYMBOL}`;

export const explorer = {
  hederaTx: (hash: Hex | string) => `https://hashscan.io/testnet/transaction/${hash}`,
  hederaSchedule: (id: string) => `https://hashscan.io/testnet/schedule/${id}`,
  hederaContract: (address: Address) => `https://hashscan.io/testnet/contract/${address}`,
  hederaAccount: (address: Address) => `https://hashscan.io/testnet/account/${address}`,
  baseTx: (hash: Hex) => `https://sepolia.basescan.org/tx/${hash}`,
  baseAddress: (address: Address) => `https://sepolia.basescan.org/address/${address}`,
  ccipMessage: (id: Hex) => `https://ccip.chain.link/msg/${id}`,
};
