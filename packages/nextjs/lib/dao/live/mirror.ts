import { MIRROR_URL } from "../config";
import type { Address, Hex } from "viem";

export type MirrorLog = {
  address: Address;
  data: Hex;
  topics: Hex[];
  timestamp: string;
  transaction_hash: Hex;
  index: number;
};

type Page<K extends string, T> = { [key in K]: T[] } & { links?: { next: string | null } };

async function get<T>(path: string): Promise<T | null> {
  const url = path.startsWith("http") ? path : `${MIRROR_URL}${path}`;
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mirror node ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** Every log a contract emitted since `fromSeconds`, oldest first (follows the mirror node's paging). */
export async function contractLogs(address: Address, fromSeconds: number): Promise<MirrorLog[]> {
  const logs: MirrorLog[] = [];
  let path: string | null =
    `/api/v1/contracts/${address}/results/logs?order=asc&limit=100&timestamp=gte:${Math.max(0, fromSeconds - 60)}`;
  for (let page = 0; path && page < 50; page++) {
    const body: Page<"logs", MirrorLog> | null = await get<Page<"logs", MirrorLog>>(path);
    if (!body) break;
    logs.push(...body.logs);
    path = body.links?.next ?? null;
  }
  return logs;
}

export type MirrorSchedule = {
  schedule_id: string;
  executed_timestamp: string | null;
  deleted: boolean;
  expiration_time: string | null;
};

export const schedule = (id: string) => get<MirrorSchedule>(`/api/v1/schedules/${id}`);

/** Result of the transaction at a consensus timestamp, e.g. "SUCCESS" or "INSUFFICIENT_PAYER_BALANCE". */
export async function transactionResultAt(timestamp: string): Promise<string | undefined> {
  const body = await get<{ transactions: { result: string; scheduled: boolean }[] }>(
    `/api/v1/transactions?timestamp=${timestamp}`,
  );
  return body?.transactions.find(t => t.scheduled)?.result ?? body?.transactions[0]?.result;
}

export type MirrorAccount = {
  account: string;
  balance: { balance: number };
  max_automatic_token_associations: number;
};

export const account = (address: Address) => get<MirrorAccount>(`/api/v1/accounts/${address}`);

export type MirrorTokenRelationship = { token_id: string; automatic_association: boolean; balance: number };

/** The account's token relationships (first page of 100 is plenty for a demo account). */
export async function tokenRelationships(accountId: string): Promise<MirrorTokenRelationship[]> {
  const body = await get<Page<"tokens", MirrorTokenRelationship>>(`/api/v1/accounts/${accountId}/tokens?limit=100`);
  return body?.tokens ?? [];
}

/** Resolves once the mirror node has indexed a transaction (or after `timeoutMs`, so a slow mirror never blocks). */
export async function waitForResult(hash: Hex, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await get(`/api/v1/contracts/results/${hash}`).catch(() => null)) return;
    await new Promise(resolve => setTimeout(resolve, 1_500));
  }
}
