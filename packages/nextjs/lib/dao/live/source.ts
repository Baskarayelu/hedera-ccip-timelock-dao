import {
  ccipRouterAbi,
  crossChainExecutorAbi,
  daoGovernorAbi,
  daoTimelockAbi,
  govTokenFaucetAbi,
  htsTokenAbi,
  voteTokenAbi,
} from "../abis";
import { BASE_RPC_URL, BASE_SELECTOR, HEDERA_RPC_URL, type HederaDeployment, deployment } from "../config";
import { decodeRevert } from "../errors";
import { type DaoAddresses, ccipMessage } from "../proposal";
import { type DaoSource, planTx, timelockOperationId } from "../source";
import { parseCcipTime, parseConsensus } from "../time";
import {
  AutoAction,
  type CrossChainRecord,
  type DaoOverview,
  type DaoTx,
  type GovernorEvent,
  type NetworkStats,
  type ProposalRecord,
  ProposalState,
  type RemoteCall,
  RemoteStatus,
  type TxRef,
  type TxResult,
  type VoteRecord,
  type VoterStatus,
} from "../types";
import { entityIdOf, weibarToTinybar } from "../units";
import * as mirror from "./mirror";
import {
  type Address,
  type Hex,
  type WalletClient,
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  http,
  keccak256,
  parseEventLogs,
  toBytes,
  zeroAddress,
} from "viem";
import { baseSepolia } from "viem/chains";
import type { CcipMessageStatus } from "~~/app/api/ccip/[messageId]/route";
import { hederaTestnet } from "~~/scaffold.config";

const hedera = createPublicClient({
  chain: hederaTestnet,
  transport: http(HEDERA_RPC_URL, { timeout: 30_000 }),
  batch: { multicall: true },
});
const base = createPublicClient({
  chain: baseSepolia,
  transport: http(BASE_RPC_URL, { timeout: 30_000 }),
  batch: { multicall: true },
});

/** Short-lived memo so the list, the detail page and the stats share one log scan. `reset` drops it. */
function memo<T>(ttlMs: number, load: () => Promise<T>) {
  let at = 0;
  let value: Promise<T> | null = null;
  const get = () => {
    if (!value || Date.now() - at > ttlMs) {
      at = Date.now();
      value = load().catch(error => {
        value = null;
        throw error;
      });
    }
    return value;
  };
  return Object.assign(get, { reset: () => (value = null) });
}

type Decoded = { name: string; args: Record<string, unknown>; tx: TxRef };

function decodeLogs(logs: mirror.MirrorLog[], abi: typeof daoGovernorAbi | typeof daoTimelockAbi): Decoded[] {
  const out: Decoded[] = [];
  for (const log of logs) {
    try {
      const { eventName, args } = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      out.push({
        name: eventName,
        args: args as unknown as Record<string, unknown>,
        tx: { hash: log.transaction_hash, timestamp: parseConsensus(log.timestamp) },
      });
    } catch {
      // not one of ours (e.g. an OpenZeppelin event we do not display)
    }
  }
  return out;
}

