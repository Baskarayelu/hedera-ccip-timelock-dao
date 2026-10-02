"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useDao } from "../DaoProvider";
import { NotDeployed } from "../NotDeployed";
import { useNow, useVoter } from "../hooks";
import { Banner, LoadState } from "../ui";
import { type Address, isAddress } from "viem";
import { GOV_SYMBOL, VOTE_SYMBOL } from "~~/lib/dao/config";
import { formatDuration, formatWhen } from "~~/lib/dao/time";
import type { VoterStatus } from "~~/lib/dao/types";
import { GOV_DECIMALS, formatGov, formatHbar, formatUnitsFixed, parseAmount, shortAddress } from "~~/lib/dao/units";

type StepState = "done" | "current" | "waiting" | "available" | "optional";

function Step({
  n,
  state,
  title,
  body,
  note,
  noteTone,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  body: string;
  note?: string;
  /** "wait" marks a note about something the voter has to wait for; others are plain confirmations. */
  noteTone?: "wait";
  children?: ReactNode;
}) {
  const done = state === "done" || state === "optional";
  return (
    <li className={`setup-step ${state === "current" ? "current" : ""}`} data-testid={`step-${n}`} data-state={state}>
      <div className="setup-step-main">
        <span
          role="img"
          aria-label={done ? "Done" : state === "current" ? "Next step" : "Not yet"}
          className={`step-badge ${done ? "done" : state === "current" ? "current" : ""}`}
        >
          {done ? "✓" : n}
        </span>
        <div className="setup-step-text">
          <span className="setup-step-title">{title}</span>
          <span className="setup-step-body">{body}</span>
          {note && <span className={`setup-step-note${noteTone === "wait" ? " wait" : ""}`}>{note}</span>}
        </div>
      </div>
      {children}
    </li>
  );
}

function ActionButton({
  label,
  pendingLabel,
  primary,
  disabled,
  onClick,
}: {
  label: string;
  pendingLabel: string;
  primary: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { pending } = useDao();
  const busy = pending.has(pendingLabel);
  return (
    <button
      type="button"
      className={`dbtn ${primary ? "dbtn-primary" : ""}`}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy ? "Sending…" : label}
    </button>
  );
}

