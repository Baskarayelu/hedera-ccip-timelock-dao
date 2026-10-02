"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useDao } from "../DaoProvider";
import { NotDeployed } from "../NotDeployed";
import { useOverview, useProposalViews } from "../hooks";
import { Chip, ClockIcon, LoadState, PlusIcon } from "../ui";
import { GOV_SYMBOL, explorer } from "~~/lib/dao/config";
import type { Chip as ChipName, ProposalView } from "~~/lib/dao/derive";
import { formatDuration } from "~~/lib/dao/time";
import { AutoAction, type DaoOverview, type ProposalRecord } from "~~/lib/dao/types";
import { ETH_DECIMALS, USDC_DECIMALS, formatAmount, formatHbar, formatVotes, shortAddress } from "~~/lib/dao/units";

const CHIP_ORDER: ChipName[] = ["Active", "Pending", "Passed", "Queued", "Executed", "Defeated", "Canceled"];

function Stats({ overview }: { overview: DaoOverview }) {
  const { rules, remoteAccount } = overview;
  // A callback fails unless the float holds its whole gas limit at today's price, though only the gas used is billed.
  const { [AutoAction.Queue]: queueGas, [AutoAction.Execute]: executeGas } = rules.autoGas;
  const floatNeed = (queueGas > executeGas ? queueGas : executeGas) * overview.gasPrice;
  const share =
    rules.quorumDenominator === 100n
      ? `${rules.quorumNumerator}%`
      : `${rules.quorumNumerator}/${rules.quorumDenominator}`;
  return (
    <section aria-label="DAO at a glance" className="kpis">
      <div className="panel kpi">
        <span className="kpi-label">Treasury</span>
        <span className="kpi-value">{formatHbar(overview.treasuryHbar)}</span>
        <span className="kpi-note">
          Held by the timelock{overview.treasuryGov > 0n ? ` · ${formatVotes(overview.treasuryGov)} ${GOV_SYMBOL}` : ""}
        </span>
      </div>
      <div className="panel kpi">
        <span className="kpi-label">Callback float</span>
        <span className="kpi-value">{formatHbar(overview.floatHbar)}</span>
        {overview.floatHbar < floatNeed ? (
          <span className="kpi-note low" data-testid="float-low">
            Too low: a callback needs {formatHbar(floatNeed)} available. Send HBAR to the governor.
          </span>
        ) : (
          <span className="kpi-note">Pays the network to queue and execute</span>
        )}
      </div>
      <div className="panel kpi">
        <span className="kpi-label">DAO account on Base Sepolia</span>
        <a className="kpi-value" href={explorer.baseAddress(remoteAccount.address)} target="_blank" rel="noreferrer">
          {shortAddress(remoteAccount.address)}
        </a>
        <span className="kpi-note">
          {formatAmount(remoteAccount.usdc, USDC_DECIMALS, 2)} USDC · {formatAmount(remoteAccount.eth, ETH_DECIMALS)}{" "}
          ETH
          {remoteAccount.deployed ? "" : " · created on first use"}
        </span>
      </div>
      <div className="panel kpi">
        <span className="kpi-label">Rules</span>
        <span className="kpi-value text">{share} quorum</span>
        <span className="kpi-note">
          {formatDuration(rules.votingPeriod)} vote · {formatDuration(rules.timelockDelay)} timelock
        </span>
      </div>
    </section>
  );
}

function Row({ record, view }: { record: ProposalRecord; view: ProposalView }) {
  return (
    <li>
      <Link href={`/proposals/${record.id}`} className="row" data-testid="proposal-row">
        <div className="row-main">
          <div className="chip-row">
            <span className="num">#{record.number}</span>
            <Chip name={view.chip} />
            <span className="chip chip-outline">{view.where}</span>
          </div>
          <span className="row-title">{view.title}</span>
          <span className="row-next">
            <ClockIcon />
            {view.next}
          </span>
        </div>
        <div className="tally">
          <div className="tally-legend">
            <span>
              <span aria-hidden="true" className="swatch for" />
              For {view.votes.forVotes}
            </span>
            <span>
              <span aria-hidden="true" className="swatch against" />
              Against {view.votes.againstVotes}
            </span>
          </div>
          <div aria-hidden="true" className="bar">
            <span className="for" style={{ width: `${view.votes.forPct}%` }} />
            <span className="against" style={{ width: `${view.votes.againstPct}%` }} />
          </div>
          <span className="small faint">{view.listQuorum}</span>
        </div>
      </Link>
    </li>
  );
}

export function ProposalsPage() {
  const { source } = useDao();
  const overview = useOverview();
  const { views, isLoading, error } = useProposalViews();
  const [filter, setFilter] = useState<ChipName | "All">("All");

  const counts = useMemo(() => {
    const c = new Map<ChipName, number>();
    views?.forEach(({ view }) => c.set(view.chip, (c.get(view.chip) ?? 0) + 1));
    return c;
  }, [views]);
  const shown = views?.filter(({ view }) => filter === "All" || view.chip === filter) ?? [];

  return (
    <main className="page">
      <div className="title-row">
        <div className="vstack">
          <h1 className="page-title">Proposals</h1>
          <p className="page-lead">
            You propose and vote. When voting ends the network queues a passed proposal, and when the timelock ends it
            executes it, on Hedera or on Base Sepolia.
          </p>
        </div>
        <Link href="/proposals/new" className="dbtn dbtn-primary">
          <PlusIcon />
          New proposal
        </Link>
      </div>

      {!source.addresses ? (
        <NotDeployed />
      ) : (
        <>
          {overview.data ? <Stats overview={overview.data} /> : null}

          {views && views.length > 0 && (
            <div role="tablist" aria-label="Filter proposals" className="ftabs">
              {(["All", ...CHIP_ORDER] as const)
                .filter(name => name === "All" || counts.get(name))
                .map(name => (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    aria-selected={filter === name}
                    className="ftab"
                    onClick={() => setFilter(name)}
                  >
                    {name} {name === "All" ? views.length : counts.get(name)}
                  </button>
                ))}
            </div>
          )}

          {!views ? (
            <LoadState error={error} label="proposals" />
          ) : views.length === 0 ? (
            <section className="empty">
              <svg
                width="40"
                height="40"
                viewBox="0 0 40 40"
                fill="none"
                aria-hidden="true"
                style={{ color: "var(--ink3)" }}
              >
                <rect x="7" y="5" width="26" height="30" rx="4" stroke="currentColor" strokeWidth="2" />
                <path d="M13 14h14M13 20h14M13 26h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <h2>No proposals yet</h2>
              <p>
                Anyone with voting power can propose. After the vote, the network queues and executes it without a
                keeper.
              </p>
              <Link href="/proposals/new" className="dbtn dbtn-primary">
                Create the first proposal
              </Link>
            </section>
          ) : (
            <ul className="rows" aria-busy={isLoading}>
              {shown.map(({ record, view }) => (
                <Row key={record.id.toString()} record={record} view={view} />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
