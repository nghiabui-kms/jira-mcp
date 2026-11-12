import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JiraClient } from "../jira/client.js";
import type { RawIssue } from "../jira/format.js";
import { jqlString, searchAll, withoutOrderBy } from "../jira/paging.js";
import { aggregate, inWindow, nextDay, weekOf, zonedMidnight } from "../reports/time.js";
import { FAN_OUT, mapLimit } from "../util/pool.js";
import { defineTool, type ToolContext } from "./context.js";

const ISSUE_CAP = 300;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date as YYYY-MM-DD");

interface Worklog {
  author?: { displayName?: string };
  started: string;
  timeSpentSeconds: number;
}

/** Worklogs of one issue started in [from, to) (epoch ms). */
async function worklogsInWindow(jira: JiraClient, key: string, from: number, to: number): Promise<Worklog[]> {
  const out: Worklog[] = [];
  for (let startAt = 0; ; ) {
    const res = await jira.get<{ worklogs: Worklog[]; total: number }>(`/rest/api/3/issue/${key}/worklog`, {
      startedAfter: from - 1,
      startedBefore: to,
      startAt,
      maxResults: 5000,
    });
    out.push(...res.worklogs);
    startAt += res.worklogs.length;
    if (!res.worklogs.length || startAt >= res.total) break;
  }
  return out.filter((w) => inWindow(w.started, from, to));
}

const hours = (seconds: unknown) => (typeof seconds === "number" ? Math.round((seconds / 3600) * 100) / 100 : undefined);

export function registerTimeTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;

  defineTool(server, ctx, {
    name: "get_time_report",
    title: "Time report",
    description:
      "Hours logged between two dates (inclusive, in the Jira account's time zone), grouped by author, issue, " +
      "component, week or epic. Scope: jql, else the default project. Max 300 issues (truncated is reported). " +
      "groupBy=issue adds original estimate and total time spent.",
    input: {
      from: date,
      to: date,
      jql: z.string().optional().describe("Extra scope, e.g. project = AUTOKAT AND component = API"),
      groupBy: z.enum(["author", "issue", "component", "week", "epic"]).default("author"),
    },
    write: false,
    run: async ({ from, to, jql, groupBy }) => {
      if (to < from) throw new Error("to must be on or after from.");
      const timeZone = (await jira.get<{ timeZone?: string }>("/rest/api/3/myself")).timeZone ?? "UTC";
      const start = zonedMidnight(from, timeZone);
      const end = zonedMidnight(nextDay(to), timeZone);

      const project = ctx.settings().defaultProjectKey;
      const scope = jql ? `(${withoutOrderBy(jql)})` : project ? `project = ${jqlString(project)}` : "";
      const fullJql = `worklogDate >= "${from}" AND worklogDate <= "${to}"${scope ? ` AND ${scope}` : ""}`;
      const fields = ["summary", "issuetype", "parent", "components", "timeoriginalestimate", "timespent"];
      const { issues, truncated } = await searchAll(jira, fullJql, fields, ISSUE_CAP);
      const logs = await mapLimit(issues, FAN_OUT, (i) => worklogsInWindow(jira, i.key, start, end));

      const epicOf = groupBy === "epic" ? await epicResolver(jira, issues) : undefined;
      const keysFor = (issue: RawIssue, w: Worklog): string[] => {
        switch (groupBy) {
          case "author":
            return [w.author?.displayName ?? "(unknown)"];
          case "issue":
            return [issue.key];
          case "component": {
            const names: string[] = (issue.fields?.components ?? []).map((c: { name: string }) => c.name);
            return names.length ? names : ["(no component)"];
          }
          case "week":
            return [weekOf(w.started)];
          case "epic":
            return [epicOf?.(issue) ?? "(no epic)"];
        }
      };
      const groups = aggregate(issues.flatMap((issue, idx) => logs[idx].map((w) => ({ keys: keysFor(issue, w), seconds: w.timeSpentSeconds }))));
      const byKey = new Map(issues.map((i) => [i.key, i]));
      const totalSeconds = logs.flat().reduce((s, w) => s + w.timeSpentSeconds, 0);

      return {
        from,
        to,
        timeZone,
        groupBy,
        totalHours: hours(totalSeconds),
        groups:
          groupBy === "issue"
            ? groups.map((g) => {
                const f = byKey.get(g.key)?.fields ?? {};
                return {
                  ...g,
                  summary: f.summary,
                  originalEstimateHours: hours(f.timeoriginalestimate),
                  timeSpentHours: hours(f.timespent),
                };
              })
            : groups,
        issuesScanned: issues.length,
        truncated: truncated || undefined,
        note: groupBy === "component" ? "Issues with several components count in each." : undefined,
      };
    },
  });
}

/** Maps an issue to "EPIC-1 Epic summary": its parent, or for sub-tasks the parent's parent. */
async function epicResolver(jira: JiraClient, issues: RawIssue[]): Promise<(issue: RawIssue) => string | undefined> {
  const label = (p: { key?: string; fields?: { summary?: string } } | undefined) =>
    p?.key ? `${p.key} ${p.fields?.summary ?? ""}`.trim() : undefined;
  const subtaskParents = [
    ...new Set(issues.filter((i) => i.fields?.issuetype?.subtask && i.fields?.parent?.key).map((i) => String(i.fields.parent.key))),
  ];
  const grandParent = new Map<string, string | undefined>();
  if (subtaskParents.length) {
    const { issues: parents } = await searchAll(jira, `key in (${subtaskParents.join(",")})`, ["parent"], ISSUE_CAP);
    for (const p of parents) grandParent.set(p.key, label(p.fields?.parent));
  }
  return (issue) =>
    issue.fields?.issuetype?.subtask ? grandParent.get(String(issue.fields?.parent?.key)) : label(issue.fields?.parent);
}