function Steps({ voter }: { voter: VoterStatus }) {
  const { run, wallet } = useDao();
  const now = useNow();
  const [amount, setAmount] = useState("");
  const [delegateMode, setDelegateMode] = useState<"self" | "other">("self");
  const [delegateTo, setDelegateTo] = useState("");
  const [changingDelegate, setChangingDelegate] = useState(false);
  const blocked = wallet.wrongNetwork;

  // Prefill the wrap amount with the whole balance once it is known.
  useEffect(() => {
    if (voter.gov > 0n && amount === "")
      setAmount(
        formatUnitsFixed(voter.gov, GOV_DECIMALS, 6)
          .replace(/\.?0+$/, "")
          .replace(/,/g, ""),
      );
  }, [voter.gov, amount]);

  const canReceive = voter.associated || voter.autoAssociationSlots !== 0;
  const nextClaim = voter.lastClaimAt ? voter.lastClaimAt + voter.claimCooldown : 0;
  const coolingDown = nextClaim > now;
  const wrapAmount = parseAmount(amount, GOV_DECIMALS);
  const wrapError =
    wrapAmount === null || wrapAmount === 0n
      ? "Enter an amount above zero with at most 6 decimals."
      : wrapAmount > voter.gov
        ? `You hold ${formatGov(voter.gov)} ${GOV_SYMBOL}.`
        : undefined;
  const otherValid = isAddress(delegateTo.trim());
  const delegateTarget = delegateMode === "self" ? wallet.address : (delegateTo.trim() as Address);

  const associateState: StepState = voter.associated ? "done" : canReceive ? "optional" : "current";
  const claimState: StepState = coolingDown
    ? "waiting"
    : !canReceive
      ? "waiting"
      : voter.gov + voter.voteBalance === 0n
        ? "current"
        : "available";
  const wrapState: StepState = voter.gov > 0n ? "current" : voter.voteBalance > 0n ? "done" : "waiting";
  const delegateState: StepState = voter.delegate ? "done" : voter.voteBalance > 0n ? "current" : "waiting";
  // Only one step is highlighted: the first that is current.
  const states = [associateState, claimState, wrapState, delegateState];
  const firstCurrent = states.indexOf("current");
  const shown = states.map((s, i) => (s === "current" && i !== firstCurrent ? "available" : s));

  const wrap = async () => {
    if (!wrapAmount) return;
    if (voter.allowance < wrapAmount) {
      const approved = await run({ kind: "approve", amount: wrapAmount }, `Approve ${GOV_SYMBOL}`);
      if (!approved) return;
    }
    await run({ kind: "wrap", amount: wrapAmount }, `Wrap ${GOV_SYMBOL}`);
  };
  const delegate = async () => {
    if (!delegateTarget) return;
    const done = await run({ kind: "delegate", to: delegateTarget }, "Delegate votes");
    if (done) setChangingDelegate(false);
  };

  return (
    <section aria-labelledby="steps-title" className="panel">
      <h2 id="steps-title" className="panel-head">
        Four steps, once
      </h2>
      <ol className="setup">
        <Step
          n={1}
          state={shown[0]}
          title={`Associate ${GOV_SYMBOL} with your account`}
          body="Hedera accounts opt in to each token (HIP-719). One transaction."
          note={
            associateState === "optional"
              ? voter.autoAssociationSlots === -1
                ? "Not needed: your account associates with new tokens automatically."
                : `Not needed: your account has ${voter.autoAssociationSlots} free automatic-association slot${voter.autoAssociationSlots === 1 ? "" : "s"}.`
              : undefined
          }
        >
          {associateState === "done" || associateState === "optional" ? (
            <span className="done-pill">{associateState === "done" ? "Done" : "Not needed"}</span>
          ) : (
            <div className="setup-step-action">
              <ActionButton
                label="Associate"
                pendingLabel={`Associate ${GOV_SYMBOL}`}
                primary
                disabled={blocked}
                onClick={() => run({ kind: "associate" }, `Associate ${GOV_SYMBOL}`)}
              />
            </div>
          )}
        </Step>
        <Step
          n={2}
          state={shown[1]}
          title={`Claim ${formatGov(voter.claimAmount, 0)} ${GOV_SYMBOL}`}
          body={`Testnet faucet: one claim per account every ${formatDuration(voter.claimCooldown)}.`}
          noteTone="wait"
          note={
            coolingDown
              ? `Claimed at ${formatWhen(voter.lastClaimAt, now)}. Next claim from ${formatWhen(nextClaim, now)} (faucet cooldown, read from the contract).`
              : undefined
          }
        >
          <div className="setup-step-action">
            <ActionButton
              label="Claim"
              pendingLabel={`Claim ${GOV_SYMBOL}`}
              primary={shown[1] === "current"}
              disabled={blocked || coolingDown || !canReceive}
              onClick={() => run({ kind: "claim" }, `Claim ${GOV_SYMBOL}`)}
            />
          </div>
        </Step>
        <Step
          n={3}
          state={shown[2]}
          title={`Wrap ${GOV_SYMBOL} into ${VOTE_SYMBOL}`}
          body={`${VOTE_SYMBOL} is what the governor counts. It is 1:1, and you can unwrap any time.`}
        >
          {wrapState === "done" ? (
            <span className="done-pill">Done</span>
          ) : (
            <div className="setup-step-action">
              <label className="field">
                <span className="field-label">Amount to wrap</span>
                <span className="dinput-suffix">
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    aria-invalid={voter.gov > 0n && !!wrapError}
                    disabled={voter.gov === 0n}
                    aria-describedby="wrap-hint"
                  />
                  <span className="small faint">{GOV_SYMBOL}</span>
                </span>
                <span id="wrap-hint" className={voter.gov > 0n && wrapError ? "field-error" : "hint"}>
                  {voter.gov > 0n && wrapError ? wrapError : `You hold ${formatGov(voter.gov)} ${GOV_SYMBOL}.`}
                </span>
              </label>
              <ActionButton
                label={wrapAmount && voter.allowance >= wrapAmount ? "Wrap" : "Approve and wrap"}
                pendingLabel={
                  wrapAmount && voter.allowance >= wrapAmount ? `Wrap ${GOV_SYMBOL}` : `Approve ${GOV_SYMBOL}`
                }
                primary={shown[2] === "current"}
                disabled={blocked || voter.gov === 0n || !!wrapError}
                onClick={wrap}
              />
            </div>
          )}
        </Step>
        <Step
          n={4}
          state={shown[3]}
          title="Delegate your votes"
          body="Delegate to yourself to vote directly, or to someone you trust."
          note={
            voter.delegate && !changingDelegate
              ? `Delegated to ${voter.delegate.toLowerCase() === wallet.address?.toLowerCase() ? "yourself" : shortAddress(voter.delegate)}. You can change it any time.`
              : undefined
          }
        >
          {voter.delegate && !changingDelegate ? (
            <div className="setup-step-action">
              <span className="done-pill">Done</span>
              <button type="button" className="dbtn" onClick={() => setChangingDelegate(true)}>
                Change delegate
              </button>
            </div>
          ) : (
            <div className="setup-step-action">
              <fieldset className="choice" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="sr-only">Delegate to</legend>
                <label>
                  <input
                    type="radio"
                    name="delegate"
                    checked={delegateMode === "self"}
                    onChange={() => setDelegateMode("self")}
                  />
                  Myself
                </label>
                <label>
                  <input
                    type="radio"
                    name="delegate"
                    checked={delegateMode === "other"}
                    onChange={() => setDelegateMode("other")}
                  />
                  Someone else
                </label>
              </fieldset>
              {delegateMode === "other" && (
                <label className="field">
                  <span className="field-label">Their address</span>
                  <input
                    className="dinput mono"
                    placeholder="0x…"
                    value={delegateTo}
                    onChange={e => setDelegateTo(e.target.value)}
                    aria-invalid={delegateTo !== "" && !otherValid}
                  />
                  {delegateTo !== "" && !otherValid && (
                    <span className="field-error">Enter a 0x address (40 hex digits).</span>
                  )}
                </label>
              )}
              <ActionButton
                label={delegateMode === "self" ? "Delegate to myself" : "Delegate"}
                pendingLabel="Delegate votes"
                primary={shown[3] === "current"}
                disabled={blocked || voter.voteBalance === 0n || (delegateMode === "other" && !otherValid)}
                onClick={delegate}
              />
            </div>
          )}
        </Step>
      </ol>
    </section>
  );
}

