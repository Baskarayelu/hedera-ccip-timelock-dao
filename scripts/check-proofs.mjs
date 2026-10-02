/**
 * Re-verifies every on-chain link in this repository's Markdown, so the evidence the docs cite stays true:
 *
 * - hashscan.io/testnet/transaction/0x…  the mirror node reports the contract call's result (SUCCESS by default)
 * - hashscan.io/testnet/schedule/0.0.…   the schedule exists and ran, with the expected result (SUCCESS by default)
 * - hashscan.io/testnet/contract/0x…     a contract exists at that address
 * - ccip.chain.link/msg/0x…              the CCIP explorer knows the message and its execution state (success by default)
 * - sepolia.basescan.org/tx/0x…          the Base Sepolia receipt has status 1
 * - sepolia.basescan.org/address/0x…     code exists at that address on Base Sepolia
 * - repo.sourcify.dev/<chain>/0x…         Sourcify holds an exact match of the contract's source
 *
 * Links that document a failure on purpose list their expected outcome in docs/proofs.json, either as the result
 * string or as { "result": …, "gasUsed": … } when the docs quote the gas a transaction used. A schedule can also
 * state { "gasLimit": …, "charged": … } (tinybar), which is how docs/costs.md proves what a scheduled call is billed.
 * Any Hedera or Base transaction can also list "logsContain": hex fragments (an event topic, an error selector,
 * an address) that must appear in its logs, so a link proves what happened and not only that it succeeded.
 *
 *   node scripts/check-proofs.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MIRROR =
  process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";
const BASE_RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const CCIP_API = "https://ccip.chain.link/api/h/atlas/message";

const PATTERNS = [
  {
    kind: "hedera-tx",
    re: /hashscan\.io\/testnet\/transaction\/(0x[0-9a-fA-F]{64})/g,
  },
  {
    kind: "hedera-schedule",
    re: /hashscan\.io\/testnet\/schedule\/(0\.0\.\d+)/g,
  },
  {
    kind: "hedera-contract",
    re: /hashscan\.io\/testnet\/contract\/(0x[0-9a-fA-F]{40}|0\.0\.\d+)/g,
  },
  { kind: "ccip-message", re: /ccip\.chain\.link\/msg\/(0x[0-9a-fA-F]{64})/g },
  { kind: "base-tx", re: /sepolia\.basescan\.org\/tx\/(0x[0-9a-fA-F]{64})/g },
  {
    kind: "base-address",
    re: /sepolia\.basescan\.org\/address\/(0x[0-9a-fA-F]{40})/g,
  },
  { kind: "sourcify", re: /repo\.sourcify\.dev\/(\d+\/0x[0-9a-fA-F]{40})/g },
];

const expectations = JSON.parse(
  readFileSync(new URL("../docs/proofs.json", import.meta.url), "utf8"),
).expect;

async function getJson(url, init) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res.json();
    if (res.status === 404 || attempt === 3) return { _status: res.status };
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

async function baseRpc(method, params) {
  const body = await getJson(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return body.result;
}

/** Missing fragments of `want` in a list of logs (topics and data, compared without 0x and case). */
function missingInLogs(logs, want = []) {
  const text = (logs ?? [])
    .map((l) => [...(l.topics ?? []), l.data ?? ""].join(""))
    .join("")
    .toLowerCase()
    .replaceAll("0x", "");
  const missing = want.filter(
    (w) => !text.includes(w.toLowerCase().replace(/^0x/, "")),
  );
  return missing.length ? `logs lack ${missing.join(", ")}` : null;
}

