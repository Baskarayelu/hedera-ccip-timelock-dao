/** All times are unix seconds. Display uses the viewer's local time zone. */

export function formatClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "14:20:01" for today, "1 Oct 14:20" for other days. */
export function formatWhen(ts: number, now: number): string {
  const day = (t: number) => new Date(t * 1000).toDateString();
  if (day(ts) === day(now)) return formatClock(ts);
  const date = new Date(ts * 1000);
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/** "35 s", "1 min 12 s", "22 min", "2 h 5 min", "24 h", "3 d 4 h". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest && m < 10 ? `${m} min ${rest} s` : `${m} min`;
  }
  if (s < 2 * 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "+6 min" style offsets for plans. */
export const formatOffset = (seconds: number) => (seconds <= 0 ? "now" : `+${formatDuration(seconds)}`);

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Mirror-node consensus timestamps look like "1790882223.039561113". */
export const parseConsensus = (ts: string) => Number(ts);

/** The CCIP explorer returns UTC times without a zone suffix ("2026-10-01T19:17:36"). */
export const parseCcipTime = (text: string | null | undefined) =>
  text ? Date.parse(text.endsWith("Z") ? text : `${text}Z`) / 1000 : undefined;