function Balances({ voter }: { voter: VoterStatus }) {
  const { run, wallet, pending } = useDao();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const value = parseAmount(amount, GOV_DECIMALS);
  const invalid = value === null || value === 0n || value > voter.voteBalance;
  const canReceive = voter.associated || voter.autoAssociationSlots !== 0;
  const powerless = voter.voteBalance > 0n && voter.votes === 0n;
  return (
    <section aria-labelledby="bal-title" className="panel panel-pad">
      <h2 id="bal-title">Your balances</h2>
      <dl className="balances">
        <dt>
          {GOV_SYMBOL} <span className="small faint">HTS token</span>
        </dt>
        <dd data-testid="bal-hgov">{canReceive ? formatGov(voter.gov) : "—"}</dd>
        <dt>
          {VOTE_SYMBOL} <span className="small faint">wrapped</span>
        </dt>
        <dd data-testid="bal-vhgov">{formatGov(voter.voteBalance)}</dd>
        <dt>Voting power now</dt>
        <dd data-testid="bal-power" style={{ color: powerless ? "var(--warn)" : undefined }}>
          {formatGov(voter.votes)}
        </dd>
        <dt>Delegated to</dt>
        <dd className="faint" style={{ fontFamily: "inherit" }}>
          {!voter.delegate
            ? "Not set"
            : voter.delegate.toLowerCase() === wallet.address?.toLowerCase()
              ? "Yourself"
              : shortAddress(voter.delegate)}
        </dd>
        <dt>HBAR for fees</dt>
        <dd>{formatHbar(voter.hbar)}</dd>
      </dl>
      {voter.voteBalance > 0n &&
        (open ? (
          <div className="setup-step-form">
            <label className="field">
              <span className="field-label">Amount to unwrap</span>
              <span className="dinput-suffix">
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  aria-invalid={amount !== "" && invalid}
                />
                <span className="small faint">{VOTE_SYMBOL}</span>
              </span>
              <span className="hint">Unwrapped {GOV_SYMBOL} stops counting as votes immediately.</span>
            </label>
            <button
              type="button"
              className="dbtn"
              disabled={invalid || wallet.wrongNetwork || pending.has(`Unwrap ${VOTE_SYMBOL}`)}
              onClick={async () => {
                if (value && (await run({ kind: "unwrap", amount: value }, `Unwrap ${VOTE_SYMBOL}`))) setOpen(false);
              }}
            >
              {pending.has(`Unwrap ${VOTE_SYMBOL}`) ? "Sending…" : "Unwrap"}
            </button>
          </div>
        ) : (
          <button type="button" className="dbtn" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)}>
            Unwrap {VOTE_SYMBOL}
          </button>
        ))}
    </section>
  );
}

