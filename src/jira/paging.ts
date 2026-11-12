import type { JiraClient } from "./client.js";
import type { RawIssue } from "./format.js";

type Query = Record<string, string | number | boolean | undefined>;

/** Reads every page of an Agile/startAt-style list, up to `cap` items. */
export async function agileAll<T>(
  jira: JiraClient,
  path: string,
  query: Query,
  itemsKey: "issues" | "values",
  cap: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for (let startAt = 0; ; ) {
    const res = await jira.get<{ issues?: T[]; values?: T[]; total?: number; isLast?: boolean }>(path, {
      ...query,
      startAt,
      maxResults: 100,
    });
    const page = res[itemsKey] ?? [];
    items.push(...page);
    startAt += page.length;
    if (!page.length || res.isLast === true || (typeof res.total === "number" && startAt >= res.total)) {
      return { items, truncated: false };
    }
    if (items.length >= cap) return { items: items.slice(0, cap), truncated: true };
  }
}

/** Runs a JQL search through every nextPageToken page, up to `cap` issues. */
export async function searchAll(
  jira: JiraClient,
  jql: string,
  fields: string[],
  cap: number,
): Promise<{ issues: RawIssue[]; truncated: boolean }> {
  const issues: RawIssue[] = [];
  let token: string | undefined;
  do {
    const res = await jira.post<{ issues: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
      "/rest/api/3/search/jql",
      { jql, fields, maxResults: Math.min(100, cap - issues.length), nextPageToken: token },
    );
    issues.push(...res.issues);
    token = res.isLast ? undefined : res.nextPageToken;
  } while (token && issues.length < cap);
  return { issues, truncated: !!token };
}

/** JQL string literal. */
export const jqlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Drops a trailing ORDER BY so the JQL can be combined with other clauses. */
export const withoutOrderBy = (jql: string) => jql.replace(/\border\s+by\b[\s\S]*$/i, "").trim();
