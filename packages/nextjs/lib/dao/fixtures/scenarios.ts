import { daoAccountAbi, daoGovernorAbi, voteTokenAbi } from "../abis";
import { deployment } from "../config";
import { type DaoAddresses, type DraftAction, buildProposal } from "../proposal";
import { AutoAction, type DaoRules, RemoteStatus, VoteSupport } from "../types";
import { addressOfEntity } from "../units";
import { FixtureWorld, type Knobs } from "./world";
import { type Address, encodeErrorResult, encodeFunctionData, getAddress } from "viem";

/** 2026-10-02 14:20:01 UTC: the focus proposal is created at this second in every detail scenario. */
export const T0 = Date.UTC(2026, 9, 2, 14, 20, 1) / 1000;

export const VIEWER = getAddress("0x3f243741e066f6f9C061DF1B94E215921c321Bd7");
const ALICE = getAddress("0x9b1c5f8e2d4a7b3c6e0f1a2b3c4d5e6f7a8b44fa");
const BOB = getAddress("0x5e2d8c1b4a7f0e3d6c9b2a5f8e1d4c7b0a3f6e19");
const CAROL = getAddress("0xc0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3");
const DAVE = getAddress("0xd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607");

const ADDRESSES: DaoAddresses = {
  governor: addressOfEntity("0.0.10900001"),
  timelock: addressOfEntity("0.0.10900002"),
  voteToken: addressOfEntity("0.0.10900003"),
  faucet: addressOfEntity("0.0.10900004"),
  governanceToken: addressOfEntity("0.0.10900005"),
  remoteParameters: deployment.base.remoteParameters,
  usdc: deployment.base.usdc,
  remoteAccount: getAddress("0x7a91d1e3b0c4a6f55e1d1f2e9b8c3a4d5e6fc2e0"),
};

const RULES: DaoRules = {
  votingDelay: 60,
  votingPeriod: 300,
  timelockDelay: 120,
  quorumNumerator: 4n,
  quorumDenominator: 100n,
  proposalThreshold: 0n,
  blockClockMargin: 4,
  autoGas: { [AutoAction.Queue]: 3_000_000n, [AutoAction.Execute]: 1_500_000n },
  requestTtl: 86_400,
};

const HBAR = 100_000_000n;
const GOV = 1_000_000n;

function knobs(overrides: Partial<Knobs> = {}): Knobs {
  return {
    fee: 107_369_438n,
    deliverySeconds: 35,
    receiptSeconds: 22 * 60 + 34,
    remote: { status: RemoteStatus.Executed, revertData: "0x" },
    deliveryFails: false,
    unfunded: new Set(),
    armCode: 22,
    ...overrides,
  };
}

function world(start: number, overrides: Partial<Knobs> = {}, treasuryHbar = 20n * HBAR) {
  return new FixtureWorld(ADDRESSES, RULES, start, {
    treasuryHbar,
    floatHbar: 15n * HBAR,
    knobs: knobs(overrides),
    stats: { baseFinalityLag: 23 * 60, deliverySeconds: [34, 35, 37], receiptOverheadSeconds: [55, 62, 70] },
  });
}

/** Associate, claim, wrap `amount` and (optionally) delegate to self, as a user would. */
function setUpHolder(w: FixtureWorld, who: Address, amount: bigint, delegate = true) {
  w.apply({ kind: "associate" }, who);
  w.apply({ kind: "claim" }, who);
  w.apply({ kind: "approve", amount }, who);
  w.apply({ kind: "wrap", amount }, who);
  if (delegate) w.apply({ kind: "delegate", to: who }, who);
}

const id = (n: number) => `a${n}`;

const BASE_DRAFT: { title: string; body: string; actions: DraftAction[] } = {
  title: "Set the protocol fee to 30 bps and pay the Q4 grant",
  body: "Lowers the Base deployment’s fee from 45 to 30 bps and pays the Q4 grant to the indexer team from the DAO’s Base account.",
  actions: [
    { id: id(1), kind: "param", key: "protocol.feeBps", value: "30" },
    { id: id(2), kind: "baseToken", token: "USDC", amount: "100", to: ALICE },
  ],
};

const draft = (d: typeof BASE_DRAFT, feeCap = 2n * HBAR) =>
  buildProposal({ ...d, feeCap, destGasLimit: 600_000n }, ADDRESSES);

const hederaGasDraft = {
  title: "Raise the execution callback gas to 2,000,000",
  body: "Gives the network’s execute callback more headroom for larger batches.",
  actions: [
    {
      id: id(3),
      kind: "hederaCall",
      target: ADDRESSES.governor,
      value: "0",
      data: encodeFunctionData({
        abi: daoGovernorAbi,
        functionName: "setAutoGasLimit",
        args: [AutoAction.Execute, 2_000_000n],
      }),
    },
  ] as DraftAction[],
};

