/**
 * Deploys a complete DAO on Hedera testnet and wires it to the shared Base Sepolia executor:
 * HTS governance token + faucet, wrap-to-vote token, timelock (treasury and CCIP gateway) and the
 * keeperless governor. Ends by renouncing the deployer's admin role, so only proposals can change it.
 *
 *   npm run foundry:deploy:hedera
 *
 * Settings come from packages/foundry/.env (see .env.example). Times are in seconds, HBAR amounts in HBAR.
 */
import { createPublicClient, http, zeroAddress } from "viem";

import { readDeployment, writeDeployment } from "./lib/deployments.js";
import { formatHbar, getNetwork, hbarToTinybar, tinybarToWeibar } from "./lib/networks.js";
import { openSession } from "./lib/session.js";

const env = (key, fallback) => process.env[key] ?? fallback;
const settings = {
  tokenName: env("GOV_TOKEN_NAME", "DAO Governance"),
  tokenSymbol: env("GOV_TOKEN_SYMBOL", "HGOV"),
  claimAmount: BigInt(env("FAUCET_CLAIM_TOKENS", "1000")) * 1_000_000n, // 6 decimals
  claimCooldown: BigInt(env("FAUCET_COOLDOWN_SECONDS", "86400")),
  votingDelay: Number(env("VOTING_DELAY_SECONDS", "60")),
  votingPeriod: Number(env("VOTING_PERIOD_SECONDS", "300")),
  timelockDelay: BigInt(env("TIMELOCK_DELAY_SECONDS", "120")),
  proposalThreshold: BigInt(env("PROPOSAL_THRESHOLD_TOKENS", "0")) * 1_000_000n,
  quorumPercent: BigInt(env("QUORUM_PERCENT", "4")),
  autoQueueGas: BigInt(env("AUTO_QUEUE_GAS", "3000000")),
  autoExecuteGas: BigInt(env("AUTO_EXECUTE_GAS", "1500000")),
  requestTtl: BigInt(env("REQUEST_TTL_SECONDS", "86400")),
  tokenCreateHbar: env("TOKEN_CREATE_HBAR", "30"),
  governorFloatHbar: env("GOVERNOR_FLOAT_HBAR", "15"),
  treasuryHbar: env("TREASURY_HBAR", "20"),
};

const session = openSession("hedera_testnet");
const base = getNetwork("base_sepolia");
const remote = readDeployment(base.chain.id);
if (!remote?.contracts?.CrossChainExecutor) {
  throw new Error("No Base Sepolia executor in deployments/84532.json. Run `npm run foundry:deploy:remote` first.");
}
const executorAddress = remote.contracts.CrossChainExecutor.address;
const hbar = (amount) => tinybarToWeibar(hbarToTinybar(amount)); // JSON-RPC value is weibar

console.log(`Deploying the DAO to ${session.network.chain.name} from ${session.account.address}`);
const balance = await session.publicClient.getBalance({
  address: session.account.address,
});
console.log(`Deployer balance: ${formatHbar(balance / 10_000_000_000n)}\n`);

const faucet = await session.deploy("GovTokenFaucet", [settings.claimAmount, settings.claimCooldown], {
  gas: 1_500_000n,
});
await session.write(faucet, "createToken", [settings.tokenName, settings.tokenSymbol], {
  value: hbar(settings.tokenCreateHbar),
  gas: 1_500_000n,
  label: `create the ${settings.tokenSymbol} HTS token`,
});
const token = await session.read(faucet, "token");

const votes = await session.deploy("VoteToken", [token, `Voting ${settings.tokenName}`, `v${settings.tokenSymbol}`], {
  gas: 4_000_000n,
});
await session.write(votes, "associateUnderlying", [], {
  gas: 1_000_000n,
  label: "associate VoteToken with the token",
});

const timelock = await session.deploy(
  "DaoTimelock",
  [settings.timelockDelay, [], [zeroAddress], session.account.address, session.network.ccipRouter, settings.requestTtl],
  { gas: 6_000_000n },
);
const governor = await session.deploy(
  "DaoGovernor",
  [
    votes.address,
    timelock.address,
    settings.votingDelay,
    settings.votingPeriod,
    settings.proposalThreshold,
    settings.quorumPercent,
    settings.autoQueueGas,
    settings.autoExecuteGas,
  ],
  { gas: 8_000_000n },
);

