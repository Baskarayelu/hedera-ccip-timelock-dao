import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { createPublicClient, createWalletClient, getContractAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getNetwork } from "./networks.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
config({ path: join(packageRoot, ".env") });

/** Reads a compiled contract from Foundry's `out/` directory. */
export function loadArtifact(contractName) {
  const path = join(packageRoot, "out", `${contractName}.sol`, `${contractName}.json`);
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Missing artifact for ${contractName}. Run \`npm run foundry:compile\` first.`);
  }
  return { abi: artifact.abi, bytecode: artifact.bytecode.object };
}

/**
 * Opens clients for one network with the deployer key from `packages/foundry/.env`.
 * Every write states its gas limit: the Hedera relay's estimates undercount system-contract work.
 */
export function openSession(networkName) {
  const network = getNetwork(networkName);
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY is missing or malformed in packages/foundry/.env (run `npm run foundry:account:generate`).",
    );
  }
  const account = privateKeyToAccount(key);
  const transport = http(network.rpcUrl, { timeout: 120_000 });
  const publicClient = createPublicClient({ chain: network.chain, transport });
  const walletClient = createWalletClient({
    account,
    chain: network.chain,
    transport,
  });

  async function waitFor(hash, label) {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: 180_000,
    });
    if (receipt.status !== "success") {
      throw new Error(`${label} failed: ${network.explorerTx(hash)}`);
    }
    console.log(`  ✓ ${label}\n    ${network.explorerTx(hash)}`);
    return receipt;
  }

  return {
    network,
    account,
    publicClient,

    async deploy(contractName, args, { gas, value } = {}) {
      const { abi, bytecode } = loadArtifact(contractName);
      const nonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
      const hash = await walletClient.deployContract({
        abi,
        bytecode,
        args,
        gas,
        value,
      });
      const receipt = await waitFor(hash, `deploy ${contractName}`);
      const address = receipt.contractAddress ?? getContractAddress({ from: account.address, nonce: BigInt(nonce) });
      return { address, abi, hash, blockNumber: receipt.blockNumber };
    },

    async write(contract, functionName, args, { gas, value, label } = {}) {
      const hash = await walletClient.writeContract({
        address: contract.address,
        abi: contract.abi,
        functionName,
        args,
        gas,
        value,
      });
      return { hash, receipt: await waitFor(hash, label ?? functionName) };
    },

    async read(contract, functionName, args = []) {
      return publicClient.readContract({
        address: contract.address,
        abi: contract.abi,
        functionName,
        args,
      });
    },

    async send(to, value, { gas, label } = {}) {
      const hash = await walletClient.sendTransaction({ to, value, gas });
      return { hash, receipt: await waitFor(hash, label ?? `send to ${to}`) };
    },
  };
}
