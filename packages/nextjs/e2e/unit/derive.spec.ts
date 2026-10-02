import { expect, test } from "@playwright/test";
import { type Abi, ContractFunctionExecutionError, ContractFunctionRevertedError, type Hex } from "viem";
import { daoGovernorAbi } from "~~/lib/dao/abis";
import { type Phase, deriveProposal } from "~~/lib/dao/derive";
import { decodeRevert } from "~~/lib/dao/errors";
import { SCENARIOS, T0 } from "~~/lib/dao/fixtures/scenarios";
import { revertDataOf } from "~~/lib/dao/live/source";
import { buildProposal, ccipMessage, describeActions, encodeRequest } from "~~/lib/dao/proposal";
import { timelockOperationId, timelockSalt } from "~~/lib/dao/source";
import { formatDuration } from "~~/lib/dao/time";
import { formatUnitsFixed, parseAmount } from "~~/lib/dao/units";

/** Every detail scenario must derive the phase its name promises. */
const EXPECTED: Record<string, Phase> = {
  pending: "pending",
  active: "active",
  activeNoPower: "active",
  queued: "queued",
  queueFailed: "queueFailed",
  inFlight: "inFlight",
  receiptPending: "receiptPending",
  done: "done",
  remoteFailed: "remoteFailed",
  expired: "expired",
  deliveryFailed: "deliveryFailed",
  feeAboveCap: "feeAboveCap",
  executionFailed: "executionFailed",
  executedLocal: "executedLocal",
  defeated: "defeated",
  noQuorum: "noQuorum",
  canceled: "canceled",
};

async function focusView(name: string) {
  const world = SCENARIOS[name]();
  const [overview, stats, records] = await Promise.all([
    world.overview(),
    world.network(),
    world.proposals(world.wallet.address ?? undefined),
  ]);
  const record = records[records.length - 1];
  return deriveProposal(record, {
    now: world.now(),
    overview,
    stats,
    addresses: world.addresses,
    liveFee: world.knobs.fee,
  });
}

for (const [name, phase] of Object.entries(EXPECTED)) {
  test(`scenario ${name} derives ${phase}`, async () => {
    const view = await focusView(name);
    expect(view.phase).toBe(phase);
  });
}

test("the queued scenario matches the design's times", async () => {
  const view = await focusView("queued");
  expect(view.banner.title).toBe("Executes itself at 14:28:10, in 1 min 12 s");
  expect(view.votes.forVotes).toBe("600");
  expect(view.votes.againstVotes).toBe("300");
  expect(view.votes.quorumLine).toBe("Quorum 40 of 1,000 vHGOV · reached");
  expect(view.votes.you.text).toBe("You voted For with 400 vHGOV.");
});

test("fee above cap names both amounts and keeps Execute now enabled", async () => {
  const view = await focusView("feeAboveCap");
  expect(view.banner.body).toContain("2.31 HBAR");
  expect(view.banner.body).toContain("2.00 HBAR");
  expect(view.fallback?.primary).toEqual({ enabled: true, kind: "execute", label: "Execute now" });
  expect(view.fallback?.body).toContain("FeeAboveCap(231000000, 200000000)");
});

test("a short treasury explains the shortfall", async () => {
  const view = await focusView("executionFailed");
  expect(view.banner.body).toContain("the treasury holds 0.40 HBAR");
  expect(view.banner.body).toContain("1.07 HBAR");
});

test("a failed remote call shows the decoded reason", async () => {
  const view = await focusView("remoteFailed");
  expect(view.banner.body).toContain("Receipt: Failed.");
  expect(view.banner.body).toContain("call 2 failed");
});

test("the receipt estimate is live finality plus measured CCIP time", async () => {
  const view = await focusView("receiptPending");
  // ran 14:28:45; finality lag 23 min (live) + median overhead 62 s
  expect(view.banner.body).toContain("23 min behind right now (live)");
  expect(view.banner.body).toContain("Expect the receipt around 14:52:47");
});

