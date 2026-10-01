import { baseSepolia, hederaTestnet } from "viem/chains";

/**
 * The two chains this template deploys to, with the Chainlink CCIP addresses they use.
 * CCIP values come from the CCIP directory (docs.chain.link/ccip/directory/testnet) and were
 * checked on-chain with Router.isChainSupported / getOnRamp.
 */
export const NETWORKS = {
  hedera_testnet: {
    chain: hederaTestnet,
    rpcUrl: process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api",
    ccipRouter: "0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4",
    ccipChainSelector: 222782988166878823n,
    explorerTx: (hash) => `https://hashscan.io/testnet/transaction/${hash}`,
    explorerAddress: (address) => `https://hashscan.io/testnet/contract/${address}`,
    nativeSymbol: "HBAR",
  },
  base_sepolia: {
    chain: baseSepolia,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    ccipRouter: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
    ccipChainSelector: 10344971235874465080n,
    explorerTx: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
    explorerAddress: (address) => `https://sepolia.basescan.org/address/${address}`,
    nativeSymbol: "ETH",
  },
};

export const ccipExplorerMessage = (messageId) => `https://ccip.chain.link/msg/${messageId}`;

/** @param {string} name */
export function getNetwork(name) {
  const network = NETWORKS[name];
  if (!network) {
    throw new Error(`Unknown network "${name}". Use one of: ${Object.keys(NETWORKS).join(", ")}`);
  }
  return { name, ...network };
}

/**
 * Inside the Hedera EVM, HBAR amounts are tinybar (8 decimals); over JSON-RPC, `value` is weibar
 * (18 decimals). These helpers keep the two from being mixed up.
 */
export const TINYBAR_PER_HBAR = 100_000_000n;
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/** @param {number | string} hbar */
export const hbarToTinybar = (hbar) => BigInt(Math.round(Number(hbar) * 1e8));

/** @param {bigint} tinybar */
export const tinybarToWeibar = (tinybar) => tinybar * WEIBAR_PER_TINYBAR;

/** @param {bigint} tinybar */
export const formatHbar = (tinybar) => `${(Number(tinybar) / 1e8).toFixed(8).replace(/\.?0+$/, "")} HBAR`;
