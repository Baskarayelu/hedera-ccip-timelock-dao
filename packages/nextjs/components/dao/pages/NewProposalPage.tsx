"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDao } from "../DaoProvider";
import { NotDeployed } from "../NotDeployed";
import { useFeeQuote, useNetworkStats, useOverview, useVoter } from "../hooks";
import { Banner, CloseIcon, Parts } from "../ui";
import { useQuery } from "@tanstack/react-query";
import { GOV_SYMBOL, VOTE_SYMBOL } from "~~/lib/dao/config";
import { deliveryEstimate, finalityText, receiptEta } from "~~/lib/dao/derive";
import {
  DRAFT_LABELS,
  type DaoAddresses,
  type DraftAction,
  type DraftKind,
  buildProposal,
  describeActions,
  draftToCall,
  emptyDraft,
  isBaseDraft,
  validateDraft,
} from "~~/lib/dao/proposal";
import { formatDuration, formatElapsed, formatOffset } from "~~/lib/dao/time";
import type { DaoOverview } from "~~/lib/dao/types";
import {
  ETH_DECIMALS,
  GOV_DECIMALS,
  HBAR_DECIMALS,
  USDC_DECIMALS,
  ceilToCentiHbar,
  formatAmount,
  formatGov,
  formatHbar,
  formatUnitsFixed,
  formatVotes,
  parseAmount,
  shortAddress,
} from "~~/lib/dao/units";

const HEDERA_KINDS: DraftKind[] = ["hbar", "hgov", "hederaCall"];
const BASE_KINDS: DraftKind[] = ["param", "baseToken", "baseCall"];
const DEFAULT_DEST_GAS = "600,000";

