/**
 * Verifies this DAO's Hedera contracts on Sourcify, so HashScan shows their source. Addresses and constructor
 * settings come from deployments/296.json, written by `npm run foundry:deploy:hedera`.
 *
 *   npm run foundry:verify:hedera
 */
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { encodeAbiParameters, zeroAddress } from "viem";

import { readDeployment } from "./lib/deployments.js";
import { loadArtifact } from "./lib/session.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dep = readDeployment(296);
if (!dep) throw new Error("No deployments/296.json. Deploy first with `npm run foundry:deploy:hedera`.");
const s = dep.settings;

// The arguments deployHedera.js passed to each constructor.
const contracts = [
  ["GovTokenFaucet", [BigInt(s.claimAmount), BigInt(s.claimCooldown)]],
  ["VoteToken", [dep.governanceToken, `Voting ${s.tokenName}`, `v${s.tokenSymbol}`]],
  ["DaoTimelock", [BigInt(s.timelockDelay), [], [zeroAddress], dep.deployer, dep.ccip.router, BigInt(s.requestTtl)]],
  [
    "DaoGovernor",
    [
      dep.contracts.VoteToken.address,
      dep.contracts.DaoTimelock.address,
      Number(s.votingDelay),
      Number(s.votingPeriod),
      BigInt(s.proposalThreshold),
      BigInt(s.quorumPercent),
      BigInt(s.autoQueueGas),
      BigInt(s.autoExecuteGas),
    ],
  ],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function jobResult(jobId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(3_000);
    const job = await (await fetch(`https://sourcify.dev/server/v2/verify/${jobId}`)).json();
    if (!job.isJobCompleted) continue;
    if (job.contract?.match) return job.contract.match;
    // A second run of this script: Sourcify keeps the earlier match and says so.
    if (/already verified/i.test(job.error?.message ?? "")) return "already verified";
    return `failed: ${job.error?.message ?? "unknown error"}`;
  }
  return "still running; check later";
}

let failures = 0;
for (const [name, args] of contracts) {
  const address = dep.contracts[name].address;
  const constructor = loadArtifact(name).abi.find((item) => item.type === "constructor");
  const encoded = encodeAbiParameters(constructor.inputs, args);
  let output;
  try {
    output = execFileSync(
      "forge",
      [
        "verify-contract",
        "--chain-id",
        "296",
        "--verifier",
        "sourcify",
        address,
        `contracts/hedera/${name}.sol:${name}`,
        "--constructor-args",
        encoded,
      ],
      { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const jobId = output.match(/verify\/([0-9a-f-]{36})/)?.[1];
  const result = jobId
    ? await jobResult(jobId)
    : /already verified/i.test(output)
      ? "already verified"
      : `not submitted: ${output.trim().split("\n").pop()}`;
  if (!/match|already verified/.test(result)) failures++;
  console.log(`${name.padEnd(15)} ${address}  ${result}`);
  console.log(`  https://repo.sourcify.dev/296/${address}`);
}
process.exit(failures ? 1 : 0);