const checks = {
  async "hedera-tx"(hash, expected = "SUCCESS") {
    const want =
      typeof expected === "string"
        ? { result: expected }
        : { result: "SUCCESS", ...expected };
    const r = await getJson(`${MIRROR}/api/v1/contracts/results/${hash}`);
    if (r.result !== want.result)
      return `result ${r.result ?? `HTTP ${r._status}`}, expected ${want.result}`;
    if (want.gasUsed !== undefined && r.gas_used !== want.gasUsed)
      return `used ${r.gas_used} gas, docs say ${want.gasUsed}`;
    return missingInLogs(r.logs, want.logsContain);
  },
  async "hedera-schedule"(id, expected = "SUCCESS") {
    const want =
      typeof expected === "string"
        ? { result: expected }
        : { result: "SUCCESS", ...expected };
    const s = await getJson(`${MIRROR}/api/v1/schedules/${id}`);
    if (!s.schedule_id) return `not found (HTTP ${s._status})`;
    if (!s.executed_timestamp) return "has not executed";
    const t = await getJson(
      `${MIRROR}/api/v1/transactions?timestamp=${s.executed_timestamp}`,
    );
    const ran = t.transactions?.find((x) => x.scheduled) ?? t.transactions?.[0];
    if (ran?.result !== want.result)
      return `ran with ${ran?.result}, expected ${want.result}`;
    if (want.charged !== undefined && ran.charged_tx_fee !== want.charged)
      return `charged ${ran.charged_tx_fee} tinybar, docs say ${want.charged}`;
    if (
      want.gasUsed !== undefined ||
      want.gasLimit !== undefined ||
      want.logsContain
    ) {
      // A scheduled contract call's result is filed under the transaction id that created the schedule.
      const r = await getJson(
        `${MIRROR}/api/v1/contracts/results/${ran.transaction_id}?nonce=${ran.nonce}`,
      );
      if (want.gasUsed !== undefined && r.gas_used !== want.gasUsed)
        return `used ${r.gas_used} gas, docs say ${want.gasUsed}`;
      if (want.gasLimit !== undefined && r.gas_limit !== want.gasLimit)
        return `gas limit ${r.gas_limit}, docs say ${want.gasLimit}`;
      return missingInLogs(r.logs, want.logsContain);
    }
    return null;
  },
  async "hedera-contract"(address) {
    const c = await getJson(`${MIRROR}/api/v1/contracts/${address}`);
    return c.contract_id ? null : `no contract (HTTP ${c._status})`;
  },
  async "ccip-message"(id, expected = "success") {
    const m = await getJson(`${CCIP_API}/${id}`);
    const state =
      m.state === 2
        ? "success"
        : m.state === 3
          ? "failure"
          : m._status
            ? `HTTP ${m._status}`
            : "pending";
    return state === expected ? null : `state ${state}, expected ${expected}`;
  },
  async "base-tx"(hash, expected = {}) {
    const receipt = await baseRpc("eth_getTransactionReceipt", [hash]);
    if (receipt?.status !== "0x1")
      return `status ${receipt?.status ?? "missing"}`;
    return missingInLogs(receipt.logs, expected.logsContain);
  },
  async sourcify(id) {
    const [chain, address] = id.split("/");
    const c = await getJson(
      `https://sourcify.dev/server/v2/contract/${chain}/${address}`,
    );
    return c.match === "exact_match"
      ? null
      : `Sourcify match ${c.match ?? `none (HTTP ${c._status})`}`;
  },
  async "base-address"(address) {
    const code = await baseRpc("eth_getCode", [address, "latest"]);
    return code && code !== "0x" ? null : "no code";
  },
};

const files = execFileSync(
  "git",
  ["ls-files", "-co", "--exclude-standard", "*.md"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);
const links = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const { kind, re } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const key = `${kind} ${match[1].toLowerCase()}`;
      if (!links.has(key))
        links.set(key, { kind, id: match[1], files: new Set() });
      links.get(key).files.add(file);
    }
  }
}

let failures = 0;
for (const { kind, id, files: where } of links.values()) {
  const expected = expectations[id.toLowerCase()] ?? expectations[id];
  const problem = await checks[kind](id, expected);
  const label = `${kind} ${id}${expected ? ` (expect ${JSON.stringify(expected)})` : ""}`;
  if (problem) {
    failures++;
    console.error(`FAIL ${label}: ${problem}  [${[...where].join(", ")}]`);
  } else console.log(`ok   ${label}`);
}

console.log(
  `\n${links.size - failures} of ${links.size} on-chain links verified.`,
);
if (failures) process.exit(1);