function Field({
  label,
  value,
  onChange,
  error,
  mono = true,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className={`dinput ${mono ? "mono" : ""}`}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        aria-invalid={!!error}
      />
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

function ActionEditor({
  action,
  index,
  touched,
  overview,
  addresses,
  onChange,
  onRemove,
}: {
  action: DraftAction;
  index: number;
  touched: boolean;
  overview: DaoOverview | undefined;
  addresses: DaoAddresses;
  onChange: (a: DraftAction) => void;
  onRemove: () => void;
}) {
  const errors = touched ? validateDraft(action) : {};
  const set = (patch: Partial<DraftAction>) => onChange({ ...action, ...patch } as DraftAction);
  const base = isBaseDraft(action);
  let fields: React.ReactNode;
  let note = "";
  switch (action.kind) {
    case "hbar":
      fields = (
        <div className="grid2">
          <Field
            label="Recipient on Hedera"
            value={action.to}
            placeholder="0x…"
            onChange={to => set({ to })}
            error={errors.to}
          />
          <Field
            label="Amount (HBAR)"
            value={action.amount}
            onChange={amount => set({ amount })}
            error={errors.amount}
          />
        </div>
      );
      note = overview ? `From the treasury, which holds ${formatHbar(overview.treasuryHbar)}.` : "From the treasury.";
      break;
    case "hgov":
      fields = (
        <div className="grid2">
          <Field
            label="Recipient on Hedera"
            value={action.to}
            placeholder="0x…"
            onChange={to => set({ to })}
            error={errors.to}
          />
          <Field
            label={`Amount (${GOV_SYMBOL})`}
            value={action.amount}
            onChange={amount => set({ amount })}
            error={errors.amount}
          />
        </div>
      );
      note = `From the treasury${overview ? `, which holds ${formatGov(overview.treasuryGov)} ${GOV_SYMBOL}` : ""}. The recipient must be associated with ${GOV_SYMBOL} or have a free association slot.`;
      break;
    case "hederaCall":
    case "baseCall":
      fields = (
        <div className="grid3">
          <Field
            label="Contract"
            value={action.target}
            placeholder="0x…"
            onChange={target => set({ target })}
            error={errors.target}
          />
          <Field
            label={`Value (${action.kind === "hederaCall" ? "HBAR" : "ETH"})`}
            value={action.value}
            onChange={value => set({ value })}
            error={errors.value}
          />
          <Field label="Calldata" value={action.data} onChange={data => set({ data })} error={errors.data} />
        </div>
      );
      note =
        action.kind === "hederaCall"
          ? "Called by the timelock, so the target sees the DAO as the caller."
          : `Called by the DAO’s account ${shortAddress(addresses.remoteAccount)} on Base Sepolia.`;
      break;
    case "param":
      fields = (
        <div className="grid2">
          <Field
            label="Key"
            value={action.key}
            placeholder="protocol.feeBps"
            onChange={key => set({ key })}
            error={errors.key}
          />
          <Field label="New value" value={action.value} onChange={value => set({ value })} error={errors.value} />
        </div>
      );
      note = "Written by the DAO’s own account to the shared RemoteParameters contract on Base Sepolia.";
      break;
    case "baseToken":
      fields = (
        <div className="grid3">
          <label className="field">
            <span className="field-label">Token</span>
            <select
              className="dinput"
              value={action.token}
              onChange={e => set({ token: e.target.value as "USDC" | "ETH" })}
            >
              <option>USDC</option>
              <option>ETH</option>
            </select>
          </label>
          <Field label="Amount" value={action.amount} onChange={amount => set({ amount })} error={errors.amount} />
          <Field
            label="Recipient on Base"
            value={action.to}
            placeholder="0x…"
            onChange={to => set({ to })}
            error={errors.to}
          />
        </div>
      );
      note = overview
        ? `From ${shortAddress(addresses.remoteAccount)}, which holds ${formatAmount(overview.remoteAccount.usdc, USDC_DECIMALS, 2)} USDC and ${formatAmount(
            overview.remoteAccount.eth,
            18,
          )} ETH.`
        : `From ${shortAddress(addresses.remoteAccount)}.`;
      break;
  }
  return (
    <div className="action" data-testid="draft-action">
      <div className="action-head">
        <div className="chip-row">
          <span className="num">{index + 1}</span>
          <span className={`chip ${base ? "chip-base" : "chip-outline"}`}>{base ? "Base Sepolia" : "Hedera"}</span>
          <span style={{ fontWeight: 600 }}>{DRAFT_LABELS[action.kind]}</span>
        </div>
        <button type="button" className="icon-btn" aria-label={`Remove action ${index + 1}`} onClick={onRemove}>
          <CloseIcon />
        </button>
      </div>
      {fields}
      <span className="hint">{note}</span>
      {overview && shortfall(action, overview) && (
        <span className="hint low" data-testid="draft-shortfall">
          {base
            ? "That is less than this action sends. Fund the account before the proposal executes, or the Base batch fails and the receipt says why."
            : "That is less than this action sends. Top up the treasury before the proposal executes, or its execution fails until someone does."}
        </span>
      )}
    </div>
  );
}

/** True when a transfer asks for more than its source holds right now. */
function shortfall(action: DraftAction, overview: DaoOverview): boolean {
  const over = (amount: string, decimals: number, held: bigint) => {
    const wanted = parseAmount(amount, decimals);
    return wanted !== null && wanted > held;
  };
  switch (action.kind) {
    case "hbar":
      return over(action.amount, HBAR_DECIMALS, overview.treasuryHbar);
    case "hgov":
      return over(action.amount, GOV_DECIMALS, overview.treasuryGov);
    case "baseToken":
      return action.token === "USDC"
        ? over(action.amount, USDC_DECIMALS, overview.remoteAccount.usdc)
        : over(action.amount, ETH_DECIMALS, overview.remoteAccount.eth);
    default:
      return false;
  }
}

export function NewProposalPage() {
  const { source, wallet, run, pending } = useDao();
  const router = useRouter();
  const overview = useOverview();
  const stats = useNetworkStats();
  const voter = useVoter();
  // The page is server-rendered; its buttons only work once React has hydrated it.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [actions, setActions] = useState<DraftAction[]>([]);
  const [feeCap, setFeeCap] = useState("");
  const [destGas, setDestGas] = useState(DEFAULT_DEST_GAS);
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState(false);
  const capEdited = useRef(false);
  const nextId = useRef(1);
  const addresses = source.addresses;

  const add = (kind: DraftKind) => {
    const draft = emptyDraft(kind, `d${nextId.current++}`);
    // Hedera actions run first, then the Base batch: keep the list in that order.
    setActions(list =>
      isBaseDraft(draft)
        ? [...list, draft]
        : [...list.filter(a => !isBaseDraft(a)), draft, ...list.filter(isBaseDraft)],
    );
  };

  const baseDrafts = actions.filter(isBaseDraft);
  const validBase = addresses
    ? baseDrafts.filter(a => Object.keys(validateDraft(a)).length === 0).map(a => draftToCall(a, addresses))
    : [];
  const gasText = destGas.replace(/[,_\s]/g, "");
  const gas = /^\d+$/.test(gasText) ? BigInt(gasText) : null;
  const fee = useFeeQuote(validBase.length ? validBase : null, gas ?? 0n);

  // Default cap: twice today's quote, rounded up to 0.01 HBAR, until the user edits it.
  useEffect(() => {
    if (fee.data && !capEdited.current)
      setFeeCap(formatUnitsFixed(ceilToCentiHbar(fee.data * 2n), HBAR_DECIMALS, 2).replace(/,/g, ""));
  }, [fee.data]);

  const cap = parseAmount(feeCap, HBAR_DECIMALS);
  const errors: string[] = [];
  if (!title.trim()) errors.push("Give the proposal a title.");
  if (actions.length === 0) errors.push("Add at least one action.");
  if (actions.some(a => Object.keys(validateDraft(a)).length > 0)) errors.push("Fix the highlighted fields.");
  if (baseDrafts.length && (!cap || cap === 0n)) errors.push("Set a fee cap above zero.");
  if (baseDrafts.length && (!gas || gas < 100_000n)) errors.push("Give the Base calls at least 100,000 gas.");
  const threshold = overview.data?.rules.proposalThreshold ?? 0n;
  if (voter.data && voter.data.votes < threshold) {
    errors.push(`Proposing needs ${formatVotes(threshold)} votes; you have ${formatVotes(voter.data.votes)}.`);
  }

  const built = useMemo(() => {
    if (!addresses || errors.length) return null;
    return buildProposal({ title, body, actions, feeCap: cap ?? 0n, destGasLimit: gas ?? 0n }, addresses);
    // errors is derived from the same inputs
  }, [addresses, title, body, actions, cap, gas, errors.length]);

  const cost = useQuery({
    queryKey: ["dao", source.kind, "propose-cost", built?.calldatas.join(","), built?.description, wallet.address],
    queryFn: () => source.estimate({ kind: "propose", proposal: built! }, wallet.address!),
    // An address with no Hedera account cannot be estimated for (the relay finds no sender).
    enabled: !!built && !!wallet.address && !!voter.data?.accountId,
  });

  const submit = async () => {
    setTouched(true);
    if (!built) return;
    const result = await run({ kind: "propose", proposal: built }, "Create proposal");
    if (result?.proposalId !== undefined) router.push(`/proposals/${result.proposalId}`);
  };

  const plan = useMemo(() => {
    const o = overview.data;
    if (!o) return [];
    const r = o.rules;
    const close = r.votingDelay + r.votingPeriod;
    const execute = close + 1 + r.blockClockMargin + r.timelockDelay + r.blockClockMargin;
    const steps = [
      {
        when: "now",
        what: "Proposal created",
        detail: `The network is told to queue it ${1 + r.blockClockMargin} s after voting ends.`,
      },
      { when: formatOffset(r.votingDelay), what: "Voting opens", detail: "Weights are read at this snapshot." },
      {
        when: formatOffset(close),
        what: "Voting closes",
        detail: "If it passed, the network queues it in the timelock.",
      },
      {
        when: formatOffset(execute),
        what: "The network executes it",
        detail: baseDrafts.length
          ? `One CCIP message goes to Base Sepolia${fee.data ? `, about ${formatHbar(fee.data)} from the treasury at today’s quote` : ""}.`
          : "The actions run from the treasury on Hedera.",
      },
    ];
    if (baseDrafts.length) {
      const delivery = deliveryEstimate(stats.data ?? null);
      const receipt = receiptEta(stats.data ?? null);
      steps.push(
        {
          when: delivery !== null ? formatOffset(execute + delivery) : "later",
          what: "Runs on Base Sepolia",
          detail:
            delivery !== null
              ? `Hedera to Base has taken ${formatElapsed(delivery)} lately (median of this DAO’s recent deliveries).`
              : "No delivery from this DAO has been measured yet.",
        },
        {
          when: delivery !== null && receipt !== null ? formatOffset(execute + delivery + receipt) : "later",
          what: "Receipt back on Hedera",
          detail: `Waits for Base Sepolia finality. ${finalityText(stats.data ?? null)}`,
        },
      );
    }
    return steps;
  }, [overview.data, stats.data, fee.data, baseDrafts.length]);

  const previewView = built && addresses ? describeActions(built, addresses) : null;

  if (!addresses) {
    return (
      <main className="page">
        <h1 className="page-title">New proposal</h1>
        <NotDeployed />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="vstack">
        <Link href="/" className="back">
          ← Proposals
        </Link>
        <h1 className="page-title">New proposal</h1>
      </div>
      <div className="split create">
        <form className="vstack-lg" onSubmit={e => (e.preventDefault(), submit())}>
          <section className="panel panel-pad">
            <label className="field">
              <span className="field-label strong">Title</span>
              <input
                className="dinput"
                value={title}
                onChange={e => setTitle(e.target.value)}
                aria-invalid={touched && !title.trim()}
              />
            </label>
            <label className="field">
              <span className="field-label strong">Description</span>
              <textarea className="dinput" rows={4} value={body} onChange={e => setBody(e.target.value)} />
              <span className="hint">Stored with the proposal on Hedera. Markdown is fine.</span>
            </label>
          </section>

          <section aria-labelledby="actions-title" className="panel">
            <div className="panel-head">
              <h2 id="actions-title">Actions</h2>
              <span className="small faint">
                Hedera actions run first, then the Base batch; all or nothing on each chain
              </span>
            </div>
            {actions.map((action, i) => (
              <ActionEditor
                key={action.id}
                action={action}
                index={i}
                touched={touched}
                overview={overview.data}
                addresses={addresses}
                onChange={next => setActions(list => list.map(a => (a.id === next.id ? next : a)))}
                onRemove={() => setActions(list => list.filter(a => a.id !== action.id))}
              />
            ))}
            <div className="action" style={{ borderBottom: "none" }}>
              <span style={{ fontWeight: 600 }}>Add an action</span>
              <div className="add-grid">
                <div className="add-col">
                  <span className="small faint" style={{ fontWeight: 500 }}>
                    On Hedera
                  </span>
                  {HEDERA_KINDS.map(kind => (
                    <button key={kind} type="button" className="dbtn" disabled={!hydrated} onClick={() => add(kind)}>
                      {DRAFT_LABELS[kind]}
                    </button>
                  ))}
                </div>
                <div className="add-col">
                  <span className="small faint" style={{ fontWeight: 500 }}>
                    On Base Sepolia, over Chainlink CCIP
                  </span>
                  {BASE_KINDS.map(kind => (
                    <button key={kind} type="button" className="dbtn" disabled={!hydrated} onClick={() => add(kind)}>
                      {DRAFT_LABELS[kind]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {baseDrafts.length > 0 && (
            <section aria-labelledby="ccip-title" className="panel panel-pad">
              <div className="vstack" style={{ gap: 4 }}>
                <h2 id="ccip-title">Cross-chain delivery</h2>
                <p className="small muted" style={{ margin: 0, fontSize: 14 }}>
                  {baseDrafts.length === 1
                    ? "The Base action travels in one Chainlink CCIP message and runs from the DAO’s account."
                    : `All ${baseDrafts.length} Base actions travel in one Chainlink CCIP message and run atomically from the DAO’s account.`}
                </p>
              </div>
              <div className="grid3">
                <div className="field">
                  <span className="field-label">Fee right now</span>
                  <span
                    className="mono"
                    data-testid="fee-now"
                    style={{ minHeight: 44, display: "flex", alignItems: "center", fontSize: 16 }}
                  >
                    {fee.data !== undefined
                      ? formatHbar(fee.data)
                      : validBase.length
                        ? fee.error
                          ? "Quote failed"
                          : "Quoting…"
                        : "Fill in the action to see it"}
                  </span>
                </div>
                <label className="field">
                  <span className="field-label">Fee cap you vote for</span>
                  <span className="dinput-suffix">
                    <input
                      aria-label="Fee cap in HBAR"
                      value={feeCap}
                      onChange={e => {
                        capEdited.current = true;
                        setFeeCap(e.target.value);
                      }}
                      aria-invalid={touched && (!cap || cap === 0n)}
                    />
                    <span className="small faint">HBAR</span>
                  </span>
                  {cap !== null && fee.data !== undefined && cap < fee.data && (
                    <span className="field-error">Below today’s fee: execution would wait until the fee drops.</span>
                  )}
                </label>
                <label className="field">
                  <span className="field-label">Gas on Base</span>
                  <input
                    className="dinput mono"
                    value={destGas}
                    onChange={e => setDestGas(e.target.value)}
                    aria-invalid={!gas}
                  />
                  {gas !== null && gas < 400_000n && (
                    <span className="field-error">Receiving and sending the receipt took ~362,000 gas on testnet.</span>
                  )}
                </label>
              </div>
              <p className="small faint" style={{ margin: 0 }}>
                The fee is quoted again at execution and paid from the treasury. If it is above the cap, execution waits
                and anyone can retry. The request is valid on Base for{" "}
                {overview.data ? formatDuration(overview.data.rules.requestTtl) : "its time-to-live"} after it is sent.
              </p>
            </section>
          )}
        </form>

        <aside className="vstack-lg sticky">
          <section aria-labelledby="next-title" className="panel panel-pad">
            <h2 id="next-title">After you submit</h2>
            <ol className="plan">
              {plan.map(step => (
                <li key={step.what}>
                  <span className="plan-when">{step.when}</span>
                  <div className="vstack" style={{ gap: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{step.what}</span>
                    <span className="small muted">{step.detail}</span>
                  </div>
                </li>
              ))}
            </ol>
            <div className="rule-top">
              <div className="kv">
                <span className="muted">Your voting power</span>
                <span className="mono">{voter.data ? `${formatVotes(voter.data.votes)} ${VOTE_SYMBOL}` : "—"}</span>
              </div>
              <div className="kv">
                <span className="muted">You pay to propose</span>
                <span className="mono" data-testid="propose-cost">
                  {voter.data && !voter.data.accountId
                    ? "Fund your wallet first"
                    : cost.data
                      ? `${cost.data.estimated ? "≈" : "at most"} ${formatHbar(cost.data.cost)}`
                      : "—"}
                </span>
              </div>
            </div>
            {touched && errors.length > 0 && (
              <Banner banner={{ tone: "warn", title: "Not ready yet", body: errors.join(" ") }} role="alert" />
            )}
            <button
              type="button"
              className="dbtn dbtn-primary dbtn-lg"
              disabled={wallet.wrongNetwork || pending.has("Create proposal")}
              onClick={submit}
            >
              {pending.has("Create proposal")
                ? "Sending…"
                : wallet.address
                  ? "Create proposal"
                  : "Connect wallet to propose"}
            </button>
            <button
              type="button"
              className="dbtn"
              disabled={!built}
              onClick={() => setPreview(p => !p)}
              aria-expanded={preview}
            >
              {preview ? "Hide the calls" : "Preview the calls"}
            </button>
            {preview && built && previewView && (
              <div className="vstack" data-testid="call-preview">
                <ol className="action-list panel">
                  {previewView.actions.map((a, i) => (
                    <li key={i}>
                      <span style={{ fontWeight: 600 }}>
                        {i + 1} · {a.chain === "base" ? "On Base Sepolia: " : "On Hedera: "}
                        <Parts parts={a.parts} />
                      </span>
                      <span className="small faint">{a.detail}</span>
                    </li>
                  ))}
                </ol>
                <pre className="calls">
                  {built.targets
                    .map((t, i) => `${i + 1}. ${t}\n   value ${built.values[i]} tinybar\n   ${built.calldatas[i]}`)
                    .join("\n")}
                </pre>
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
