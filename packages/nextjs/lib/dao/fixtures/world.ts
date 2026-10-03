import { daoTimelockAbi } from "../abis";
import { BASE_SELECTOR } from "../config";
import { type DaoAddresses, crossChainBundle, hederaValueTotal } from "../proposal";
import type { DaoSource } from "../source";
import { GAS_FLOOR } from "../source";
import {
  AutoAction,
  type BuiltProposal,
  type CrossChainRecord,
  type DaoOverview,
  type DaoRules,
  type DaoTx,
  type NetworkStats,
  type ProposalRecord,
  ProposalState,
  type RemoteCall,
  RemoteStatus,
  type TxRef,
  type TxResult,
  type VoteRecord,
  VoteSupport,
  type VoterStatus,
} from "../types";
import { addressOfEntity } from "../units";
import { type Address, type Hex, encodeAbiParameters, encodeErrorResult, getAddress, keccak256, toBytes } from "viem";

/**
 * A scripted DAO for the e2e tests. It keeps raw state like the contracts do (balances, checkpoints,
 * proposals, schedules) and simulates the network: scheduled callbacks fire at their second, CCIP delivers
 * after `knobs.deliverySeconds`, receipts land after `knobs.receiptSeconds`. Scenarios drive it with the same
 * actions a user takes, then move the clock.
 */

/** Gas price the simulator bills at (tinybar per gas). */
const GAS_PRICE = 86n;
/** Gas each callback used on testnet for a one-call proposal (docs/costs.md). The float pays this, not the limit. */
const CALLBACK_GAS_USED: Record<AutoAction, bigint> = {
  [AutoAction.Queue]: 1_610_000n,
  [AutoAction.Execute]: 470_000n,
};

type Holder = {
  /** False for an EVM address that has never received HBAR, so Hedera has no account for it. */
  hasAccount: boolean;
  hbar: bigint;
  associated: boolean;
  autoSlots: number;
  gov: bigint;
  vote: bigint;
  delegate: Address | null;
  allowance: bigint;
  lastClaimAt: number;
};

type SimProposal = ProposalRecord & {
  voters: Map<string, VoteRecord>;
  queuedAt?: number;
  executedFlag?: boolean;
  canceledFlag?: boolean;
  fired: Set<string>;
};

export type Knobs = {
  /** CCIP fee the router quotes (tinybar). */
  fee: bigint;
  deliverySeconds: number;
  receiptSeconds: number;
  /** What the DAO's account on Base reports for the next request. */
  remote: { status: RemoteStatus; revertData: Hex };
  /** CCIP itself fails the delivery (executor out of gas). */
  deliveryFails: boolean;
  /** The float cannot pay when this callback fires. */
  unfunded: Set<AutoAction>;
  /** Response code the schedule service returns when arming (22 = success). */
  armCode: number;
};

const TX_DELAY = 2; // seconds of consensus per user transaction

export class FixtureWorld implements DaoSource {
  readonly kind = "fixture" as const;
  wallet: { address: Address | null; chainId: number };
  now: () => number;
  private clock: number;
  private listeners = new Set<() => void>();
  private nonce = 0;
  private scheduleCounter = 10_900_000;
  private holders = new Map<string, Holder>();
  private voteCheckpoints: { t: number; account: string; delta: bigint }[] = [];
  private supplyCheckpoints: { t: number; delta: bigint }[] = [];
  private props: SimProposal[] = [];
  treasuryHbar: bigint;
  treasuryGov = 0n;
  floatHbar: bigint;
  remoteAccount = { eth: 4_000_000_000_000_000n, usdc: 250_000_000n, deployed: true };
  stats: NetworkStats;
  knobs: Knobs;
  /** Milliseconds each fixture transaction "takes", so pending states render. */
  latencyMs = 250;

  constructor(
    readonly addresses: DaoAddresses,
    readonly rules: DaoRules,
    start: number,
    init: { treasuryHbar: bigint; floatHbar: bigint; knobs: Knobs; stats: NetworkStats },
  ) {
    this.clock = start;
    this.now = () => this.clock;
    this.wallet = { address: null, chainId: 296 };
    this.treasuryHbar = init.treasuryHbar;
    this.floatHbar = init.floatHbar;
    this.knobs = init.knobs;
    this.stats = init.stats;
  }