/** Proposes so that the transaction lands exactly at `at`. */
function proposeAt(w: FixtureWorld, at: number, d: typeof BASE_DRAFT, from = VIEWER, feeCap?: bigint) {
  w.advanceTo(at - 2);
  const { proposalId } = w.apply({ kind: "propose", proposal: draft(d, feeCap) }, from);
  return proposalId!;
}

function voteAt(w: FixtureWorld, at: number, proposalId: bigint, votes: [Address, VoteSupport][]) {
  w.advanceTo(at);
  for (const [who, support] of votes) w.apply({ kind: "vote", proposalId, support }, who);
}

/** Five holders with 1,000 vHGOV between them; the viewer has 400. */
function community(w: FixtureWorld, viewerDelegates = true, at = T0 - 3600) {
  w.advanceTo(at);
  setUpHolder(w, VIEWER, 400n * GOV, viewerDelegates);
  setUpHolder(w, ALICE, 200n * GOV);
  setUpHolder(w, BOB, 300n * GOV);
  setUpHolder(w, CAROL, 70n * GOV);
  setUpHolder(w, DAVE, 30n * GOV);
}

type Build = () => FixtureWorld;

const passed: [Address, VoteSupport][] = [
  [VIEWER, VoteSupport.For],
  [ALICE, VoteSupport.For],
  [BOB, VoteSupport.Against],
];

/** A proposal created at T0 (14:20:01), voted 600 for / 300 against, then the clock moved to `now`. */
function focus(
  now: number,
  overrides: Partial<Knobs> = {},
  opts: { treasuryHbar?: bigint; votes?: [Address, VoteSupport][]; d?: typeof BASE_DRAFT; feeCap?: bigint } = {},
): FixtureWorld {
  const w = world(T0 - 7200, overrides, opts.treasuryHbar);
  community(w);
  const pid = proposeAt(w, T0, opts.d ?? BASE_DRAFT, VIEWER, opts.feeCap);
  const votes = opts.votes ?? passed;
  if (votes.length) voteAt(w, T0 + 70, pid, votes);
  w.advanceTo(now);
  w.connect(VIEWER);
  return w;
}

const failedUsdc = encodeErrorResult({
  abi: daoAccountAbi,
  errorName: "CallFailed",
  args: [
    1n,
    encodeErrorResult({
      abi: voteTokenAbi,
      errorName: "ERC20InsufficientBalance",
      args: [ADDRESSES.remoteAccount, 40_000_000n, 100_000_000n],
    }),
  ],
});

