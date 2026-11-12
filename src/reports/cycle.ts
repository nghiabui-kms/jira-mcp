import { itemText, type History } from "../jira/changelog.js";

export const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Cycle time window from status history (oldest first): first entry into a start status ->
 * last entry into an end status. undefined when either is missing or the order is wrong.
 */
export function cycleWindow(histories: History[], start: string[], end: string[]): { start: number; end: number } | undefined {
  const starts = new Set(start.map((s) => s.toLowerCase()));
  const ends = new Set(end.map((s) => s.toLowerCase()));
  let first: number | undefined;
  let last: number | undefined;
  for (const h of histories) {
    for (const it of h.items) {
      if (it.fieldId !== "status" && it.field !== "status") continue;
      const to = itemText(it, "to")?.toLowerCase();
      if (!to) continue;
      const at = Date.parse(h.created);
      if (first === undefined && starts.has(to)) first = at;
      if (ends.has(to)) last = at;
    }
  }
  return first !== undefined && last !== undefined && last > first ? { start: first, end: last } : undefined;
}

/** Median, 85th percentile (nearest rank) and average, rounded to 0.1. */
export function stats(values: number[]) {
  if (!values.length) return { median: 0, p85: 0, average: 0 };
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return {
    median: round1(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2),
    p85: round1(v[Math.ceil(0.85 * v.length) - 1]),
    average: round1(v.reduce((s, x) => s + x, 0) / v.length),
  };
}