test("the list scenario has one proposal in each main state", async () => {
  const world = SCENARIOS.list();
  const [overview, stats, records] = await Promise.all([world.overview(), world.network(), world.proposals()]);
  const phases = records.map(
    r => deriveProposal(r, { now: world.now(), overview, stats, addresses: world.addresses }).phase,
  );
  expect(phases).toEqual(["noQuorum", "executedLocal", "done", "queued", "active"]);
  expect(world.now()).toBe(T0);
});

test("proposal building and decoding round-trip", () => {
  const addresses = SCENARIOS.list().addresses;
  const built = buildProposal(
    {
      title: "T",
      body: "B",
      feeCap: 200_000_000n,
      destGasLimit: 600_000n,
      actions: [
        { id: "1", kind: "hbar", to: "0x3f243741e066f6f9C061DF1B94E215921c321Bd7", amount: "5" },
        { id: "2", kind: "param", key: "protocol.feeBps", value: "30" },
      ],
    },
    addresses,
  );
  expect(built.values[0]).toBe(500_000_000n); // tinybar inside the EVM
  expect(built.targets[1]).toBe(addresses.timelock);
  const { actions, bundle } = describeActions(built, addresses);
  expect(actions.map(a => a.parts.map(p => p.text).join(""))).toEqual([
    "Send 5.00 HBAR to 0x3f24…1Bd7",
    "Set protocol.feeBps to 30",
  ]);
  expect(bundle?.feeCap).toBe(200_000_000n);
  expect(built.description).toBe("# T\n\nB");
});

test("the CCIP message matches the contract's encoding", () => {
  const message = ccipMessage("0x9b7691b0766a55d8509b07cb633ce281fee2a632", [], 600_000n, 1n);
  // GenericExtraArgsV2 tag, then abi.encode(gasLimit, allowOutOfOrderExecution = true)
  expect(message.extraArgs).toBe("0x181dcf10" + (600_000).toString(16).padStart(64, "0") + "1".padStart(64, "0"));
  expect(encodeRequest([], 1n).length).toBe(2 + 64 * 5);
});

test("timelock ids follow OpenZeppelin's salt", () => {
  // bytes20(governor) ^ descriptionHash: the governor fills the top 20 bytes.
  const governor = "0x00000000000000000000000000000000000a1b2c";
  expect(timelockSalt(governor, `0x${"ff".repeat(32)}`)).toBe(`0x${"ff".repeat(17)}f5e4d3${"ff".repeat(12)}`);
  expect(
    timelockOperationId(governor, { targets: [], values: [], calldatas: [], descriptionHash: `0x${"00".repeat(32)}` }),
  ).toMatch(/^0x[0-9a-f]{64}$/);
});

test("units and durations", () => {
  expect(parseAmount("1,000.5", 6)).toBe(1_000_500_000n);
  expect(parseAmount("1.1234567", 6)).toBeNull();
  expect(formatUnitsFixed(123_456_789n, 8)).toBe("1.23");
  expect(formatDuration(72)).toBe("1 min 12 s");
  expect(formatDuration(1354)).toBe("22 min");
});

test("a revert the governor's ABI does not know is still found and decoded before sending", () => {
  // Measured on testnet: Execute now on a proposal whose fee cap is below the quote. The timelock's
  // FeeAboveCap bubbles up through the governor, so viem cannot decode it with the governor's ABI and
  // keeps the bytes in `raw`.
  const raw: Hex =
    "0x7159abd80000000000000000000000000000000000000000000000000000000006c87aa40000000000000000000000000000000000000000000000000000000002faf080";
  const reverted = new ContractFunctionRevertedError({
    abi: daoGovernorAbi as Abi,
    data: raw,
    functionName: "execute",
  });
  const error = new ContractFunctionExecutionError(reverted, {
    abi: daoGovernorAbi as Abi,
    functionName: "execute",
    args: [[], [], [], `0x${"00".repeat(32)}`],
  });
  expect(revertDataOf(error)).toBe(raw);
  expect(decodeRevert(revertDataOf(error)).name).toBe("FeeAboveCap");
  // The RPC error underneath carries it in `data`.
  expect(revertDataOf({ cause: { data: raw } })).toBe(raw);
});
