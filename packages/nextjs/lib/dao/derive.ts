import { VOTE_SYMBOL, explorer } from "./config";
import { decodeRevert, hederaCodeName, revertSignature } from "./errors";
import {
  type CrossChainBundle,
  type DaoAddresses,
  crossChainBundle,
  hederaValueTotal,
  splitDescription,
} from "./proposal";
import { formatClock, formatDuration, formatWhen, median } from "./time";
import {
  AutoAction,
  type CrossChainRecord,
  type DaoOverview,
  type GovernorEvent,
  type NetworkStats,
  type ProposalRecord,
  ProposalState,
  RemoteStatus,
  VoteSupport,
} from "./types";
import { formatHbar, formatVotes, shortAddress, shortHash } from "./units";

/**
 * Seconds after a callback's due time before we treat "no sign of it on the mirror node" as a failure.
 * HSS fires within a second; the mirror node usually shows it within a few more.
 */
export const CALLBACK_GRACE = 45;

export type Phase =
  | "pending"
  | "active"
  | "defeated"
  | "noQuorum"
  | "canceled"
  | "queueing"
  | "queueFailed"
  | "queued"
  | "executing"
  | "feeAboveCap"
  | "executionFailed"
  | "executedLocal"
  | "inFlight"
  | "deliveryFailed"
  | "receiptPending"
  | "done"
  | "remoteFailed"
  | "expired";

export type Tone = "ok" | "info" | "warn" | "bad" | "neutral";
export type Chip = "Pending" | "Active" | "Passed" | "Queued" | "Executed" | "Defeated" | "Canceled";
export type StepStatus = "done" | "next" | "later" | "failed" | "stopped";
export type Link = { label: string; href: string };
export type TimelineStep = {
  key: string;
  title: string;
  time: string;
  detail: string;
  status: StepStatus;
  link?: Link;
};

/** Everything a proposal's views need besides the record itself. */
export type DeriveContext = {
  now: number;
  overview: DaoOverview;
  stats: NetworkStats | null;
  addresses: DaoAddresses;
  /** Live CCIP fee quote for the proposal's Base batch (tinybar), when it has one and it was fetched. */
  liveFee?: bigint | null;
};

const lastOf = <K extends GovernorEvent["kind"]>(
  events: GovernorEvent[],
  kind: K,
  action?: AutoAction,
): Extract<GovernorEvent, { kind: K }> | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === kind && (action === undefined || ("action" in e && e.action === action))) {
      return e as Extract<GovernorEvent, { kind: K }>;
    }
  }
  return undefined;
};

const after = (e: GovernorEvent | undefined, ref: GovernorEvent | undefined) =>
  !!e && (!ref || e.tx.timestamp >= ref.tx.timestamp);

/** Why a network callback did not do its job, or null if it did or has not had its chance yet. */
export type CallbackOutcome =
  | { kind: "pending"; at: number }
  | { kind: "overdue"; at: number }
  | {
      kind: "failed";
      at: number;
      reason: string;
      signature: string;
      revertName: string;
      revertArgs: readonly unknown[];
    }
  | { kind: "unfunded"; at: number; result: string }
  | { kind: "unavailable"; responseCode: number }
  | { kind: "none" };

export function callbackOutcome(p: ProposalRecord, action: AutoAction, now: number): CallbackOutcome {
  const armed = lastOf(p.events, "armed", action);
  const failed = lastOf(p.events, "failed", action);
  const unavailable = lastOf(p.events, "unavailable", action);
  const skipped = lastOf(p.events, "skipped", action);
  if (after(failed, armed) && failed) {
    const decoded = decodeRevert(failed.reason);
    return {
      kind: "failed",
      at: failed.tx.timestamp,
      reason: decoded.text,
      signature: revertSignature(decoded),
      revertName: decoded.name,
      revertArgs: decoded.args,
    };
  }
  if (after(skipped, armed) && skipped) {
    return {
      kind: "failed",
      at: skipped.tx.timestamp,
      reason: "it ran before the proposal was ready, so it skipped",
      signature: "",
      revertName: "",
      revertArgs: [],
    };
  }
  if (!armed) return unavailable ? { kind: "unavailable", responseCode: unavailable.responseCode } : { kind: "none" };
  if (after(unavailable, armed) && unavailable) return { kind: "unavailable", responseCode: unavailable.responseCode };
  const schedule = p.schedules[action];
  if (schedule?.result && schedule.result !== "SUCCESS") {
    return { kind: "unfunded", at: schedule.executedAt ?? armed.at, result: schedule.result };
  }
  if (armed.at + CALLBACK_GRACE > now) return { kind: "pending", at: armed.at };
  return { kind: "overdue", at: armed.at };
}

const quorumCounted = (p: ProposalRecord) => p.votes.for + p.votes.abstain;