  // -------------------------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------------------------

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.listeners.forEach(l => l());
  }

  private tx(): TxRef {
    this.nonce += 1;
    return { hash: keccak256(toBytes(`fixture-tx-${this.nonce}`)), timestamp: this.clock };
  }

  holder(address: Address): Holder {
    const key = address.toLowerCase();
    let h = this.holders.get(key);
    if (!h) {
      h = {
        hasAccount: true,
        hbar: 50n * 10n ** 8n,
        associated: false,
        autoSlots: 0,
        gov: 0n,
        vote: 0n,
        delegate: null,
        allowance: 0n,
        lastClaimAt: 0,
      };
      this.holders.set(key, h);
    }
    return h;
  }

  private votesAt(account: Address, t: number) {
    const key = account.toLowerCase();
    return this.voteCheckpoints.filter(c => c.account === key && c.t <= t).reduce((s, c) => s + c.delta, 0n);
  }

  private supplyAt(t: number) {
    return this.supplyCheckpoints.filter(c => c.t <= t).reduce((s, c) => s + c.delta, 0n);
  }

  private moveVotes(from: Address | null, to: Address | null, amount: bigint) {
    if (from) this.voteCheckpoints.push({ t: this.clock, account: from.toLowerCase(), delta: -amount });
    if (to) this.voteCheckpoints.push({ t: this.clock, account: to.toLowerCase(), delta: amount });
  }

  private stateOf(p: SimProposal): ProposalState {
    if (p.executedFlag) return ProposalState.Executed;
    if (p.canceledFlag) return ProposalState.Canceled;
    if (p.voteStart >= this.clock) return ProposalState.Pending;
    if (p.voteEnd >= this.clock) return ProposalState.Active;
    const quorumReached = p.votes.for + p.votes.abstain >= this.quorumAt(p.voteStart);
    if (!quorumReached || p.votes.for <= p.votes.against) return ProposalState.Defeated;
    return p.eta ? ProposalState.Queued : ProposalState.Succeeded;
  }

  private quorumAt(t: number) {
    return (this.supplyAt(t) * this.rules.quorumNumerator) / this.rules.quorumDenominator;
  }

  private arm(p: SimProposal, action: AutoAction, at: number) {
    const tx = this.tx();
    if (this.knobs.armCode !== 22) {
      p.events.push({ kind: "unavailable", action, responseCode: this.knobs.armCode, tx });
      return;
    }
    this.scheduleCounter += 1;
    const address = addressOfEntity(`0.0.${this.scheduleCounter}`);
    p.schedules[action] = { id: `0.0.${this.scheduleCounter}`, address, at, deleted: false };
    p.events.push({ kind: "armed", action, schedule: address, at, tx });
  }

  private requireWallet() {
    if (!this.wallet.address) throw new Error("Connect a wallet first.");
    if (this.wallet.chainId !== 296) throw new Error("Switch to Hedera testnet first.");
    return this.wallet.address;
  }

  // -------------------------------------------------------------------------------------------
  // Network simulation
  // -------------------------------------------------------------------------------------------

  /** Moves the clock forward, firing every scheduled callback and cross-chain step that falls due. */
  advance(seconds: number) {
    this.advanceTo(this.clock + seconds);
  }

  advanceTo(target: number) {
    for (let guard = 0; guard < 1000; guard++) {
      const next = this.nextDue();
      if (!next || next.at > target) break;
      this.clock = Math.max(this.clock, next.at);
      next.run();
    }
    this.clock = Math.max(this.clock, target);
    this.emit();
  }

  private nextDue(): { at: number; run: () => void } | null {
    const due: { at: number; run: () => void }[] = [];
    for (const p of this.props) {
      for (const action of [AutoAction.Queue, AutoAction.Execute]) {
        const s = p.schedules[action];
        const key = `${action}:${s?.id}`;
        if (s && !s.deleted && !p.fired.has(key)) {
          due.push({
            at: s.at,
            run: () => {
              p.fired.add(key);
              this.fire(p, action);
            },
          });
        }
      }
      for (const m of p.crossChain) {
        if (!m.delivery) {
          due.push({ at: m.sent.timestamp + this.knobs.deliverySeconds, run: () => this.deliver(m) });
        } else if (m.remote && !m.receipt) {
          due.push({ at: m.remote.tx.timestamp + this.knobs.receiptSeconds, run: () => this.receive(m) });
        }
      }
    }
    due.sort((a, b) => a.at - b.at);
    return due[0] ?? null;
  }

  private fire(p: SimProposal, action: AutoAction) {
    const s = p.schedules[action]!;
    s.executedAt = this.clock + 0.04;
    if (this.knobs.unfunded.has(action)) {
      s.result = "INSUFFICIENT_PAYER_BALANCE";
      return;
    }
    s.result = "SUCCESS";
    // Hedera bills the gas used; the limit only has to be in the float when the call fires.
    this.floatHbar -= CALLBACK_GAS_USED[action] * GAS_PRICE;
    const state = this.stateOf(p);
    const expected = action === AutoAction.Queue ? ProposalState.Succeeded : ProposalState.Queued;
    if (state !== expected) {
      p.events.push({ kind: "skipped", action, state, tx: this.tx() });
      return;
    }
    const failure = action === AutoAction.Queue ? null : this.executionFailure(p);
    if (failure) {
      p.events.push({ kind: "failed", action, reason: failure, tx: this.tx() });
      return;
    }
    if (action === AutoAction.Queue) this.doQueue(p, true);
    else this.doExecute(p, true);
  }

  /** Why executing now would revert, as revert data, or null. */
  private executionFailure(p: SimProposal): Hex | null {
    const bundle = crossChainBundle(p, this.addresses.timelock);
    if (bundle && this.knobs.fee > bundle.feeCap) {
      return encodeErrorResult({
        abi: daoTimelockAbi,
        errorName: "FeeAboveCap",
        args: [this.knobs.fee, bundle.feeCap],
      });
    }
    const need = hederaValueTotal(p) + (bundle ? this.knobs.fee : 0n);
    if (this.treasuryHbar < need) return encodeErrorResult({ abi: daoTimelockAbi, errorName: "FailedCall" });
    return null;
  }

  private doQueue(p: SimProposal, byNetwork: boolean) {
    const tx = this.tx();
    p.eta = this.clock + this.rules.timelockDelay;
    p.events.push({ kind: "queued", eta: p.eta, tx });
    if (byNetwork) p.events.push({ kind: "done", action: AutoAction.Queue, tx });
    this.arm(p, AutoAction.Execute, p.eta + this.rules.blockClockMargin);
  }

  private doExecute(p: SimProposal, byNetwork: boolean) {
    const tx = this.tx();
    p.executedFlag = true;
    const bundle = crossChainBundle(p, this.addresses.timelock);
    this.treasuryHbar -= hederaValueTotal(p);
    p.events.push({ kind: "executed", tx });
    if (byNetwork) p.events.push({ kind: "done", action: AutoAction.Execute, tx });
    if (bundle) {
      this.treasuryHbar -= this.knobs.fee;
      p.crossChain.push({
        messageId: keccak256(toBytes(`fixture-message-${p.id}`)),
        destChain: BASE_SELECTOR,
        executor: getAddress("0x9b7691b0766a55d8509b07cb633ce281fee2a632"),
        fee: this.knobs.fee,
        validUntil: this.clock + this.rules.requestTtl,
        sent: tx,
      });
    }
  }

  private deliver(m: CrossChainRecord) {
    const tx = { ...this.tx(), timestamp: this.clock };
    if (this.knobs.deliveryFails) {
      m.delivery = { state: "failed", tx: tx.hash, timestamp: this.clock };
      return;
    }
    const expired = this.clock > m.validUntil;
    const status = expired ? RemoteStatus.Expired : this.knobs.remote.status;
    m.delivery = { state: "success", tx: tx.hash, timestamp: this.clock };
    m.remote = {
      status,
      revertData: status === RemoteStatus.Failed ? this.knobs.remote.revertData : "0x",
      tx,
      account: this.addresses.remoteAccount,
    };
  }

  private receive(m: CrossChainRecord) {
    const remote = m.remote!;
    m.receipt = {
      status: remote.status,
      executedAt: remote.tx.timestamp,
      receiptMessageId: keccak256(toBytes(`receipt-${m.messageId}`)),
      revertData: remote.revertData,
      tx: this.tx(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // DaoSource reads
  // -------------------------------------------------------------------------------------------

  async overview(): Promise<DaoOverview> {
    return {
      rules: this.rules,
      treasuryHbar: this.treasuryHbar,
      treasuryGov: this.treasuryGov,
      floatHbar: this.floatHbar,
      voteSupply: this.supplyAt(this.clock),
      gasPrice: GAS_PRICE,
      remoteAccount: { address: this.addresses.remoteAccount, ...this.remoteAccount },
    };
  }

  async proposals(viewer?: Address): Promise<ProposalRecord[]> {
    return this.props.map(p => {
      const state = this.stateOf(p);
      const snapshotPassed = p.voteStart < this.clock;
      const record: ProposalRecord = {
        ...p,
        state,
        votes: { ...p.votes },
        quorum: this.quorumAt(snapshotPassed ? p.voteStart : this.clock),
        supplyAtSnapshot: snapshotPassed ? this.supplyAt(p.voteStart) : null,
        events: [...p.events],
        schedules: Object.fromEntries(Object.entries(p.schedules).map(([k, v]) => [k, { ...v }])),
        crossChain: p.crossChain.map(m => ({ ...m })),
        viewer: viewer
          ? {
              address: viewer,
              votingPower: snapshotPassed ? this.votesAt(viewer, p.voteStart) : this.votesAt(viewer, this.clock),
              vote: p.voters.get(viewer.toLowerCase()),
            }
          : undefined,
      };
      return record;
    });
  }

  async voter(address: Address): Promise<VoterStatus> {
    const h = this.holder(address);
    return {
      address,
      accountId: h.hasAccount ? "0.0.10813603" : null,
      hbar: h.hbar,
      associated: h.associated,
      autoAssociationSlots: h.autoSlots,
      gov: h.gov,
      voteBalance: h.vote,
      votes: this.votesAt(address, this.clock),
      delegate: h.delegate,
      allowance: h.allowance,
      lastClaimAt: h.lastClaimAt,
      claimCooldown: 86_400,
      claimAmount: 1_000_000_000n,
    };
  }

  async network(): Promise<NetworkStats> {
    return this.stats;
  }

  async quoteFee(calls: readonly RemoteCall[]): Promise<bigint> {
    return calls.length ? this.knobs.fee : 0n;
  }

  async estimate(tx: DaoTx): Promise<{ gas: bigint; cost: bigint; estimated: boolean }> {
    const gas = GAS_FLOOR[tx.kind];
    return { gas, cost: gas * GAS_PRICE, estimated: true };
  }

  // -------------------------------------------------------------------------------------------
  // DaoSource writes: what the contracts would do
  // -------------------------------------------------------------------------------------------

  async send(tx: DaoTx, from: Address): Promise<TxResult> {
    this.requireWallet();
    await new Promise(r => setTimeout(r, this.latencyMs));
    const result = this.apply(tx, from);
    this.emit();
    return result;
  }

  /** Applies a transaction synchronously (scenarios use this to set up history). */
  apply(tx: DaoTx, from: Address): TxResult {
    this.clock += TX_DELAY;
    const h = this.holder(from);
    const ref = this.tx();
    const ok = (extra: Partial<TxResult> = {}): TxResult => ({ hash: ref.hash, ok: true, ...extra });
    switch (tx.kind) {
      case "associate":
        h.associated = true;
        return ok();
      case "claim": {
        if (h.lastClaimAt && this.clock < h.lastClaimAt + 86_400)
          throw new Error("this account claimed within the cooldown");
        if (!h.associated && h.autoSlots === 0) throw new Error("the account is not associated with HGOV");
        if (!h.associated) {
          h.associated = true;
          if (h.autoSlots > 0) h.autoSlots -= 1;
        }
        h.gov += 1_000_000_000n;
        h.lastClaimAt = this.clock;
        return ok();
      }
      case "approve":
        h.allowance = tx.amount;
        return ok();
      case "wrap":
        if (h.allowance < tx.amount || h.gov < tx.amount) throw new Error("allowance or balance too low");
        h.allowance -= tx.amount;
        h.gov -= tx.amount;
        h.vote += tx.amount;
        this.supplyCheckpoints.push({ t: this.clock, delta: tx.amount });
        this.moveVotes(null, h.delegate, tx.amount);
        return ok();
      case "unwrap":
        h.vote -= tx.amount;
        h.gov += tx.amount;
        this.supplyCheckpoints.push({ t: this.clock, delta: -tx.amount });
        this.moveVotes(h.delegate, null, tx.amount);
        return ok();
      case "delegate":
        this.moveVotes(h.delegate, tx.to, h.vote);
        h.delegate = tx.to;
        return ok();
      case "propose":
        return ok({ proposalId: this.createProposal(tx.proposal, from, ref) });
      case "vote": {
        const p = this.find(tx.proposalId);
        if (this.stateOf(p) !== ProposalState.Active) throw new Error("voting is not open");
        if (p.voters.has(from.toLowerCase())) throw new Error("this account already voted");
        const weight = this.votesAt(from, p.voteStart);
        const key = tx.support === VoteSupport.For ? "for" : tx.support === VoteSupport.Against ? "against" : "abstain";
        p.votes[key] += weight;
        p.voters.set(from.toLowerCase(), { voter: from, support: tx.support, weight, tx: ref });
        return ok();
      }
      case "queue": {
        const p = this.find(tx.proposal.id);
        if (this.stateOf(p) !== ProposalState.Succeeded) throw new Error("the proposal is not ready to queue");
        this.doQueue(p, false);
        return ok();
      }
      case "execute": {
        const p = this.find(tx.proposal.id);
        if (this.stateOf(p) !== ProposalState.Queued || this.clock < p.eta)
          throw new Error("the timelock has not ended");
        const failure = this.executionFailure(p);
        if (failure) throw Object.assign(new Error("execution reverted"), { cause: { data: failure } });
        this.doExecute(p, false);
        return ok();
      }
      case "rearm": {
        const p = this.find(tx.proposal.id);
        const at = Math.max(
          this.clock + 1,
          (tx.action === AutoAction.Queue ? p.voteEnd + 1 : p.eta) + this.rules.blockClockMargin,
        );
        this.arm(p, tx.action, at);
        return ok();
      }
      case "cancel": {
        const p = this.find(tx.proposal.id);
        if (this.stateOf(p) !== ProposalState.Pending) throw new Error("only a pending proposal can be cancelled");
        p.canceledFlag = true;
        p.events.push({ kind: "canceled", tx: ref });
        const s = p.schedules[AutoAction.Queue];
        if (s) {
          s.deleted = true;
          p.events.push({
            kind: "cancelled",
            action: AutoAction.Queue,
            schedule: s.address,
            responseCode: 22,
            tx: ref,
          });
        }
        return ok();
      }
    }
  }

  private find(id: bigint) {
    const p = this.props.find(x => x.id === id);
    if (!p) throw new Error("unknown proposal");
    return p;
  }

  private createProposal(proposal: BuiltProposal, proposer: Address, ref: TxRef): bigint {
    const descriptionHash = keccak256(toBytes(proposal.description));
    const id = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }],
          [proposal.targets, proposal.values, proposal.calldatas, descriptionHash],
        ),
      ),
    );
    const voteStart = this.clock + this.rules.votingDelay;
    const p: SimProposal = {
      id,
      number: this.props.length + 1,
      proposer,
      description: proposal.description,
      descriptionHash,
      targets: proposal.targets,
      values: proposal.values,
      calldatas: proposal.calldatas,
      created: ref,
      voteStart,
      voteEnd: voteStart + this.rules.votingPeriod,
      state: ProposalState.Pending,
      votes: { against: 0n, for: 0n, abstain: 0n },
      quorum: 0n,
      supplyAtSnapshot: null,
      eta: 0,
      events: [],
      schedules: {},
      crossChain: [],
      voters: new Map(),
      fired: new Set(),
    };
    this.props.push(p);
    this.arm(p, AutoAction.Queue, p.voteEnd + 1 + this.rules.blockClockMargin);
    return id;
  }

  /** Test hooks exposed on `window.__dao` in fixture mode. */
  hooks() {
    return {
      advance: (seconds: number) => this.advance(seconds),
      now: () => this.clock,
      setFee: (tinybar: string) => {
        this.knobs.fee = BigInt(tinybar);
        this.emit();
      },
      connect: () => this.connect(),
    };
  }

  connect(address: Address = getAddress("0x3f243741e066f6f9C061DF1B94E215921c321Bd7")) {
    this.wallet = { ...this.wallet, address };
    this.emit();
  }

  disconnect() {
    this.wallet = { ...this.wallet, address: null };
    this.emit();
  }

  switchToHedera() {
    this.wallet = { ...this.wallet, chainId: 296 };
    this.emit();
  }
}