async function ccipStatus(messageId: Hex): Promise<CcipMessageStatus | null> {
  try {
    const res = await fetch(`/api/ccip/${messageId}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    return res.ok ? ((await res.json()) as CcipMessageStatus) : null;
  } catch {
    return null;
  }
}

/** What the executor on Base did with a request, read from the delivery transaction CCIP reports. */
async function remoteOutcome(txHash: Hex, timestamp: number, executor: Address): Promise<CrossChainRecord["remote"]> {
  const receipt = await base.getTransactionReceipt({ hash: txHash });
  const [processed] = parseEventLogs({
    abi: crossChainExecutorAbi,
    eventName: "RequestProcessed",
    logs: receipt.logs.filter(l => l.address.toLowerCase() === executor.toLowerCase()),
  });
  if (!processed) return undefined;
  return {
    status: processed.args.status as RemoteStatus,
    revertData: processed.args.revertData,
    account: processed.args.account,
    tx: { hash: txHash, timestamp },
  };
}

/**
 * Revert data from a failed estimate, when the error carries any. viem puts it in `raw` on its
 * ContractFunctionRevertedError (also when the error is not in the ABI it was given, such as a timelock
 * error bubbling up through the governor), and in `data` on the RPC error underneath.
 */
export function revertDataOf(error: unknown): Hex | undefined {
  let e = error as { data?: unknown; raw?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 6; depth++) {
    if (typeof e.raw === "string" && e.raw.startsWith("0x")) return e.raw as Hex;
    if (typeof e.data === "string" && e.data.startsWith("0x")) return e.data as Hex;
    if (e.data && typeof (e.data as { data?: unknown }).data === "string") return (e.data as { data: Hex }).data;
    e = e.cause as typeof e;
  }
  return undefined;
}

export function createLiveSource(dep: HederaDeployment | null, getWallet: () => WalletClient | undefined): DaoSource {
  const remote = deployment.base;
  const addresses: DaoAddresses | null = dep && {
    governor: dep.governor,
    timelock: dep.timelock,
    voteToken: dep.voteToken,
    faucet: dep.faucet,
    governanceToken: dep.governanceToken,
    remoteParameters: remote.remoteParameters,
    usdc: remote.usdc,
    remoteAccount: dep.remoteAccount,
  };
  const need = () => {
    if (!dep || !addresses) throw new Error("No DAO is deployed yet: run `npm run foundry:deploy:hedera`.");
    return { dep, addresses };
  };
  const governor = () => ({ address: need().dep.governor, abi: daoGovernorAbi }) as const;
  const timelock = () => ({ address: need().dep.timelock, abi: daoTimelockAbi }) as const;
  const votes = () => ({ address: need().dep.voteToken, abi: voteTokenAbi }) as const;
  const token = () => ({ address: need().dep.governanceToken, abi: htsTokenAbi }) as const;

  const governorEvents = memo(8_000, async () =>
    decodeLogs(await mirror.contractLogs(need().dep.governor, need().dep.deployedAt), daoGovernorAbi),
  );
  const timelockEvents = memo(8_000, async () =>
    decodeLogs(await mirror.contractLogs(need().dep.timelock, need().dep.deployedAt), daoTimelockAbi),
  );
  const gasPrice = memo(60_000, async () => weibarToTinybar(await hedera.getGasPrice()));

  async function overview(): Promise<DaoOverview> {
    const { dep } = need();
    const [
      votingDelay,
      votingPeriod,
      quorumNumerator,
      quorumDenominator,
      proposalThreshold,
      margin,
      gasQueue,
      gasExecute,
      minDelay,
      requestTtl,
      treasuryGov,
      voteSupply,
    ] = await hedera.multicall({
      allowFailure: false,
      contracts: [
        { ...governor(), functionName: "votingDelay" },
        { ...governor(), functionName: "votingPeriod" },
        { ...governor(), functionName: "quorumNumerator", args: [] },
        { ...governor(), functionName: "quorumDenominator" },
        { ...governor(), functionName: "proposalThreshold" },
        { ...governor(), functionName: "BLOCK_CLOCK_MARGIN" },
        { ...governor(), functionName: "autoGasLimit", args: [AutoAction.Queue] },
        { ...governor(), functionName: "autoGasLimit", args: [AutoAction.Execute] },
        { ...timelock(), functionName: "getMinDelay" },
        { ...timelock(), functionName: "requestTtl" },
        { ...token(), functionName: "balanceOf", args: [dep.timelock] },
        { ...votes(), functionName: "totalSupply" },
      ],
    });
    const [treasury, float, price, eth, usdc, code] = await Promise.all([
      hedera.getBalance({ address: dep.timelock }),
      hedera.getBalance({ address: dep.governor }),
      gasPrice(),
      base.getBalance({ address: dep.remoteAccount }),
      base.readContract({ address: remote.usdc, abi: erc20Abi, functionName: "balanceOf", args: [dep.remoteAccount] }),
      base.getCode({ address: dep.remoteAccount }),
    ]);
    return {
      rules: {
        votingDelay: Number(votingDelay),
        votingPeriod: Number(votingPeriod),
        timelockDelay: Number(minDelay),
        quorumNumerator,
        quorumDenominator,
        proposalThreshold,
        blockClockMargin: Number(margin),
        autoGas: { [AutoAction.Queue]: gasQueue, [AutoAction.Execute]: gasExecute },
        requestTtl: Number(requestTtl),
      },
      treasuryHbar: weibarToTinybar(treasury),
      treasuryGov,
      floatHbar: weibarToTinybar(float),
      voteSupply,
      gasPrice: price,
      remoteAccount: { address: dep.remoteAccount, deployed: !!code && code !== "0x", eth, usdc },
    };
  }

  /** CCIP requests and receipts by timelock operation id. */
  async function crossChainByOperation(): Promise<Map<Hex, CrossChainRecord[]>> {
    const byOperation = new Map<Hex, CrossChainRecord[]>();
    const byMessage = new Map<Hex, CrossChainRecord>();
    for (const e of await timelockEvents()) {
      if (e.name === "CrossChainRequestSent") {
        const a = e.args as {
          messageId: Hex;
          operationId: Hex;
          destChain: bigint;
          executor: Address;
          fee: bigint;
          validUntil: bigint;
        };
        const record: CrossChainRecord = {
          messageId: a.messageId,
          destChain: a.destChain,
          executor: a.executor,
          fee: a.fee,
          validUntil: Number(a.validUntil),
          sent: e.tx,
        };
        byMessage.set(a.messageId, record);
        byOperation.set(a.operationId, [...(byOperation.get(a.operationId) ?? []), record]);
      } else if (e.name === "CrossChainReceipt") {
        const a = e.args as {
          requestId: Hex;
          receiptMessageId: Hex;
          status: number;
          executedAt: bigint;
          revertData: Hex;
        };
        const record = byMessage.get(a.requestId);
        if (record) {
          record.receipt = {
            status: a.status as RemoteStatus,
            executedAt: Number(a.executedAt),
            receiptMessageId: a.receiptMessageId,
            revertData: a.revertData,
            tx: e.tx,
          };
        }
      }
    }
    return byOperation;
  }

  async function enrichSchedule(record: ProposalRecord, action: AutoAction, now: number) {
    const info = record.schedules[action];
    if (!info || info.at > now) return;
    const s = await mirror.schedule(info.id);
    if (!s) return;
    info.deleted = s.deleted;
    if (s.executed_timestamp) {
      info.executedAt = parseConsensus(s.executed_timestamp);
      info.result = await mirror.transactionResultAt(s.executed_timestamp);
    }
  }

  /** Deliveries that finished: what CCIP and the executor reported never changes after that. */
  const settled = new Map<Hex, Pick<CrossChainRecord, "delivery" | "remote">>();

  async function enrichMessage(message: CrossChainRecord) {
    const known = settled.get(message.messageId);
    if (known) return Object.assign(message, known);
    const status = await ccipStatus(message.messageId);
    if (!status) return;
    const timestamp = parseCcipTime(status.receiptTimestamp);
    message.delivery = { state: status.state, tx: (status.receiptTransactionHash as Hex) ?? undefined, timestamp };
    if (status.state !== "pending" && status.receiptTransactionHash && timestamp) {
      message.remote = await remoteOutcome(status.receiptTransactionHash as Hex, timestamp, message.executor);
      settled.set(message.messageId, { delivery: message.delivery, remote: message.remote });
    }
  }

  async function proposals(viewer?: Address): Promise<ProposalRecord[]> {
    const { dep } = need();
    const [events, byOperation] = await Promise.all([governorEvents(), crossChainByOperation()]);
    const now = Math.floor(Date.now() / 1000);

    const records: ProposalRecord[] = [];
    const byId = new Map<bigint, ProposalRecord>();
    const votesBy = new Map<bigint, VoteRecord>();
    for (const e of events) {
      const a = e.args as Record<string, any>;
      if (e.name === "ProposalCreated") {
        const record: ProposalRecord = {
          id: a.proposalId,
          number: records.length + 1,
          proposer: a.proposer,
          description: a.description,
          descriptionHash: keccak256(toBytes(a.description)),
          targets: [...a.targets],
          values: [...a.values],
          calldatas: [...a.calldatas],
          created: e.tx,
          voteStart: Number(a.voteStart),
          voteEnd: Number(a.voteEnd),
          state: ProposalState.Pending,
          votes: { against: 0n, for: 0n, abstain: 0n },
          quorum: 0n,
          supplyAtSnapshot: null,
          eta: 0,
          events: [],
          schedules: {},
          crossChain: [],
        };
        records.push(record);
        byId.set(record.id, record);
        continue;
      }
      const record = a.proposalId !== undefined ? byId.get(a.proposalId) : undefined;
      if (!record) continue;
      const push = (event: GovernorEvent) => record.events.push(event);
      switch (e.name) {
        case "AutoActionArmed":
          push({ kind: "armed", action: a.action, schedule: a.schedule, at: Number(a.at), tx: e.tx });
          record.schedules[a.action as AutoAction] = {
            id: entityIdOf(a.schedule),
            address: a.schedule,
            at: Number(a.at),
            deleted: false,
          };
          break;
        case "AutoActionUnavailable":
          push({ kind: "unavailable", action: a.action, responseCode: Number(a.responseCode), tx: e.tx });
          break;
        case "AutoActionDone":
          push({ kind: "done", action: a.action, tx: e.tx });
          break;
        case "AutoActionSkipped":
          push({ kind: "skipped", action: a.action, state: a.state, tx: e.tx });
          break;
        case "AutoActionFailed":
          push({ kind: "failed", action: a.action, reason: a.reason, tx: e.tx });
          break;
        case "AutoActionCancelled":
          push({
            kind: "cancelled",
            action: a.action,
            schedule: a.schedule,
            responseCode: Number(a.responseCode),
            tx: e.tx,
          });
          break;
        case "ProposalQueued":
          push({ kind: "queued", eta: Number(a.etaSeconds), tx: e.tx });
          break;
        case "ProposalExecuted":
          push({ kind: "executed", tx: e.tx });
          break;
        case "ProposalCanceled":
          push({ kind: "canceled", tx: e.tx });
          break;
        case "VoteCast":
          if (viewer && (a.voter as string).toLowerCase() === viewer.toLowerCase()) {
            votesBy.set(record.id, { voter: a.voter, support: a.support, weight: a.weight, tx: e.tx });
          }
          break;
      }
    }
    if (records.length === 0) return [];

    // One multicall for every proposal's on-chain state.
    const perProposal = records.flatMap(r => [
      { ...governor(), functionName: "state", args: [r.id] },
      { ...governor(), functionName: "proposalVotes", args: [r.id] },
      { ...governor(), functionName: "proposalEta", args: [r.id] },
      { ...governor(), functionName: "quorum", args: [BigInt(r.voteStart)] },
      { ...votes(), functionName: "getPastTotalSupply", args: [BigInt(r.voteStart)] },
      viewer
        ? r.voteStart < now - 5
          ? { ...votes(), functionName: "getPastVotes", args: [viewer, BigInt(r.voteStart)] }
          : { ...votes(), functionName: "getVotes", args: [viewer] }
        : { ...governor(), functionName: "votingDelay" },
    ]);
    const [numerator, denominator, supplyNow, ...results] = await hedera.multicall({
      allowFailure: true,
      contracts: [
        { ...governor(), functionName: "quorumNumerator", args: [] },
        { ...governor(), functionName: "quorumDenominator" },
        { ...votes(), functionName: "totalSupply" },
        ...perProposal,
      ] as any[],
    });
    const ok = <T>(r: { status: string; result?: unknown }) => (r.status === "success" ? (r.result as T) : undefined);

    records.forEach((r, i) => {
      const [state, tally, eta, quorum, supply, power] = results.slice(i * 6, i * 6 + 6) as {
        status: string;
        result?: unknown;
      }[];
      r.state = (ok<number>(state) ?? ProposalState.Pending) as ProposalState;
      const t = ok<readonly [bigint, bigint, bigint]>(tally);
      if (t) r.votes = { against: t[0], for: t[1], abstain: t[2] };
      r.eta = Number(ok<bigint>(eta) ?? 0n);
      r.supplyAtSnapshot = ok<bigint>(supply) ?? null;
      // quorum(snapshot) reverts while the snapshot is in the future; show what it would be now.
      r.quorum =
        ok<bigint>(quorum) ??
        ((ok<bigint>(supplyNow) ?? 0n) * (ok<bigint>(numerator) ?? 0n)) / (ok<bigint>(denominator) ?? 100n);
      if (viewer) r.viewer = { address: viewer, votingPower: ok<bigint>(power) ?? 0n, vote: votesBy.get(r.id) };
      r.crossChain = byOperation.get(timelockOperationId(dep.governor, r)) ?? [];
    });

    // Only look further where the answer can change what the page says.
    await Promise.all(
      records.flatMap(r => {
        const work: Promise<unknown>[] = [];
        if (r.state === ProposalState.Succeeded) work.push(enrichSchedule(r, AutoAction.Queue, now));
        if (r.state === ProposalState.Queued) work.push(enrichSchedule(r, AutoAction.Execute, now));
        if (r.state === ProposalState.Executed) r.crossChain.forEach(m => work.push(enrichMessage(m)));
        return work.map(w => w.catch(() => undefined));
      }),
    );
    return records;
  }

  async function network(): Promise<NetworkStats> {
    const [latest, finalized] = await Promise.all([
      base.getBlock({ blockTag: "latest" }).catch(() => null),
      base.getBlock({ blockTag: "finalized" }).catch(() => null),
    ]);
    const baseFinalityLag = latest && finalized ? Number(latest.timestamp - finalized.timestamp) : null;
    if (!dep) return { baseFinalityLag, deliverySeconds: [], receiptOverheadSeconds: [] };

    const received = [...(await crossChainByOperation()).values()]
      .flat()
      .filter(m => m.receipt)
      .sort((a, b) => b.receipt!.tx.timestamp - a.receipt!.tx.timestamp)
      .slice(0, 5);
    const deliverySeconds = received.map(m => m.receipt!.executedAt - m.sent.timestamp).filter(s => s >= 0);
    const overheads = await Promise.all(
      received.slice(0, 3).map(async m => {
        const status = await ccipStatus(m.receipt!.receiptMessageId);
        const landed = parseCcipTime(status?.receiptTimestamp);
        const finalizedAt = parseCcipTime(status?.sendFinalized);
        return landed !== undefined && finalizedAt !== undefined ? landed - finalizedAt : null;
      }),
    );
    return {
      baseFinalityLag,
      deliverySeconds,
      receiptOverheadSeconds: overheads.filter((s): s is number => s !== null),
    };
  }

  async function voter(address: Address): Promise<VoterStatus> {
    const { dep } = need();
    const account = await mirror.account(address);
    const relationships = account ? await mirror.tokenRelationships(account.account) : [];
    const tokenId = entityIdOf(dep.governanceToken);
    const autoUsed = relationships.filter(t => t.automatic_association).length;
    const maxAuto = account?.max_automatic_token_associations ?? 0;
    const [voteBalance, currentVotes, delegate, lastClaimAt, cooldown, claimAmount] = await hedera.multicall({
      allowFailure: false,
      contracts: [
        { ...votes(), functionName: "balanceOf", args: [address] },
        { ...votes(), functionName: "getVotes", args: [address] },
        { ...votes(), functionName: "delegates", args: [address] },
        { address: dep.faucet, abi: govTokenFaucetAbi, functionName: "lastClaimAt", args: [address] },
        { address: dep.faucet, abi: govTokenFaucetAbi, functionName: "claimCooldown" },
        { address: dep.faucet, abi: govTokenFaucetAbi, functionName: "claimAmount" },
      ],
    });
    // HTS reads revert for an address Hedera has no account for (INVALID_ACCOUNT_ID); it holds nothing yet.
    const [gov, allowance] = account
      ? await hedera.multicall({
          allowFailure: false,
          contracts: [
            { ...token(), functionName: "balanceOf", args: [address] },
            { ...token(), functionName: "allowance", args: [address, dep.voteToken] },
          ],
        })
      : [0n, 0n];
    return {
      address,
      accountId: account?.account ?? null,
      hbar: BigInt(account?.balance.balance ?? 0),
      associated: relationships.some(t => t.token_id === tokenId),
      autoAssociationSlots: maxAuto === -1 ? -1 : Math.max(0, maxAuto - autoUsed),
      gov,
      voteBalance,
      votes: currentVotes,
      delegate: delegate === zeroAddress ? null : delegate,
      allowance,
      lastClaimAt: Number(lastClaimAt),
      claimCooldown: Number(cooldown),
      claimAmount: BigInt(claimAmount),
    };
  }

  async function quoteFee(calls: readonly RemoteCall[], destGasLimit: bigint): Promise<bigint> {
    const { dep } = need();
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86_400); // fixed-size field: any value quotes the same
    return hedera.readContract({
      address: dep.ccipRouter,
      abi: ccipRouterAbi,
      functionName: "getFee",
      args: [BASE_SELECTOR, ccipMessage(remote.executor, calls, destGasLimit, validUntil)],
    });
  }

  async function plannedGas(tx: DaoTx, from: Address) {
    const plan = planTx(tx, from, need().addresses);
    const price = await gasPrice();
    try {
      const estimated = await hedera.estimateContractGas({ ...plan, account: from } as any);
      const gas = (estimated * 125n) / 100n > plan.floor ? (estimated * 125n) / 100n : plan.floor;
      // Hedera bills the gas used, not the limit; the limit only has to be covered by the balance.
      return { gas, cost: estimated * price, revert: undefined, estimated: true };
    } catch (error) {
      // No estimate (for example, the sender has no account yet): the floor's cost is only an upper bound.
      return { gas: plan.floor, cost: plan.floor * price, revert: revertDataOf(error), estimated: false };
    }
  }

  async function estimate(tx: DaoTx, from: Address) {
    const { gas, cost, revert, estimated } = await plannedGas(tx, from);
    return { gas, cost, estimated: estimated && !revert };
  }

  async function send(tx: DaoTx, from: Address): Promise<TxResult> {
    const wallet = getWallet();
    if (!wallet) throw new Error("Connect a wallet first.");
    const plan = planTx(tx, from, need().addresses);
    // Without an account the relay cannot simulate anything, so the check below would see no reason to stop.
    if (!(await mirror.account(from))) {
      throw new Error("This wallet has no Hedera account yet. Send it testnet HBAR from the faucet first.");
    }
    const { gas, revert } = await plannedGas(tx, from);
    // A revert our contracts explain would happen on-chain too: say why instead of spending the gas.
    if (revert && decodeRevert(revert).name) {
      throw Object.assign(new Error("The transaction would revert"), { cause: { data: revert } });
    }
    const hash = await wallet.writeContract({
      address: plan.address,
      abi: plan.abi,
      functionName: plan.functionName,
      args: plan.args,
      account: from,
      chain: hederaTestnet,
      gas,
      // Legacy pricing: the relay reserves gas x price up front, and an EIP-1559 max fee doubles it.
      type: "legacy",
      gasPrice: await hedera.getGasPrice(),
    } as any);
    const receipt = await hedera.waitForTransactionReceipt({ hash, timeout: 120_000 });
    // The pages read events from the mirror node, which indexes a transaction a few seconds after consensus:
    // wait for it, then drop the cached scans so the refetch that follows shows the new state.
    await mirror.waitForResult(hash);
    governorEvents.reset();
    timelockEvents.reset();
    let proposalId: bigint | undefined;
    if (tx.kind === "propose") {
      const [created] = parseEventLogs({ abi: daoGovernorAbi, eventName: "ProposalCreated", logs: receipt.logs });
      proposalId = created?.args.proposalId;
    }
    return { hash, ok: receipt.status === "success", proposalId };
  }

  return {
    kind: "live",
    addresses,
    now: () => Math.floor(Date.now() / 1000),
    overview,
    proposals,
    voter,
    network,
    quoteFee,
    estimate,
    send,
  };
}