export function VotingPowerPage() {
  const { source, wallet } = useDao();
  const voter = useVoter();
  const v = voter.data;
  const canReceive = v ? v.associated || v.autoAssociationSlots !== 0 : true;

  let alert: { tone: "warn" | "bad"; title: string; body: string } | null = null;
  if (v && !v.accountId) {
    alert = {
      tone: "warn",
      title: "This address has no Hedera account yet",
      body: "Send it testnet HBAR from the faucet at portal.hedera.com/faucet; the first transfer creates the account and pays for these steps.",
    };
  } else if (v && !canReceive) {
    alert = {
      tone: "warn",
      title: `Your account is not associated with ${GOV_SYMBOL} yet`,
      body: "Hedera rejects token transfers to accounts that have not opted in, and yours has no free automatic-association slots. Associate first; the faucet and unwrapping need it.",
    };
  } else if (v && v.voteBalance > 0n && !v.delegate) {
    alert = {
      tone: "warn",
      title: `Your ${formatGov(v.voteBalance, 0)} ${VOTE_SYMBOL} carry no votes yet`,
      body: "Wrapped tokens only count once they are delegated. Delegate before the next proposal’s snapshot; proposals already open use the snapshot taken when they started.",
    };
  }

  return (
    <main className="page">
      <div className="vstack">
        <h1 className="page-title">Voting power</h1>
        <p className="page-lead">
          Votes count at each proposal’s snapshot. Set this up once; tokens you wrap or delegate after a vote starts
          count from the next proposal.
        </p>
      </div>
      {!source.addresses ? (
        <NotDeployed />
      ) : !wallet.address ? (
        <Banner
          banner={{
            tone: "info",
            title: "Connect a wallet to set up voting",
            body: "Your balances and the four steps appear here.",
          }}
        >
          <button
            type="button"
            className="dbtn dbtn-primary"
            style={{ alignSelf: "flex-start", marginTop: 8 }}
            onClick={wallet.connect}
          >
            Connect wallet
          </button>
        </Banner>
      ) : !v ? (
        <LoadState error={voter.error} label="your balances" />
      ) : (
        <>
          {alert && <Banner banner={alert} />}
          <div className="split">
            <Steps voter={v} />
            <aside className="vstack-lg">
              <Balances voter={v} />
              <section aria-labelledby="why-title" className="panel-soft">
                <h2 id="why-title">Why wrap?</h2>
                <p className="small muted" style={{ margin: 0, fontSize: 14 }}>
                  {GOV_SYMBOL} transfers are native Hedera transactions and run no contract code, so the token cannot
                  record vote checkpoints itself. {VOTE_SYMBOL} records them, and the governor reads your balance at
                  each proposal’s snapshot. Tokens moved or wrapped after a vote starts cannot be counted twice.
                </p>
              </section>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
