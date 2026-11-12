import { adfToShortText } from "./adf.js";
import { readValue, type OutputField } from "./fields.js";

/** Fields requested for issue lists; keeps responses small. */
export const LIST_FIELDS: string[] = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "parent",
  "created",
  "updated",
];

/* eslint-disable @typescript-eslint/no-explicit-any -- Jira issue JSON is loosely typed */
export type RawIssue = { id: string; key: string; fields: Record<string, any> };

export function simplifyIssue(issue: RawIssue, siteUrl: string, extra: OutputField[] = []) {
  const f = issue.fields ?? {};
  const out: Record<string, unknown> = {
    key: issue.key,
    summary: f.summary,
    type: f.issuetype?.name,
    status: f.status?.name,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName,
    labels: f.labels?.length ? f.labels : undefined,
    parent: f.parent?.key,
    created: f.created,
    updated: f.updated,
    url: `${siteUrl}/browse/${issue.key}`,
  };
  for (const { key, field } of extra) {
    const raw: unknown = f[field.id];
    const value = key === "flagged" ? (Array.isArray(raw) && raw.length > 0) || undefined : readValue(field, raw);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function simplifyIssueDetail(issue: RawIssue, siteUrl: string, commentLimit: number, extra: OutputField[] = []) {
  const f = issue.fields ?? {};
  const comments: Array<Record<string, any>> = f.comment?.comments ?? [];
  const tt = f.timetracking ?? {};
  return {
    ...simplifyIssue(issue, siteUrl, extra),
    description: adfToShortText(f.description),
    originalEstimate: tt.originalEstimate,
    timeSpent: tt.timeSpent,
    remainingEstimate: tt.remainingEstimate,
    fixVersions: f.fixVersions?.length ? f.fixVersions.map((v: { name: string }) => v.name) : undefined,
    subtasks: f.subtasks?.map((s: RawIssue) => ({
      key: s.key,
      summary: s.fields?.summary,
      status: s.fields?.status?.name,
    })),
    links: f.issuelinks?.map((l: Record<string, any>) =>
      l.outwardIssue
        ? { id: l.id, type: l.type?.outward, key: l.outwardIssue.key, summary: l.outwardIssue.fields?.summary }
        : { id: l.id, type: l.type?.inward, key: l.inwardIssue?.key, summary: l.inwardIssue?.fields?.summary },
    ),
    comments: {
      total: f.comment?.total ?? comments.length,
      latest: comments.slice(-commentLimit).map((c) => ({
        id: c.id,
        author: c.author?.displayName,
        created: c.created,
        body: adfToShortText(c.body, 1500),
      })),
    },
  };
}

/** Jira worklog "started" format: yyyy-MM-dd'T'HH:mm:ss.SSSZ, e.g. 2026-11-10T02:00:00.000+0000 */
export function toJiraDateTime(d: Date): string {
  return d.toISOString().replace("Z", "+0000");
}