export function proposalPhase(p: ProposalRecord, ctx: Pick<DeriveContext, "now" | "addresses">): Phase {
  const { now } = ctx;
  switch (p.state) {
    case ProposalState.Pending:
      return "pending";
    case ProposalState.Active:
      return "active";
    case ProposalState.Canceled:
      return "canceled";
    case ProposalState.Expired:
    case ProposalState.Defeated:
      return quorumCounted(p) < p.quorum ? "noQuorum" : "defeated";
    case ProposalState.Succeeded: {
      const outcome = callbackOutcome(p, AutoAction.Queue, now);
      return outcome.kind === "pending" ? "queueing" : "queueFailed";
    }
    case ProposalState.Queued: {
      const armed = lastOf(p.events, "armed", AutoAction.Execute);
      const dueAt = armed?.at ?? p.eta;
      if (now < dueAt) return "queued";
      const outcome = callbackOutcome(p, AutoAction.Execute, now);
      if (outcome.kind === "failed" && outcome.revertName === "FeeAboveCap") return "feeAboveCap";
      if (outcome.kind === "pending") return "executing";
      return "executionFailed";
    }
    case ProposalState.Executed: {
      const bundle = crossChainBundle(p, ctx.addresses.timelock);
      if (!bundle) return "executedLocal";
      const message = p.crossChain[0];
      if (!message) return "inFlight";
      const status = message.receipt?.status ?? message.remote?.status;
      if (status === RemoteStatus.Executed) return message.receipt ? "done" : "receiptPending";
      if (status === RemoteStatus.Failed) return "remoteFailed";
      if (status === RemoteStatus.Expired) return "expired";
      if (message.delivery?.state === "failed") return "deliveryFailed";
      return "inFlight";
    }
  }
}

export const CHIP: Record<Phase, Chip> = {
  pending: "Pending",
  active: "Active",
  defeated: "Defeated",
  noQuorum: "Defeated",
  canceled: "Canceled",
  queueing: "Passed",
  queueFailed: "Passed",
  queued: "Queued",
  executing: "Queued",
  feeAboveCap: "Queued",
  executionFailed: "Queued",
  executedLocal: "Executed",
  inFlight: "Executed",
  deliveryFailed: "Executed",
  receiptPending: "Executed",
  done: "Executed",
  remoteFailed: "Executed",
  expired: "Executed",
};

export function whereLabel(p: ProposalRecord, addresses: DaoAddresses): string {
  const bundle = crossChainBundle(p, addresses.timelock);
  if (!bundle) return "Hedera";
  return p.targets.length > 1 ? "Hedera + Base Sepolia via CCIP" : "Base Sepolia via CCIP";
}

// ---------------------------------------------------------------------------------------------
// Estimates (all from live data; null when there is nothing to measure yet)
// ---------------------------------------------------------------------------------------------

/** Median seconds from a Hedera send to execution on Base, over this DAO's recent requests. */
export const deliveryEstimate = (stats: NetworkStats | null) => (stats ? median(stats.deliverySeconds) : null);

/**
 * Expected wait for a receipt that has not landed yet, in seconds after the remote execution. CCIP first
 * waits for Base Sepolia to finalize the block (the live finality lag), then commits and executes on
 * Hedera; recent receipts show how long that second part took (their landing time minus their source
 * block's finality, from the CCIP explorer).
 */
export function receiptEta(stats: NetworkStats | null): number | null {
  const lag = stats?.baseFinalityLag ?? null;
  if (lag === null) return null;
  // The explorer records finality when it observes it, so the overhead can come out a second negative.
  return lag + Math.max(0, median(stats?.receiptOverheadSeconds ?? []) ?? 0);
}

export function finalityText(stats: NetworkStats | null): string {
  if (stats?.baseFinalityLag == null) return "Base Sepolia finality could not be read right now.";
  return `Base Sepolia finality is ${formatDuration(stats.baseFinalityLag)} behind right now (live).`;
}

