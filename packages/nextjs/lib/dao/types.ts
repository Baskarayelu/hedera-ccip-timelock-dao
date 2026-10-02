import type { Address, Hex } from "viem";

/** OpenZeppelin `IGovernor.ProposalState`. */
export enum ProposalState {
  Pending = 0,
  Active = 1,
  Canceled = 2,
  Defeated = 3,
  Succeeded = 4,
  Queued = 5,
  Expired = 6,
  Executed = 7,
}

/** `DaoGovernor.Action`: the two network callbacks. */
export enum AutoAction {
  Queue = 0,
  Execute = 1,
}

/** `CrossChainMessages.Status`. */
export enum RemoteStatus {
  None = 0,
  Executed = 1,
  Failed = 2,
  Expired = 3,
}

export enum VoteSupport {
  Against = 0,
  For = 1,
  Abstain = 2,
}

/** A transaction seen on the mirror node or a remote chain. */
export type TxRef = { hash: Hex; timestamp: number };

/**
 * What the governor said about a proposal, in order. Raw events, so both the live source (decoded logs)
 * and the fixtures produce the same shape and go through the same derivation.
 */
export type GovernorEvent =
  | { kind: "armed"; action: AutoAction; schedule: Address; at: number; tx: TxRef }
  | { kind: "unavailable"; action: AutoAction; responseCode: number; tx: TxRef }
  | { kind: "done"; action: AutoAction; tx: TxRef }
  | { kind: "skipped"; action: AutoAction; state: ProposalState; tx: TxRef }
  | { kind: "failed"; action: AutoAction; reason: Hex; tx: TxRef }
  | { kind: "cancelled"; action: AutoAction; schedule: Address; responseCode: number; tx: TxRef }
  | { kind: "queued"; eta: number; tx: TxRef }
  | { kind: "executed"; tx: TxRef }
  | { kind: "canceled"; tx: TxRef };

/** An HSS schedule entity as the mirror node reports it. */
export type ScheduleInfo = {
  id: string; // 0.0.x
  address: Address;
  at: number; // the second it was due
  executedAt?: number; // consensus time it ran
  /** Result of the scheduled transaction, e.g. "SUCCESS" or "INSUFFICIENT_PAYER_BALANCE". */
  result?: string;
  deleted: boolean;
};

export type CrossChainRecord = {
  messageId: Hex;
  destChain: bigint;
  executor: Address;
  fee: bigint; // tinybar
  validUntil: number;
  sent: TxRef;
  /** From the CCIP explorer: has the message been executed on the destination? */
  delivery?: { state: "pending" | "success" | "failed"; tx?: Hex; timestamp?: number };
  /** From the executor's `RequestProcessed` on the remote chain. */
  remote?: { status: RemoteStatus; revertData: Hex; tx: TxRef; account: Address };
  /** From the timelock's `CrossChainReceipt` on Hedera. */
  receipt?: { status: RemoteStatus; executedAt: number; receiptMessageId: Hex; revertData: Hex; tx: TxRef };
};

export type VoteRecord = { voter: Address; support: VoteSupport; weight: bigint; tx: TxRef };

export type ProposalRecord = {
  id: bigint;
  /** 1-based position in creation order; shown as "#n". */
  number: number;
  proposer: Address;
  description: string;
  descriptionHash: Hex;
  targets: Address[];
  values: bigint[];
  calldatas: Hex[];
  created: TxRef;
  /** Vote snapshot (timestamp clock) and deadline. */
  voteStart: number;
  voteEnd: number;
  state: ProposalState;
  votes: { against: bigint; for: bigint; abstain: bigint };
  /** Quorum at the snapshot; for a pending proposal, what it would be now. */
  quorum: bigint;
  /** Vote-token supply at the snapshot (null while the snapshot is in the future). */
  supplyAtSnapshot: bigint | null;
  eta: number; // 0 until queued
  events: GovernorEvent[];
  schedules: Partial<Record<AutoAction, ScheduleInfo>>;
  crossChain: CrossChainRecord[];
  viewer?: {
    address: Address;
    /** Votes at the snapshot, or current votes while the snapshot is in the future. */
    votingPower: bigint;
    vote?: VoteRecord;
  };
};

export type DaoRules = {
  votingDelay: number;
  votingPeriod: number;
  timelockDelay: number;
  quorumNumerator: bigint;
  quorumDenominator: bigint;
  proposalThreshold: bigint;
  blockClockMargin: number;
  autoGas: Record<AutoAction, bigint>;
  requestTtl: number;
};

export type DaoOverview = {
  rules: DaoRules;
  /** tinybar */
  treasuryHbar: bigint;
  treasuryGov: bigint;
  /** The governor's balance, which pays the network for its callbacks. */
  floatHbar: bigint;
  voteSupply: bigint;
  /** tinybar per gas */
  gasPrice: bigint;
  remoteAccount: { address: Address; deployed: boolean; eth: bigint; usdc: bigint };
};

export type VoterStatus = {
  address: Address;
  /** null when the address has no Hedera account yet (never received HBAR). */
  accountId: string | null;
  hbar: bigint; // tinybar
  associated: boolean;
  /** Free automatic-association slots: -1 means unlimited. */
  autoAssociationSlots: number;
  gov: bigint;
  voteBalance: bigint;
  votes: bigint;
  delegate: Address | null;
  allowance: bigint;
  lastClaimAt: number; // 0 = never
  claimCooldown: number;
  claimAmount: bigint;
};

export type NetworkStats = {
  /** How far Base Sepolia's finalized head trails its latest block, in seconds. */
  baseFinalityLag: number | null;
  /** Recent Hedera -> Base deliveries of this DAO's requests: seconds from send to remote execution. */
  deliverySeconds: number[];
  /** Recent receipts: seconds from their source block's finality on Base to landing on Hedera. */
  receiptOverheadSeconds: number[];
};

/** One call the DAO's account makes on Base. */
export type RemoteCall = { target: Address; value: bigint; data: Hex };

export type BuiltProposal = {
  targets: Address[];
  values: bigint[];
  calldatas: Hex[];
  description: string;
};

export type DaoTx =
  | { kind: "associate" }
  | { kind: "claim" }
  | { kind: "approve"; amount: bigint }
  | { kind: "wrap"; amount: bigint }
  | { kind: "unwrap"; amount: bigint }
  | { kind: "delegate"; to: Address }
  | { kind: "propose"; proposal: BuiltProposal }
  | { kind: "vote"; proposalId: bigint; support: VoteSupport }
  | { kind: "queue"; proposal: ProposalRecord }
  | { kind: "execute"; proposal: ProposalRecord }
  | { kind: "rearm"; proposal: ProposalRecord; action: AutoAction }
  | { kind: "cancel"; proposal: ProposalRecord };

export type TxResult = { hash: Hex; ok: boolean; proposalId?: bigint };
