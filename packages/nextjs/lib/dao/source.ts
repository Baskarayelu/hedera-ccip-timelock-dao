import { daoGovernorAbi, govTokenFaucetAbi, htsTokenAbi, voteTokenAbi } from "./abis";
import type { DaoAddresses } from "./proposal";
import type { DaoOverview, DaoTx, NetworkStats, ProposalRecord, RemoteCall, TxResult, VoterStatus } from "./types";
import { type Abi, type Address, type Hex, encodeAbiParameters, keccak256, pad, toHex } from "viem";

/**
 * Where the pages get their data. Two implementations share this contract:
 * - live: mirror-node logs and contract reads on Hedera, the CCIP explorer, and Base Sepolia reads;
 * - fixtures: scripted scenarios for the e2e tests, with a small simulator of the network callbacks.
 * Both return raw records; `derive.ts` turns them into what the pages show, so the tests exercise the same
 * logic the live app runs.
 */
export interface DaoSource {
  readonly kind: "live" | "fixture";
  /** Null when no DAO is deployed (daoDeployment.hedera is null). */
  readonly addresses: DaoAddresses | null;
  now(): number;
  overview(): Promise<DaoOverview>;
  proposals(viewer?: Address): Promise<ProposalRecord[]>;
  voter(address: Address): Promise<VoterStatus>;
  network(): Promise<NetworkStats>;
  /** Live CCIP fee (tinybar) for sending `calls` to Base with `destGasLimit`. */
  quoteFee(calls: readonly RemoteCall[], destGasLimit: bigint): Promise<bigint>;
  /**
   * Gas limit to send and the HBAR it will cost at today's gas price (tinybar). `estimated` is false when the
   * relay could not estimate it and `cost` is the gas floor's, an upper bound.
   */
  estimate(tx: DaoTx, from: Address): Promise<{ gas: bigint; cost: bigint; estimated: boolean }>;
  send(tx: DaoTx, from: Address): Promise<TxResult>;
  /** Fixtures change without a chain; the provider refetches when they do. */
  subscribe?(listener: () => void): () => void;
}

export type TxPlan = { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; floor: bigint };

/**
 * Gas floors per write: the limit is the relay's estimate plus 25%, or this floor when that is lower or the
 * estimate fails. Hedera bills the gas a transaction used, not its limit, so a floor above the need costs
 * nothing; the relay only requires the sender to hold `limit x gas price` when it submits. Each floor is
 * about 1.25x the gas measured on testnet (docs/costs.md), so the calls into system contracts (HTS, the
 * schedule service) still go through if the relay's estimate comes out low.
 */
export const GAS_FLOOR: Record<DaoTx["kind"], bigint> = {
  associate: 950_000n,
  claim: 1_000_000n,
  approve: 950_000n,
  wrap: 200_000n,
  unwrap: 200_000n,
  delegate: 150_000n,
  propose: 2_400_000n,
  vote: 150_000n,
  queue: 2_200_000n,
  execute: 1_200_000n,
  rearm: 1_900_000n,
  cancel: 400_000n,
};

/** The contract call behind each user action. */
export function planTx(tx: DaoTx, from: Address, addresses: DaoAddresses): TxPlan {
  const governor = { address: addresses.governor, abi: daoGovernorAbi as Abi };
  const proposalArgs = (p: { targets: Address[]; values: bigint[]; calldatas: Hex[]; descriptionHash: Hex }) =>
    [p.targets, p.values, p.calldatas, p.descriptionHash] as const;
  const floor = GAS_FLOOR[tx.kind];
  switch (tx.kind) {
    case "associate":
      return { address: addresses.governanceToken, abi: htsTokenAbi, functionName: "associate", args: [], floor };
    case "claim":
      return { address: addresses.faucet, abi: govTokenFaucetAbi as Abi, functionName: "claim", args: [], floor };
    case "approve":
      return {
        address: addresses.governanceToken,
        abi: htsTokenAbi,
        functionName: "approve",
        args: [addresses.voteToken, tx.amount],
        floor,
      };
    case "wrap":
      return {
        address: addresses.voteToken,
        abi: voteTokenAbi as Abi,
        functionName: "depositFor",
        args: [from, tx.amount],
        floor,
      };
    case "unwrap":
      return {
        address: addresses.voteToken,
        abi: voteTokenAbi as Abi,
        functionName: "withdrawTo",
        args: [from, tx.amount],
        floor,
      };
    case "delegate":
      return { address: addresses.voteToken, abi: voteTokenAbi as Abi, functionName: "delegate", args: [tx.to], floor };
    case "propose": {
      const p = tx.proposal;
      return { ...governor, functionName: "propose", args: [p.targets, p.values, p.calldatas, p.description], floor };
    }
    case "vote":
      return { ...governor, functionName: "castVote", args: [tx.proposalId, tx.support], floor };
    case "queue":
      return { ...governor, functionName: "queue", args: proposalArgs(tx.proposal), floor };
    case "execute":
      return { ...governor, functionName: "execute", args: proposalArgs(tx.proposal), floor };
    case "rearm":
      return { ...governor, functionName: "rearm", args: [...proposalArgs(tx.proposal), tx.action], floor };
    case "cancel":
      return { ...governor, functionName: "cancel", args: proposalArgs(tx.proposal), floor };
  }
}

/** `GovernorTimelockControl` salts each operation with the governor's address XOR the description hash. */
export function timelockSalt(governor: Address, descriptionHash: Hex): Hex {
  return toHex((BigInt(governor) << 96n) ^ BigInt(descriptionHash), { size: 32 });
}

/** `TimelockController.hashOperationBatch` with no predecessor: the operation id a proposal runs under. */
export function timelockOperationId(
  governor: Address,
  p: { targets: Address[]; values: bigint[]; calldatas: Hex[]; descriptionHash: Hex },
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }, { type: "bytes32" }],
      [p.targets, p.values, p.calldatas, pad("0x", { size: 32 }), timelockSalt(governor, p.descriptionHash)],
    ),
  );
}
