import { FAN_OUT, mapLimit } from "../util/pool.js";
import { JiraError, type JiraClient } from "./client.js";

export interface ChangeItem {
  field?: string;
  fieldId?: string;
  from?: string | null;
  to?: string | null;
}

export interface History {
  created: string;
  author?: { displayName?: string };
  items: ChangeItem[];
}

const BULK_MAX_ISSUES = 1000;

/**
 * Changelogs for many issues, keyed by issue key, oldest first, optionally filtered to field IDs (max 10).
 * Uses POST /rest/api/3/changelog/bulkfetch; falls back to per-issue GET (5 in flight) if it is unavailable.
 */
export async function fetchChangelogs(
  jira: JiraClient,
  issues: Array<{ id: string; key: string }>,
  fieldIds?: string[],
): Promise<Map<string, History[]>> {
  const out = new Map<string, History[]>(issues.map((i) => [i.key, []]));
  if (!issues.length) return out;
  try {
    const keyById = new Map(issues.map((i) => [i.id, i.key]));
    for (let i = 0; i < issues.length; i += BULK_MAX_ISSUES) {
      const chunk = issues.slice(i, i + BULK_MAX_ISSUES).map((x) => x.id);
      let nextPageToken: string | undefined;
      do {
        const res = await jira.post<{
          issueChangeLogs?: Array<{ issueId: string; changeHistories?: History[] }>;
          nextPageToken?: string | null;
        }>("/rest/api/3/changelog/bulkfetch", { issueIdsOrKeys: chunk, fieldIds, maxResults: 1000, nextPageToken });
        for (const log of res.issueChangeLogs ?? []) {
          const key = keyById.get(String(log.issueId));
          if (key) out.get(key)?.push(...(log.changeHistories ?? []));
        }
        nextPageToken = res.nextPageToken ?? undefined;
      } while (nextPageToken);
    }
  } catch (err) {
    if (!(err instanceof JiraError) || ![404, 405, 501].includes(err.status)) throw err;
    await mapLimit(issues, FAN_OUT, async ({ key }) => out.set(key, await issueChangelog(jira, key)));
  }
  for (const [key, list] of out) {
    const filtered = fieldIds?.length
      ? list
          .map((h) => ({ ...h, items: h.items.filter((it) => fieldIds.includes(it.fieldId ?? "")) }))
          .filter((h) => h.items.length)
      : list;
    out.set(key, filtered.sort((a, b) => Date.parse(a.created) - Date.parse(b.created)));
  }
  return out;
}

/** Every changelog page of one issue (oldest first). */
export async function issueChangelog(jira: JiraClient, key: string, cap = 2000): Promise<History[]> {
  const all: History[] = [];
  for (let startAt = 0; all.length < cap; ) {
    const res = await jira.get<{ values: History[]; isLast?: boolean; total?: number }>(
      `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`,
      { startAt, maxResults: 100 },
    );
    all.push(...res.values);
    startAt += res.values.length;
    if (!res.values.length || res.isLast || (res.total !== undefined && startAt >= res.total)) break;
  }
  return all;
}

/**
 * fromString / toString of a change item. Read as own properties: a missing `toString`
 * would otherwise resolve to Object.prototype.toString.
 */
export function itemText(item: ChangeItem, side: "from" | "to"): string | null {
  const own: unknown = Object.getOwnPropertyDescriptor(item, `${side}String`)?.value;
  return typeof own === "string" ? own : (item[side] ?? null);
}