export const SCENARIOS: Record<string, Build> = {
  // --- Proposals list -------------------------------------------------------------------------
  list: () => {
    const w = world(T0 - 9000);
    community(w, true, T0 - 8000);
    const p1 = proposeAt(w, T0 - 5400, {
      title: "Send 5 HBAR to the community wallet",
      body: "Funds the community wallet for meetup costs.",
      actions: [{ id: id(4), kind: "hbar", to: CAROL, amount: "5" }],
    });
    voteAt(w, T0 - 5330, p1, [[DAVE, VoteSupport.For]]);
    const p2 = proposeAt(w, T0 - 4000, hederaGasDraft);
    voteAt(w, T0 - 3930, p2, [
      [VIEWER, VoteSupport.For],
      [BOB, VoteSupport.For],
    ]);
    const p3 = proposeAt(w, T0 - 3000, {
      title: "Set treasury.cap to 5,000 on Base",
      body: "Caps what the Base treasury module may hold.",
      actions: [{ id: id(5), kind: "param", key: "treasury.cap", value: "5000" }],
    });
    voteAt(w, T0 - 2930, p3, [
      [VIEWER, VoteSupport.For],
      [ALICE, VoteSupport.For],
      [BOB, VoteSupport.For],
      [CAROL, VoteSupport.For],
      [DAVE, VoteSupport.For],
    ]);
    const p4 = proposeAt(w, T0 - 400, {
      title: "Pay a 100 USDC grant from the DAO’s Base account",
      body: "Q4 grant to the indexer team.",
      actions: [{ id: id(6), kind: "baseToken", token: "USDC", amount: "100", to: ALICE }],
    });
    voteAt(w, T0 - 330, p4, passed);
    const p5 = proposeAt(w, T0 - 100, {
      title: "Set the protocol fee to 30 bps on Base",
      body: "Lowers the fee from 45 bps.",
      actions: [{ id: id(7), kind: "param", key: "protocol.feeBps", value: "30" }],
    });
    voteAt(w, T0 - 35, p5, [
      [VIEWER, VoteSupport.For],
      [BOB, VoteSupport.For],
    ]);
    w.advanceTo(T0);
    w.connect(VIEWER);
    return w;
  },
  empty: () => {
    const w = world(T0 - 3600);
    community(w);
    w.advanceTo(T0);
    w.connect(VIEWER);
    return w;
  },
  wrongNetwork: () => {
    const w = SCENARIOS.list();
    w.wallet = { ...w.wallet, chainId: 11155111 };
    return w;
  },
  noWallet: () => {
    const w = SCENARIOS.list();
    w.disconnect();
    return w;
  },

  // --- Voting power ---------------------------------------------------------------------------
  claim: () => {
    const w = world(T0 - 600);
    w.apply({ kind: "associate" }, VIEWER);
    w.advanceTo(T0);
    w.connect(VIEWER);
    return w;
  },
  noAccount: () => {
    const w = world(T0);
    const h = w.holder(VIEWER);
    h.hasAccount = false;
    h.hbar = 0n;
    w.connect(VIEWER);
    return w;
  },
  notAssociated: () => {
    const w = world(T0);
    w.connect(VIEWER);
    return w;
  },
  autoAssociates: () => {
    const w = world(T0);
    w.holder(VIEWER).autoSlots = -1;
    w.connect(VIEWER);
    return w;
  },
  claimedRecently: () => {
    const w = world(Date.UTC(2026, 9, 2, 9, 13, 58) / 1000);
    w.apply({ kind: "associate" }, VIEWER);
    w.apply({ kind: "claim" }, VIEWER);
    w.advanceTo(T0);
    w.connect(VIEWER);
    return w;
  },
  notDelegated: () => {
    const w = world(T0 - 600);
    setUpHolder(w, VIEWER, 1000n * GOV, false);
    w.advanceTo(T0);
    w.connect(VIEWER);
    return w;
  },
  /** The e2e happy path starts here: four other holders, the viewer has nothing yet. */
  fresh: () => {
    const w = world(T0 - 3600);
    setUpHolder(w, ALICE, 200n * GOV);
    setUpHolder(w, BOB, 300n * GOV);
    setUpHolder(w, CAROL, 70n * GOV);
    setUpHolder(w, DAVE, 30n * GOV);
    w.advanceTo(T0 - 300);
    w.connect(VIEWER);
    return w;
  },

  // --- Proposal detail ------------------------------------------------------------------------
  pending: () => focus(T0 + 30, {}, { votes: [] }),
  active: () => {
    const w = world(T0 - 7200);
    community(w);
    const pid = proposeAt(w, T0, BASE_DRAFT, BOB);
    voteAt(w, T0 + 70, pid, [
      [ALICE, VoteSupport.For],
      [CAROL, VoteSupport.For],
      [DAVE, VoteSupport.For],
    ]);
    w.advanceTo(T0 + 180);
    w.connect(VIEWER);
    return w;
  },
  activeNoPower: () => {
    const w = world(T0 - 7200);
    community(w, false);
    const pid = proposeAt(w, T0, BASE_DRAFT, BOB);
    voteAt(w, T0 + 70, pid, [
      [ALICE, VoteSupport.For],
      [CAROL, VoteSupport.For],
      [DAVE, VoteSupport.For],
    ]);
    w.apply({ kind: "delegate", to: VIEWER }, VIEWER); // after the snapshot: counts from the next proposal
    w.advanceTo(T0 + 180);
    w.connect(VIEWER);
    return w;
  },
  queued: () => focus(T0 + 417),
  queueFailed: () => focus(T0 + 500, { unfunded: new Set([AutoAction.Queue]) }),
  inFlight: () => focus(T0 + 509),
  receiptPending: () => focus(T0 + 600),
  done: () => focus(T0 + 2000),
  remoteFailed: () => focus(T0 + 2000, { remote: { status: RemoteStatus.Failed, revertData: failedUsdc } }),
  expired: () => focus(T0 + 88_000 + 1_500, { deliverySeconds: 86_400 + 600 }),
  deliveryFailed: () => focus(T0 + 600, { deliveryFails: true }),
  feeAboveCap: () => focus(T0 + 539, { fee: 231_000_000n }),
  executionFailed: () => focus(T0 + 539, {}, { treasuryHbar: 40_000_000n }),
  executedLocal: () => focus(T0 + 600, {}, { d: hederaGasDraft }),
  defeated: () =>
    focus(
      T0 + 420,
      {},
      {
        votes: [
          [BOB, VoteSupport.For],
          [VIEWER, VoteSupport.Against],
          [ALICE, VoteSupport.Against],
        ],
      },
    ),
  noQuorum: () => focus(T0 + 420, {}, { votes: [[DAVE, VoteSupport.For]] }),
  canceled: () => {
    const w = world(T0 - 7200);
    community(w);
    const pid = proposeAt(w, T0, BASE_DRAFT);
    w.advanceTo(T0 + 37);
    w.apply({ kind: "cancel", proposal: { id: pid } as never }, VIEWER);
    w.advanceTo(T0 + 60);
    w.connect(VIEWER);
    return w;
  },
};

export const DEFAULT_SCENARIO = "list";
export const SCENARIO_NAMES = Object.keys(SCENARIOS);