export function deliveryText(stats: NetworkStats | null): string {
  const d = deliveryEstimate(stats);
  if (d === null) return "No delivery from this DAO has been measured yet.";
  return `Hedera to Base has taken ${formatDuration(d)} lately (median of this DAO’s recent receipts).`;
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

export type Banner = { tone: Tone; title: string; body: string };

export type VotesView = {
  forVotes: string;
  againstVotes: string;
  abstainVotes: string;
  forPct: number;
  againstPct: number;
  quorumLine: string;
  window: string;
  you: { text: string; tone: "accent" | "warn" | "neutral" };
  canVote: boolean;
  showButtons: boolean;
};

export type FallbackView = {
  emphasis: "quiet" | "warn" | "bad";
  title: string;
  body: string;
  rearm: { enabled: boolean; action: AutoAction };
  primary: { enabled: boolean; kind: "queue" | "execute"; label: string };
};

export type ProposalView = {
  phase: Phase;
  chip: Chip;
  title: string;
  body: string;
  where: string;
  bundle: CrossChainBundle | null;
  message: CrossChainRecord | undefined;
  banner: Banner;
  /** One line for the proposals list. */
  next: string;
  listQuorum: string;
  votes: VotesView;
  timeline: TimelineStep[];
  /** Null once no network call is ahead (finished, defeated or cancelled). */
  fallback: FallbackView | null;
  canCancel: boolean;
};

const pct = (part: bigint, total: bigint) => (total === 0n ? 0 : Number((part * 10000n) / total) / 100);

function votesView(p: ProposalRecord, phase: Phase, ctx: DeriveContext): VotesView {
  const { now } = ctx;
  const decided = p.votes.for + p.votes.against;
  const counted = quorumCounted(p);
  const supply = p.supplyAtSnapshot;
  const quorumBase = `Quorum ${formatVotes(p.quorum)}${supply !== null ? ` of ${formatVotes(supply)}` : ""} ${VOTE_SYMBOL}`;
  let quorumLine: string;
  if (p.state === ProposalState.Pending) quorumLine = `${quorumBase} (if the snapshot were now)`;
  else if (counted >= p.quorum) quorumLine = `${quorumBase} · reached`;
  else if (p.state === ProposalState.Active) quorumLine = `${quorumBase} · ${formatVotes(counted)} so far`;
  else quorumLine = `${quorumBase} · not reached (${formatVotes(counted)})`;
  if (p.state === ProposalState.Canceled) quorumLine = quorumBase;

  let window: string;
  if (p.state === ProposalState.Canceled && (lastOf(p.events, "canceled")?.tx.timestamp ?? 0) < p.voteStart) {
    window = "Cancelled before voting opened";
  } else if (now < p.voteStart) window = `Snapshot ${formatWhen(p.voteStart, now)} · voting opens then`;
  else if (now <= p.voteEnd) window = `Snapshot ${formatWhen(p.voteStart, now)} · closes ${formatWhen(p.voteEnd, now)}`;
  else window = `Counted at snapshot ${formatWhen(p.voteStart, now)} · voting closed ${formatWhen(p.voteEnd, now)}`;

  const viewer = p.viewer;
  const supportName = (s: VoteSupport) =>
    s === VoteSupport.For ? "For" : s === VoteSupport.Against ? "Against" : "Abstain";
  let you: VotesView["you"];
  let canVote = false;
  if (!viewer) you = { text: "Connect a wallet to see your voting power for this proposal.", tone: "neutral" };
  else if (viewer.vote) {
    you = {
      text: `You voted ${supportName(viewer.vote.support)} with ${formatVotes(viewer.vote.weight)} ${VOTE_SYMBOL}.`,
      tone: "accent",
    };
  } else if (phase === "pending") {
    you = {
      text: `Your votes are read at the snapshot (${formatWhen(p.voteStart, now)}). You have ${formatVotes(viewer.votingPower)} ${VOTE_SYMBOL} of voting power now.`,
      tone: "neutral",
    };
  } else if (phase === "active" && viewer.votingPower > 0n) {
    you = {
      text: `Your voting power at the snapshot: ${formatVotes(viewer.votingPower)} ${VOTE_SYMBOL}.`,
      tone: "accent",
    };
    canVote = true;
  } else if (phase === "active") {
    you = {
      text: `You had no delegated votes at the snapshot (${formatWhen(p.voteStart, now)}), so you cannot vote on this one. Wrap and delegate now to vote on the next proposal.`,
      tone: "warn",
    };
  } else you = { text: "You did not vote on this proposal.", tone: "neutral" };

  return {
    forVotes: formatVotes(p.votes.for),
    againstVotes: formatVotes(p.votes.against),
    abstainVotes: formatVotes(p.votes.abstain),
    forPct: pct(p.votes.for, decided),
    againstPct: pct(p.votes.against, decided),
    quorumLine,
    window,
    you,
    canVote,
    showButtons: phase === "active" && !viewer?.vote,
  };
}

/** HBAR the treasury must hold when the proposal executes: its Hedera values plus the CCIP fee. */
function treasuryNeed(p: ProposalRecord, fee: bigint | null | undefined) {
  return hederaValueTotal(p) + (fee ?? 0n);
}

function failureBody(
  p: ProposalRecord,
  action: AutoAction,
  outcome: CallbackOutcome,
  ctx: DeriveContext,
  bundle: CrossChainBundle | null,
): string {
  const { overview, now } = ctx;
  if (outcome.kind === "unfunded") {
    const need = overview.rules.autoGas[action] * overview.gasPrice;
    return `When it fired at ${formatWhen(outcome.at, now)} the network reported ${outcome.result}: the governor’s callback float could not cover ${formatHbar(need)} of gas. It holds ${formatHbar(overview.floatHbar)} now.`;
  }
  if (outcome.kind === "unavailable") {
    return `The network could not be scheduled to do it (${hederaCodeName(outcome.responseCode)}).`;
  }
  if (outcome.kind === "overdue") {
    return `It was due at ${formatWhen(outcome.at, now)} and has not run.`;
  }
  if (outcome.kind === "failed") {
    const need = treasuryNeed(p, bundle ? (ctx.liveFee ?? null) : 0n);
    if (outcome.revertName === "FailedCall" && action === AutoAction.Execute && overview.treasuryHbar < need) {
      const parts = [
        hederaValueTotal(p) ? `${formatHbar(hederaValueTotal(p))} in transfers` : "",
        bundle && ctx.liveFee ? `the ${formatHbar(ctx.liveFee)} CCIP fee` : "",
      ].filter(Boolean);
      return `At ${formatWhen(outcome.at, now)}: the treasury holds ${formatHbar(overview.treasuryHbar)}, less than the ${formatHbar(need)} this proposal spends (${parts.join(" plus ")}). Top up the treasury, then execute.`;
    }
    return `At ${formatWhen(outcome.at, now)}: ${outcome.reason}.${outcome.signature ? ` (${outcome.signature})` : ""}`;
  }
  return "";
}

function timeline(
  p: ProposalRecord,
  phase: Phase,
  ctx: DeriveContext,
  bundle: CrossChainBundle | null,
): TimelineStep[] {
  const { now, addresses } = ctx;
  const ev = p.events;
  const armedQueue = ev.find(e => e.kind === "armed" && e.action === AutoAction.Queue);
  const unavailableQueue = ev.find(e => e.kind === "unavailable" && e.action === AutoAction.Queue);
  const queued = lastOf(ev, "queued");
  const queuedByNetwork = lastOf(ev, "done", AutoAction.Queue);
  const executed = lastOf(ev, "executed");
  const executedByNetwork = lastOf(ev, "done", AutoAction.Execute);
  const message = p.crossChain[0];
  const scheduleLink = (action: AutoAction): Link | undefined => {
    const s = p.schedules[action];
    return s
      ? {
          label: `HashScan: ${action === AutoAction.Queue ? "queue" : "execute"} schedule ↗`,
          href: explorer.hederaSchedule(s.id),
        }
      : undefined;
  };

  const steps: TimelineStep[] = [
    {
      key: "proposed",
      title: "Proposed",
      time: formatWhen(p.created.timestamp, now),
      detail: armedQueue
        ? "Also scheduled the network to queue it when voting ends."
        : unavailableQueue && unavailableQueue.kind === "unavailable"
          ? `The network could not be scheduled to queue it (${hederaCodeName(unavailableQueue.responseCode)}); anyone can queue it after the vote.`
          : "Created on Hedera.",
      status: "done",
      link: { label: "HashScan: proposal tx ↗", href: explorer.hederaTx(p.created.hash) },
    },
    {
      key: "voting",
      title: "Voting",
      time: `${formatWhen(p.voteStart, now)}–${formatClock(p.voteEnd)}`,
      detail: "Weights read at the snapshot.",
      status: "later",
    },
    {
      key: "queued",
      title: queuedByNetwork || !queued ? "Queued by the network" : "Queued",
      time: queued ? formatWhen(queued.tx.timestamp, now) : "",
      detail: queued
        ? queuedByNetwork
          ? "Ran with no keeper. Timelock started."
          : "Queued by hand after the network’s call did not. Timelock started."
        : "The network queues it one moment after voting ends, if it passed.",
      status: "later",
      link: queued
        ? (queuedByNetwork && scheduleLink(AutoAction.Queue)) || {
            label: "HashScan: queue tx ↗",
            href: explorer.hederaTx(queued.tx.hash),
          }
        : undefined,
    },
    {
      key: "executed",
      title: executed && !executedByNetwork ? "Executed" : "Executed by the network",
      time: executed ? formatWhen(executed.tx.timestamp, now) : "",
      detail: executed
        ? executedByNetwork
          ? "Paid from the callback float."
          : "Executed by hand after the network’s call did not."
        : bundle
          ? "Sends the Base actions in one CCIP message."
          : "Runs the actions from the treasury.",
      status: "later",
      link: executed
        ? (executedByNetwork && scheduleLink(AutoAction.Execute)) || {
            label: "HashScan: execute tx ↗",
            href: explorer.hederaTx(executed.tx.hash),
          }
        : undefined,
    },
  ];
  if (bundle) {
    steps.push(
      {
        key: "sent",
        title: "CCIP message sent",
        time: message ? formatWhen(message.sent.timestamp, now) : "",
        detail: message
          ? `Fee quoted at execution: ${formatHbar(message.fee)}.`
          : `Fee cap ${formatHbar(bundle.feeCap)}.`,
        status: "later",
        link: message
          ? { label: `CCIP Explorer: ${shortHash(message.messageId)} ↗`, href: explorer.ccipMessage(message.messageId) }
          : undefined,
      },
      {
        key: "remote",
        title: "Ran on Base Sepolia",
        time: message?.remote ? formatWhen(message.remote.tx.timestamp, now) : "",
        detail: `From the DAO’s account ${shortAddress(addresses.remoteAccount)}.`,
        status: "later",
        link: message?.remote ? { label: "Basescan ↗", href: explorer.baseTx(message.remote.tx.hash) } : undefined,
      },
      {
        key: "receipt",
        title: "Receipt back on Hedera",
        time: message?.receipt ? formatWhen(message.receipt.tx.timestamp, now) : "",
        detail: "Recorded by the timelock.",
        status: "later",
        link: message?.receipt
          ? { label: "HashScan: receipt tx ↗", href: explorer.hederaTx(message.receipt.tx.hash) }
          : undefined,
      },
    );
  }

  // Progress: how many steps are complete, and which one failed or stopped the rest.
  const progress: Record<Phase, number> = {
    pending: 1,
    active: 1,
    canceled: 1,
    defeated: 2,
    noQuorum: 2,
    queueing: 2,
    queueFailed: 2,
    queued: 3,
    executing: 3,
    feeAboveCap: 3,
    executionFailed: 3,
    executedLocal: 4,
    inFlight: 5,
    deliveryFailed: 5,
    receiptPending: 6,
    remoteFailed: message?.receipt ? 7 : 6,
    expired: message?.receipt ? 7 : 6,
    done: 7,
  };
  const failedAt: Partial<Record<Phase, number>> = {
    queueFailed: 2,
    feeAboveCap: 3,
    executionFailed: 3,
    deliveryFailed: 5,
    remoteFailed: 5,
    expired: 5,
  };
  const stopAt: Partial<Record<Phase, number>> = { canceled: 1, defeated: 2, noQuorum: 2 };
  const done = progress[phase];
  steps.forEach((step, i) => {
    if (failedAt[phase] === i) step.status = "failed";
    else if (stopAt[phase] !== undefined && i >= stopAt[phase]!) step.status = "stopped";
    else if (i < done) step.status = "done";
    else if (i === done) step.status = "next";
    else step.status = "later";
    if (step.status !== "done" && step.status !== "failed") {
      step.time = "";
      step.link = undefined;
    }
  });
  // A failed attempt shows when the network ran it and links its schedule, the record of what happened.
  const attempt = (action: AutoAction) => {
    const ranAt = p.schedules[action]?.executedAt;
    return { time: ranAt ? formatWhen(ranAt, now) : "", link: scheduleLink(action) };
  };
  if (failedAt[phase] === 2) {
    steps[2].title = "Queue attempt failed";
    steps[2].detail = "The reason is shown above; it can still be queued.";
    Object.assign(steps[2], attempt(AutoAction.Queue));
  }
  if (failedAt[phase] === 3) {
    steps[3].title = "Execution attempt failed";
    steps[3].detail = "The reason is shown above; the proposal stays queued.";
    Object.assign(steps[3], attempt(AutoAction.Execute));
  }
  if (phase === "remoteFailed" || phase === "expired") {
    steps[5].detail = "The DAO’s account did not run the calls.";
    if (message?.remote) {
      steps[5].time = formatWhen(message.remote.tx.timestamp, now);
      steps[5].link = { label: "Basescan ↗", href: explorer.baseTx(message.remote.tx.hash) };
    }
    steps[6].detail = message?.receipt ? "Recorded by the timelock with the reason." : "On its way back to Hedera.";
  }
  if (phase === "deliveryFailed") {
    steps[5].title = "Not run on Base Sepolia";
    steps[5].detail = "CCIP delivered it, but the executor reverted on receipt.";
  }
  if (stopAt[phase] === 2) {
    steps[2].title = "Not queued";
    steps[2].detail = "The network checked and skipped it.";
    const skipped = lastOf(ev, "skipped", AutoAction.Queue);
    if (skipped) steps[2].time = formatWhen(skipped.tx.timestamp, now);
  }
  if (phase === "canceled") {
    steps[1].detail = "Cancelled before it could pass.";
  }
  return steps;
}

/** Phases with a network callback still ahead, where the quiet "if it fails" panel is useful. */
const CALLBACK_AHEAD = new Set<Phase>(["pending", "active", "queueing", "queued", "executing"]);

function fallbackView(
  p: ProposalRecord,
  phase: Phase,
  outcome: CallbackOutcome | null,
  ctx: DeriveContext,
): FallbackView | null {
  const { now } = ctx;
  const quiet: FallbackView = {
    emphasis: "quiet",
    title: "If the network’s call fails",
    body: "A scheduled call runs once. If it fails, the reason shows here and anyone can take over.",
    rearm: { enabled: false, action: AutoAction.Execute },
    primary: { enabled: false, kind: "execute", label: "Execute now" },
  };
  const armedAt = (action: AutoAction) => lastOf(p.events, "armed", action)?.at ?? 0;
  if (phase === "queueFailed") {
    return {
      emphasis: "bad",
      title: "Anyone can take over",
      body: "Voting passed, so it can be queued. Queue it now, or schedule the network to try again.",
      rearm: { enabled: armedAt(AutoAction.Queue) < now, action: AutoAction.Queue },
      primary: { enabled: true, kind: "queue", label: "Queue now" },
    };
  }
  if (phase === "feeAboveCap" && outcome?.kind === "failed") {
    // While the live quote is still above the cap, a scheduled retry would stop the same way and cost HBAR for
    // nothing; Execute now stays available because it is checked before anything is sent.
    const cap = crossChainBundle(p, ctx.addresses.timelock)?.feeCap ?? 0n;
    const stillHigh = ctx.liveFee != null && ctx.liveFee > cap;
    return {
      emphasis: "warn",
      title: "Execution is waiting on the fee",
      body: stillHigh
        ? `The network’s call at ${formatWhen(outcome.at, now)} stopped with ${outcome.signature}. The fee is still above the cap, so a retry would stop the same way: execute it once the fee drops.`
        : `The network’s call at ${formatWhen(outcome.at, now)} stopped with ${outcome.signature}. Execute now, or schedule the network to try again.`,
      rearm: { enabled: !stillHigh && armedAt(AutoAction.Execute) < now, action: AutoAction.Execute },
      primary: { enabled: true, kind: "execute", label: "Execute now" },
    };
  }
  if (phase === "executionFailed") {
    return {
      emphasis: "bad",
      title: "Anyone can take over",
      body: "The proposal is still queued and ready. Execute it now, or schedule the network to try again.",
      rearm: { enabled: armedAt(AutoAction.Execute) < now, action: AutoAction.Execute },
      primary: { enabled: true, kind: "execute", label: "Execute now" },
    };
  }
  return CALLBACK_AHEAD.has(phase) ? quiet : null;
}

export function deriveProposal(p: ProposalRecord, ctx: DeriveContext): ProposalView {
  const { now, stats, overview } = ctx;
  const phase = proposalPhase(p, ctx);
  const { title, body } = splitDescription(p.description);
  const bundle = crossChainBundle(p, ctx.addresses.timelock);
  const message = p.crossChain[0];
  const armedQueue = lastOf(p.events, "armed", AutoAction.Queue);
  const armedExecute = lastOf(p.events, "armed", AutoAction.Execute);
  const executed = lastOf(p.events, "executed");
  const canceled = lastOf(p.events, "canceled");
  const queueOutcome = phase === "queueFailed" ? callbackOutcome(p, AutoAction.Queue, now) : null;
  const executeOutcome =
    phase === "feeAboveCap" || phase === "executionFailed" ? callbackOutcome(p, AutoAction.Execute, now) : null;
  const executeAt = armedExecute?.at ?? p.eta;
  const remoteReason = () => {
    const data = message?.receipt?.revertData ?? message?.remote?.revertData;
    const decoded = decodeRevert(data);
    return `${decoded.text}${decoded.name ? ` (${revertSignature(decoded)})` : ""}`;
  };

  let banner: Banner;
  let next: string;
  switch (phase) {
    case "pending":
      banner = {
        tone: "info",
        title: `Voting opens at ${formatWhen(p.voteStart, now)}`,
        body: "Votes are read at that moment (the snapshot). Wrap and delegate before then to vote on it.",
      };
      next = `Voting opens ${formatWhen(p.voteStart, now)}.`;
      break;
    case "active":
      banner = {
        tone: "info",
        title: `Voting is open until ${formatWhen(p.voteEnd, now)}`,
        body: armedQueue
          ? "When voting closes the network queues it automatically if it passed."
          : "The network could not be scheduled to queue it, so after voting closes anyone can queue it from this page.",
      };
      next = armedQueue
        ? `Voting ends ${formatWhen(p.voteEnd, now)}. The network queues it at ${formatClock(armedQueue.at)} if it passes.`
        : `Voting ends ${formatWhen(p.voteEnd, now)}.`;
      break;
    case "defeated": {
      const skipped = lastOf(p.events, "skipped", AutoAction.Queue);
      banner = {
        tone: "neutral",
        title: "Defeated: more votes against than for",
        body: `${formatVotes(p.votes.for)} for, ${formatVotes(p.votes.against)} against. ${
          skipped
            ? `The network checked at ${formatWhen(skipped.tx.timestamp, now)} and did not queue it.`
            : "It will not be queued."
        }`,
      };
      next = skipped ? "More votes against. The network skipped queueing." : "More votes against.";
      break;
    }
    case "noQuorum": {
      const skipped = lastOf(p.events, "skipped", AutoAction.Queue);
      const numerator = overview.rules.quorumNumerator;
      const share =
        overview.rules.quorumDenominator === 100n
          ? `${numerator}%`
          : `${numerator}/${overview.rules.quorumDenominator}`;
      banner = {
        tone: "neutral",
        title: "Defeated: quorum not reached",
        body: `${formatVotes(quorumCounted(p))} ${VOTE_SYMBOL} counted toward quorum; ${formatVotes(p.quorum)} were needed (${share} of the ${formatVotes(
          p.supplyAtSnapshot ?? 0n,
        )} ${VOTE_SYMBOL} at the snapshot). ${skipped ? "The network did not queue it." : "It will not be queued."}`,
      };
      next = skipped ? "Quorum not reached. The network skipped queueing." : "Quorum not reached.";
      break;
    }
    case "canceled": {
      const cancelled = lastOf(p.events, "cancelled", AutoAction.Queue);
      banner = {
        tone: "neutral",
        title: `Cancelled by the proposer${canceled ? ` at ${formatWhen(canceled.tx.timestamp, now)}` : ""}`,
        body:
          cancelled && cancelled.responseCode === 22
            ? "The network’s scheduled queue call was deleted at the same time, so it will not run."
            : "Nothing will be queued or executed.",
      };
      next = "Cancelled by the proposer.";
      break;
    }
    case "queueing":
      banner = {
        tone: "warn",
        title: `Passed. The network queues it at ${formatWhen(armedQueue?.at ?? p.voteEnd, now)}`,
        body: "The schedule service calls the governor at that second, which starts the timelock. Nobody needs to do anything.",
      };
      next = `Passed. The network queues it at ${formatClock(armedQueue?.at ?? p.voteEnd)}.`;
      break;
    case "queueFailed":
      banner = {
        tone: "bad",
        title: "The network’s queue call did not queue it",
        body: queueOutcome ? failureBody(p, AutoAction.Queue, queueOutcome, ctx, bundle) : "",
      };
      next = "The network’s queue call failed. Anyone can take over.";
      break;
    case "queued":
      banner = {
        tone: "warn",
        title: `Executes itself at ${formatWhen(executeAt, now)}, in ${formatDuration(executeAt - now)}`,
        body: armedExecute
          ? bundle
            ? "The network will run it and send one CCIP message to Base Sepolia. Nobody needs to do anything."
            : "The network will run it on Hedera. Nobody needs to do anything."
          : "The network could not be scheduled to execute it, so once the timelock ends anyone can execute it from this page.",
      };
      next = `Executes itself at ${formatClock(executeAt)}, in ${formatDuration(executeAt - now)}.`;
      break;
    case "executing":
      banner = {
        tone: "info",
        title: "Executing now",
        body: `The network’s call was due at ${formatWhen(executeAt, now)}. Waiting for the mirror node to show it.`,
      };
      next = "Executing now.";
      break;
    case "feeAboveCap": {
      const cap = bundle?.feeCap ?? 0n;
      const fee = ctx.liveFee;
      banner = {
        tone: "warn",
        title: "Waiting: the CCIP fee is above the cap you voted for",
        body:
          fee == null
            ? `This proposal allows at most ${formatHbar(cap)}. Anyone can execute it once the fee drops.`
            : fee > cap
              ? `The fee is ${formatHbar(fee)} right now (live quote); this proposal allows at most ${formatHbar(cap)}. Anyone can execute it once the fee drops.`
              : `The fee is ${formatHbar(fee)} right now (live quote), within the ${formatHbar(cap)} cap, so it can be executed now.`,
      };
      next = "Waiting: the CCIP fee is above the voted cap.";
      break;
    }
    case "executionFailed":
      banner = {
        tone: "bad",
        title: "The network’s execution call failed",
        body: executeOutcome ? failureBody(p, AutoAction.Execute, executeOutcome, ctx, bundle) : "",
      };
      next = "The network’s execution call failed. Anyone can take over.";
      break;
    case "executedLocal":
      banner = {
        tone: "ok",
        title: `Executed on Hedera at ${executed ? formatWhen(executed.tx.timestamp, now) : "—"}`,
        body: lastOf(p.events, "done", AutoAction.Execute)
          ? "The network ran it when the timelock ended, with no keeper."
          : "It was executed by hand after the timelock ended.",
      };
      next = `Executed${lastOf(p.events, "done", AutoAction.Execute) ? " by the network" : ""} at ${
        executed ? formatWhen(executed.tx.timestamp, now) : "—"
      }.`;
      break;
    case "inFlight": {
      const expiredInTransit = message && now > message.validUntil;
      banner = {
        tone: "info",
        title: `Sent to Base Sepolia${message ? ` at ${formatWhen(message.sent.timestamp, now)}` : ""}, not delivered yet`,
        body: message
          ? `CCIP message ${shortHash(message.messageId)}. ${deliveryText(stats)}${
              expiredInTransit
                ? ` Its window ended at ${formatWhen(message.validUntil, now)}, so the DAO’s account will refuse it when it arrives.`
                : ""
            }`
          : "The message id appears once the mirror node shows the execution.",
      };
      next = `Sent to Base Sepolia${message ? ` at ${formatWhen(message.sent.timestamp, now)}` : ""}; not delivered yet.`;
      break;
    }
    case "deliveryFailed":
      banner = {
        tone: "bad",
        title: "CCIP could not run it on Base Sepolia",
        body: `The executor reverted while receiving the message, most likely out of the ${bundle?.destGasLimit.toLocaleString("en-US")} gas this proposal set. Anyone can retry it with more gas through manual execution in the CCIP explorer.`,
      };
      next = "CCIP could not run it on Base Sepolia.";
      break;
    case "receiptPending": {
      const eta = receiptEta(stats);
      const ranAt = message?.remote?.tx.timestamp ?? message?.delivery?.timestamp;
      banner = {
        tone: "info",
        title: `Ran on Base Sepolia${ranAt ? ` at ${formatWhen(ranAt, now)}` : ""}. Receipt on its way.`,
        body: `${finalityText(stats)}${
          eta !== null && ranAt
            ? ` Expect the receipt around ${formatWhen(ranAt + eta, now)}${
                stats?.receiptOverheadSeconds.length ? "" : " plus CCIP processing (no receipt measured yet)"
              }.`
            : ""
        }`,
      };
      next = `Ran on Base Sepolia${ranAt ? ` at ${formatWhen(ranAt, now)}` : ""}; receipt on its way.`;
      break;
    }
    case "done": {
      const receipt = message!.receipt!;
      banner = {
        tone: "ok",
        title: `Done: executed on Base Sepolia, receipt received on Hedera at ${formatWhen(receipt.tx.timestamp, now)}`,
        body: `The calls succeeded from the DAO’s account. The receipt took ${formatDuration(
          receipt.tx.timestamp - receipt.executedAt,
        )} after execution, mostly waiting for Base Sepolia finality.`,
      };
      next = `Receipt back on Hedera at ${formatWhen(receipt.tx.timestamp, now)}: executed on Base Sepolia.`;
      break;
    }
    case "remoteFailed":
      banner = {
        tone: "bad",
        title: "Delivered, but the calls failed on Base Sepolia",
        body: `${message?.receipt ? "Receipt: Failed." : "Base reports: Failed; the receipt is on its way."} Reason: ${remoteReason()}. Nothing changed on Base; a new proposal is needed.`,
      };
      next = "Delivered, but the calls failed on Base Sepolia.";
      break;
    case "expired":
      banner = {
        tone: "bad",
        title: "Arrived too late and was not run",
        body: `${message?.receipt ? "Receipt: Expired." : "Base reports: Expired; the receipt is on its way."} The message reached Base Sepolia after its ${formatDuration(
          overview.rules.requestTtl,
        )} window, so the DAO’s account ignored it. A new proposal is needed.`,
      };
      next = "Arrived after its window; not run on Base.";
      break;
  }

  const counted = quorumCounted(p);
  let listQuorum: string;
  if (phase === "queued" || phase === "executing") listQuorum = "Quorum reached · timelock running";
  else if (CHIP[phase] === "Executed")
    listQuorum = lastOf(p.events, "done", AutoAction.Execute) ? "Executed by the network" : "Executed";
  else if (phase === "canceled") listQuorum = "Cancelled";
  else
    listQuorum = `Quorum ${formatVotes(p.quorum)}${p.supplyAtSnapshot !== null ? ` of ${formatVotes(p.supplyAtSnapshot)}` : ""} ${
      counted >= p.quorum ? "reached" : phase === "active" || phase === "pending" ? "not reached yet" : "not reached"
    }`;

  return {
    phase,
    chip: CHIP[phase],
    title,
    body,
    where: whereLabel(p, ctx.addresses),
    bundle,
    message,
    banner,
    next,
    listQuorum,
    votes: votesView(p, phase, ctx),
    timeline: timeline(p, phase, ctx, bundle),
    fallback: fallbackView(p, phase, executeOutcome ?? queueOutcome, ctx),
    canCancel: phase === "pending" && !!p.viewer && p.viewer.address.toLowerCase() === p.proposer.toLowerCase(),
  };
}
