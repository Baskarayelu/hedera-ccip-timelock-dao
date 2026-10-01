"use client";

import Link from "next/link";
import { useDao } from "../DaoProvider";
import { NotDeployed } from "../NotDeployed";
import { useNow, useProposalView } from "../hooks";
import { Banner, Chip, LoadState, Parts } from "../ui";
import { explorer } from "~~/lib/dao/config";
import type { ProposalView, TimelineStep } from "~~/lib/dao/derive";
import { describeActions } from "~~/lib/dao/proposal";
import { formatDuration, formatWhen } from "~~/lib/dao/time";
import { AutoAction, type DaoOverview, type ProposalRecord, VoteSupport } from "~~/lib/dao/types";
import { formatHbar, shortAddress } from "~~/lib/dao/units";

function parseId(raw: string): bigint | null {
  try {
    return /^\d+$/.test(raw) ? BigInt(raw) : null;
  } catch {
    return null;
  }
}

function Votes({ record, view }: { record: ProposalRecord; view: ProposalView }) {
  const { run, wallet, pending } = useDao();
  const v = view.votes;
  const voting = [...pending].some(l => l.startsWith("Vote"));
  const vote = (support: VoteSupport, label: string) =>
    run({ kind: "vote", proposalId: record.id, support }, `Vote ${label}`);
  return (
    <section aria-labelledby="votes-title" className="panel panel-pad">
      <div className="chip-row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 id="votes-title">Votes</h2>
        <span className="small faint">{v.window}</span>
      </div>
      <div className="vote-grid">
        <div className="vote-box">
          <span className="vote-label">
            <span aria-hidden="true" className="swatch for" />
            For
          </span>
          <span className="vote-value" data-testid="votes-for">
            {v.forVotes}
          </span>
        </div>
        <div className="vote-box">
          <span className="vote-label">
            <span aria-hidden="true" className="swatch against" />
            Against
          </span>
          <span className="vote-value" data-testid="votes-against">
            {v.againstVotes}
          </span>
        </div>
        <div className="vote-box">
          <span className="vote-label">Abstain</span>
          <span className="vote-value">{v.abstainVotes}</span>
        </div>
      </div>
      <div className="vstack">
        <div aria-hidden="true" className="bar lg">
          <span className="for" style={{ width: `${v.forPct}%` }} />
          <span className="against" style={{ width: `${v.againstPct}%` }} />
        </div>
        <span className="small muted">{v.quorumLine}</span>
      </div>
      {v.showButtons && (
        <div className="vote-buttons">
          {(
            [
              [VoteSupport.For, "For"],
              [VoteSupport.Against, "Against"],
              [VoteSupport.Abstain, "Abstain"],
            ] as const
          ).map(([support, label]) => (
            <button
              key={label}
              type="button"
              className="dbtn"
              disabled={!v.canVote || wallet.wrongNetwork || voting}
              onClick={() => vote(support, label)}
            >
              {pending.has(`Vote ${label}`) ? "Sending…" : label}
            </button>
          ))}
        </div>
      )}
      <p className={`you ${v.you.tone}`} data-testid="you">
        {v.you.text}
      </p>
      {view.canCancel && (
        <button
          type="button"
          className="dbtn"
          style={{ alignSelf: "flex-start" }}
          disabled={wallet.wrongNetwork || pending.has("Cancel proposal")}
          onClick={() => run({ kind: "cancel", proposal: record }, "Cancel proposal")}
        >
          Cancel this proposal
        </button>
      )}
    </section>
  );
}

function Actions({ record, view, overview }: { record: ProposalRecord; view: ProposalView; overview: DaoOverview }) {
  const { source } = useDao();
  const { actions } = describeActions(record, source.addresses!);
  return (
    <section aria-labelledby="actions-title" className="panel">
      <h2 id="actions-title" className="panel-head">
        What it does
      </h2>
      <ol className="action-list">
        {actions.map((a, i) => (
          <li key={i}>
            <span style={{ fontWeight: 600 }}>
              {i + 1} · {a.chain === "base" ? "On Base Sepolia: " : "On Hedera: "}
              <Parts parts={a.parts} />
            </span>
            <span className="small faint">{a.detail}</span>
          </li>
        ))}
        {view.bundle && (
          <li>
            <span style={{ fontWeight: 600 }}>
              Delivery: one CCIP message, fee cap {formatHbar(view.bundle.feeCap)}
            </span>
            <span className="small faint">
              {view.bundle.destGasLimit.toLocaleString("en-US")} gas on Base · valid for{" "}
              {formatDuration(overview.rules.requestTtl)} after sending
            </span>
          </li>
        )}
      </ol>
    </section>
  );
}

