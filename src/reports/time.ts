import { DAY_MS } from "./cycle.js";

/** Offset (ms) of a time zone from UTC at instant t. */
function tzOffset(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** Midnight of a YYYY-MM-DD date in a time zone, as epoch ms. */
export function zonedMidnight(date: string, timeZone: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  return utc - tzOffset(utc - tzOffset(utc, timeZone), timeZone);
}

export const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** Parses Jira timestamps such as 2026-11-10T09:00:00.000+0700. */
export const parseJiraDate = (s: string) => Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));

/** Window is [from, to): start inclusive, end exclusive. */
export const inWindow = (started: string, from: number, to: number) => {
  const t = parseJiraDate(started);
  return t >= from && t < to;
};

/** Monday (YYYY-MM-DD) of the week of a Jira timestamp, using the timestamp's own local date. */
export function weekOf(started: string): string {
  const day = Date.parse(`${started.slice(0, 10)}T00:00:00Z`);
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(monday).toISOString().slice(0, 10);
}

/** Sums seconds per group key (an entry may count in several groups) and returns hours, largest first. */
export function aggregate(entries: Array<{ keys: string[]; seconds: number }>): Array<{ key: string; hours: number }> {
  const sums = new Map<string, number>();
  for (const e of entries) for (const k of e.keys) sums.set(k, (sums.get(k) ?? 0) + e.seconds);
  return [...sums]
    .map(([key, s]) => ({ key, hours: Math.round((s / 3600) * 100) / 100 }))
    .sort((a, b) => b.hours - a.hours || a.key.localeCompare(b.key));
}
