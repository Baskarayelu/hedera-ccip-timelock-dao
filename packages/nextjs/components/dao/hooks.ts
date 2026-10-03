"use client";

import { useEffect, useMemo, useState } from "react";
import { useDao } from "./DaoProvider";
import { useQuery } from "@tanstack/react-query";
import { type DeriveContext, type ProposalView, deriveProposal } from "~~/lib/dao/derive";
import { crossChainBundle } from "~~/lib/dao/proposal";
import type { ProposalRecord, RemoteCall } from "~~/lib/dao/types";

/** The clock pages render against: wall time live (ticking), the scenario's clock with fixtures. */
export function useNow() {
  const { source, version } = useDao();
  const [now, setNow] = useState(() => source.now());
  useEffect(() => {
    setNow(source.now());
    if (source.kind !== "live") return;
    const timer = setInterval(() => setNow(source.now()), 1000);
    return () => clearInterval(timer);
  }, [source, version]);
  return now;
}

const key = (...parts: unknown[]) => {
  // Query keys go through JSON; bigints become strings.
  return parts.map(p => (typeof p === "bigint" ? p.toString() : p));
};

function useKey(...parts: unknown[]) {
  const { source, version, scenario } = useDao();
  return ["dao", source.kind, scenario, version, ...key(...parts)];
}

export function useOverview() {
  const { source } = useDao();
  return useQuery({
    queryKey: useKey("overview"),
    queryFn: () => source.overview(),
    enabled: !!source.addresses,
    refetchInterval: source.kind === "live" ? 30_000 : false,
  });
}

export function useNetworkStats() {
  const { source } = useDao();
  return useQuery({
    queryKey: useKey("network"),
    queryFn: () => source.network(),
    refetchInterval: source.kind === "live" ? 60_000 : false,
  });
}

export function useProposals() {
  const { source, wallet } = useDao();
  return useQuery({
    queryKey: useKey("proposals", wallet.address),
    queryFn: () => source.proposals(wallet.address),
    enabled: !!source.addresses,
    refetchInterval: source.kind === "live" ? 10_000 : false,
  });
}

export function useVoter() {
  const { source, wallet } = useDao();
  return useQuery({
    queryKey: useKey("voter", wallet.address),
    queryFn: () => source.voter(wallet.address!),
    enabled: !!source.addresses && !!wallet.address,
    refetchInterval: source.kind === "live" ? 10_000 : false,
  });
}

/** Live CCIP fee quote for a Base batch (tinybar); refreshed every 30 s. */
export function useFeeQuote(calls: readonly RemoteCall[] | null, destGasLimit: bigint) {
  const { source } = useDao();
  const callsKey = calls ? JSON.stringify(calls, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : null;
  return useQuery({
    queryKey: useKey("fee", callsKey, destGasLimit),
    queryFn: () => source.quoteFee(calls ?? [], destGasLimit),
    enabled: !!source.addresses && !!calls && calls.length > 0,
    refetchInterval: source.kind === "live" ? 30_000 : false,
  });
}

/** Derived views for every proposal, newest first, plus what deriving them needed. */
export function useProposalViews() {
  const { source } = useDao();
  const now = useNow();
  const proposals = useProposals();
  const overview = useOverview();
  const stats = useNetworkStats();
  const views = useMemo(() => {
    if (!proposals.data || !overview.data || !source.addresses) return null;
    const ctx: DeriveContext = { now, overview: overview.data, stats: stats.data ?? null, addresses: source.addresses };
    return [...proposals.data]
      .reverse()
      .map(record => ({ record, view: deriveProposal(record, ctx) }) as { record: ProposalRecord; view: ProposalView });
  }, [proposals.data, overview.data, stats.data, now, source.addresses]);
  return {
    views,
    isLoading: proposals.isLoading || overview.isLoading,
    error: proposals.error ?? overview.error,
  };
}

/** One proposal with the live fee quote for its Base batch, if it has one. */
export function useProposalView(id: bigint | null) {
  const { source } = useDao();
  const now = useNow();
  const proposals = useProposals();
  const overview = useOverview();
  const stats = useNetworkStats();
  // A proposal id is a 77-digit hash; a small number is the "#3" the pages show, so look it up by that too.
  const record = useMemo(
    () => proposals.data?.find(p => p.id === id || (id !== null && id < 1_000_000n && BigInt(p.number) === id)) ?? null,
    [proposals.data, id],
  );
  const bundle = record && source.addresses ? crossChainBundle(record, source.addresses.timelock) : null;
  const fee = useFeeQuote(bundle?.calls ?? null, bundle?.destGasLimit ?? 0n);
  const view = useMemo(() => {
    if (!record || !overview.data || !source.addresses) return null;
    return deriveProposal(record, {
      now,
      overview: overview.data,
      stats: stats.data ?? null,
      addresses: source.addresses,
      liveFee: fee.data ?? null,
    });
  }, [record, overview.data, stats.data, now, source.addresses, fee.data]);
  return {
    record,
    view,
    overview: overview.data,
    stats: stats.data,
    fee: fee.data,
    isLoading: proposals.isLoading || overview.isLoading,
    error: proposals.error ?? overview.error,
    notFound: !!proposals.data && !record,
  };
}