function Fallback({ record, view }: { record: ProposalRecord; view: ProposalView }) {
  const { run, wallet, pending } = useDao();
  const f = view.fallback;
  const primaryLabel = f.primary.kind === "queue" ? "Queue proposal" : "Execute proposal";
  const rearmLabel = `Schedule ${f.rearm.action === AutoAction.Queue ? "queue" : "execution"} again`;
  return (
    <section aria-labelledby="fallback-title" className={`fallback ${f.emphasis}`} data-testid="fallback">
      <h2 id="fallback-title">{f.title}</h2>
      <p className="small muted" style={{ margin: 0, fontSize: 14 }}>
        {f.body}
      </p>
      <div className="dbtn-row">
        <button
          type="button"
          className="dbtn"
          disabled={!f.rearm.enabled || wallet.wrongNetwork || pending.has(rearmLabel)}
          onClick={() => run({ kind: "rearm", proposal: record, action: f.rearm.action }, rearmLabel)}
        >
          {pending.has(rearmLabel) ? "Sending…" : "Schedule it again"}
        </button>
        <button
          type="button"
          className={`dbtn ${f.primary.enabled ? "dbtn-primary" : ""}`}
          disabled={!f.primary.enabled || wallet.wrongNetwork || pending.has(primaryLabel)}
          onClick={() => run({ kind: f.primary.kind, proposal: record }, primaryLabel)}
        >
          {pending.has(primaryLabel) ? "Sending…" : f.primary.label}
        </button>
      </div>
    </section>
  );
}

const MARKS: Record<TimelineStep["status"], string> = { done: "✓", next: "", later: "", failed: "×", stopped: "–" };
const LABELS: Record<TimelineStep["status"], string> = {
  done: "Done",
  next: "Next",
  later: "Not yet",
  failed: "Failed",
  stopped: "Did not happen",
};

function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <section aria-labelledby="timeline-title" className="panel panel-pad" style={{ gap: 18 }}>
      <h2 id="timeline-title">Timeline</h2>
      <ol className="tl">
        {steps.map(step => (
          <li key={step.key} className={`st-${step.status}`} data-testid={`tl-${step.key}`} data-status={step.status}>
            <div className="tl-rail">
              <span role="img" aria-label={LABELS[step.status]} className="tl-dot">
                {MARKS[step.status]}
              </span>
              <span className="tl-line" />
            </div>
            <div className="tl-body">
              <div className="tl-head">
                <span className="tl-title">{step.title}</span>
                <span className="tl-time">{step.time}</span>
              </div>
              <span className="tl-detail">{step.detail}</span>
              {step.link && (
                <a className="tl-link" href={step.link.href} target="_blank" rel="noreferrer">
                  {step.link.label}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ProposalDetailPage({ rawId }: { rawId: string }) {
  const { source } = useDao();
  const now = useNow();
  const id = parseId(rawId);
  const { record, view, overview, error, notFound } = useProposalView(id);

  if (!source.addresses) {
    return (
      <main className="page">
        <NotDeployed />
      </main>
    );
  }
  if (id === null || notFound) {
    return (
      <main className="page">
        <Link href="/" className="back">
          ← Proposals
        </Link>
        <Banner
          banner={{ tone: "neutral", title: "No such proposal", body: `This DAO has no proposal with id ${rawId}.` }}
        />
      </main>
    );
  }
  if (!record || !view || !overview) {
    return (
      <main className="page">
        <LoadState error={error} label="the proposal" />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="vstack" style={{ gap: 10 }}>
        <Link href="/" className="back">
          ← Proposals
        </Link>
        <div className="chip-row">
          <span className="num">#{record.number}</span>
          <Chip name={view.chip} />
          <span className="chip chip-outline">{view.where}</span>
        </div>
        <h1 className="page-title" style={{ fontSize: 30 }}>
          {view.title}
        </h1>
        <p className="muted" style={{ margin: 0 }}>
          Proposed by{" "}
          <a className="mono" href={explorer.hederaAccount(record.proposer)} target="_blank" rel="noreferrer">
            {shortAddress(record.proposer)}
          </a>{" "}
          · created {formatWhen(record.created.timestamp, now)}
        </p>
        {view.body && (
          <p className="muted" style={{ margin: 0, whiteSpace: "pre-wrap", maxWidth: 760 }}>
            {view.body}
          </p>
        )}
      </div>

      <Banner banner={view.banner} />

      <div className="split detail">
        <div className="vstack-lg">
          <Votes record={record} view={view} />
          <Actions record={record} view={view} overview={overview} />
          <Fallback record={record} view={view} />
        </div>
        <Timeline steps={view.timeline} />
      </div>
    </main>
  );
}