// Role ids come from the contract: OpenZeppelin's DEFAULT_ADMIN_ROLE is 0x00, not the hash of its name.
const [proposerRole, cancellerRole, adminRole] = await Promise.all(
  ["PROPOSER_ROLE", "CANCELLER_ROLE", "DEFAULT_ADMIN_ROLE"].map((name) => session.read(timelock, name)),
);
await session.write(timelock, "grantRole", [proposerRole, governor.address], {
  gas: 200_000n,
  label: "governor may propose to the timelock",
});
await session.write(timelock, "grantRole", [cancellerRole, governor.address], {
  gas: 200_000n,
  label: "governor may cancel in the timelock",
});
await session.write(timelock, "setRemoteExecutor", [base.ccipChainSelector, executorAddress], {
  gas: 200_000n,
  label: "register the Base Sepolia executor",
});
await session.write(timelock, "associateToken", [token], {
  gas: 1_000_000n,
  label: "associate the treasury with the token",
});
await session.send(governor.address, hbar(settings.governorFloatHbar), {
  gas: 100_000n,
  label: `fund the governor's callback float with ${settings.governorFloatHbar} HBAR`,
});
await session.send(timelock.address, hbar(settings.treasuryHbar), {
  gas: 100_000n,
  label: `fund the treasury with ${settings.treasuryHbar} HBAR`,
});
const renounce = await session.write(timelock, "renounceRole", [adminRole, session.account.address], {
  gas: 200_000n,
  label: "renounce the deployer's admin role",
});

// Check the wiring that keeps the DAO in the voters' hands before calling the deploy done.
const [deployerIsAdmin, governorProposes, governorCancels] = await Promise.all([
  session.read(timelock, "hasRole", [adminRole, session.account.address]),
  session.read(timelock, "hasRole", [proposerRole, governor.address]),
  session.read(timelock, "hasRole", [cancellerRole, governor.address]),
]);
if (deployerIsAdmin || !governorProposes || !governorCancels) {
  throw new Error(
    `Timelock roles are wrong (deployer admin: ${deployerIsAdmin}, governor proposer: ${governorProposes}, governor canceller: ${governorCancels}).`,
  );
}
console.log("  ✓ the deployer is no longer the timelock admin; only proposals can change the DAO");

const baseClient = createPublicClient({
  chain: base.chain,
  transport: http(base.rpcUrl),
});
const remoteAccount = await baseClient.readContract({
  address: executorAddress,
  abi: [
    {
      type: "function",
      name: "accountOf",
      stateMutability: "view",
      inputs: [
        { name: "sourceChainSelector", type: "uint64" },
        { name: "sourceDao", type: "address" },
      ],
      outputs: [{ type: "address" }],
    },
  ],
  functionName: "accountOf",
  args: [session.network.ccipChainSelector, timelock.address],
});

const record = (c) => ({
  address: c.address,
  txHash: c.hash,
  blockNumber: c.blockNumber,
});
const path = writeDeployment(session.network.chain.id, {
  network: session.network.name,
  chainId: session.network.chain.id,
  deployer: session.account.address,
  deployedAt: new Date().toISOString(),
  ccip: {
    router: session.network.ccipRouter,
    chainSelector: session.network.ccipChainSelector,
  },
  settings,
  governanceToken: token,
  remote: {
    chainId: base.chain.id,
    executor: executorAddress,
    daoAccount: remoteAccount,
  },
  contracts: {
    GovTokenFaucet: record(faucet),
    VoteToken: record(votes),
    DaoTimelock: record(timelock),
    DaoGovernor: record(governor),
  },
  transactions: { adminRenounced: renounce.hash },
});

console.log(`\nWrote ${path}`);
console.log(`Governance token ${token}`);
console.log(`DaoGovernor      ${session.network.explorerAddress(governor.address)}`);
console.log(`DaoTimelock      ${session.network.explorerAddress(timelock.address)}`);
console.log(`Your DAO's account on Base Sepolia: ${base.explorerAddress(remoteAccount)}`);
console.log("Fund it with Base Sepolia ETH to pay receipts, and with any tokens the DAO should control there.");
console.log("Then run `npm run foundry:export` to point the frontend at this deployment.");
