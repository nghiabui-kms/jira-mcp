import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FieldInfo } from "../jira/fields.js";
import type { RawIssue } from "../jira/format.js";
import { jqlString, searchAll, withoutOrderBy } from "../jira/paging.js";
import { defineTool, issueKeySchema as issueKey, outputFieldsSchema, type ToolContext } from "./context.js";
import { searchIssues } from "./issues.js";

const CHILD_CAP = 5000;

/** JQL reference to a field: cf[10100] for custom fields, the ID otherwise. */
const jqlField = (f: FieldInfo) => (f.id.startsWith("customfield_") ? `cf[${f.id.slice("customfield_".length)}]` : f.id);

/** Progress of one epic from its children (status category key + story points). */
export function epicProgress(children: Array<{ category?: string; points?: number }>) {
  const byStatusCategory = { toDo: 0, inProgress: 0, done: 0 };
  let total = 0;
  let done = 0;
  let unestimated = 0;
  for (const c of children) {
    const isDone = c.category === "done";
    if (isDone) byStatusCategory.done++;
    else if (c.category === "indeterminate") byStatusCategory.inProgress++;
    else byStatusCategory.toDo++;
    if (c.points === undefined) unestimated++;
    total += c.points ?? 0;
    if (isDone) done += c.points ?? 0;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const byPoints = total > 0;
  return {
    children: children.length,
    byStatusCategory,
    points: { total: r2(total), done: r2(done) },
    percentDone: byPoints
      ? Math.round((done / total) * 100)
      : children.length
        ? Math.round((byStatusCategory.done / children.length) * 100)
        : 0,
    percentBasis: byPoints ? "points" : "items",
    unestimated,
  };
}

export function registerEpicTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;

  defineTool(server, ctx, {
    name: "list_epics",
    title: "List epics",
    description:
      "List epics (in rank order), scoped by jql or else the default project, optionally filtered by component, " +
      "automation status or team (team id). Paginate with nextPageToken.",
    input: {
      jql: z.string().optional(),
      component: z.string().optional(),
      automationStatus: z.string().optional(),
      team: z.string().optional().describe("Team id as used in JQL"),
      maxResults: z.number().int().min(1).max(100).default(50),
      nextPageToken: z.string().optional(),
      fields: outputFieldsSchema,
    },
    write: false,
    run: async ({ jql, component, automationStatus, team, maxResults, nextPageToken, fields }) => {
      const clauses = ["issuetype = Epic"];
      const project = ctx.settings().defaultProjectKey;
      if (jql) clauses.push(`(${withoutOrderBy(jql)})`);
      else if (project) clauses.push(`project = ${jqlString(project)}`);
      if (component) clauses.push(`component = ${jqlString(component)}`);
      for (const [key, value] of [["automationStatus", automationStatus], ["team", team]] as const) {
        if (value) clauses.push(`${jqlField(await ctx.fields.resolve(key))} = ${jqlString(value)}`);
      }
      return searchIssues(ctx, `${clauses.join(" AND ")} ORDER BY Rank ASC`, maxResults, nextPageToken, fields);
    },
  });

  defineTool(server, ctx, {
    name: "get_epic_progress",
    title: "Epic progress",
    description:
      "Progress of up to 50 epics: children by status category, total/done story points, % done (by points, or " +
      "by items when nothing is estimated) and unestimated children.",
    input: { epicKeys: z.array(issueKey).min(1).max(50) },
    write: false,
    run: async ({ epicKeys }) => {
      const keys = [...new Set(epicKeys.map((k) => k.toUpperCase()))];
      const sp = await ctx.fields.tryResolve("storyPoints");
      const [epics, children] = await Promise.all([
        searchAll(jira, `key in (${keys.join(",")})`, ["summary", "status"], keys.length),
        searchAll(jira, `parent in (${keys.join(",")})`, ["status", "parent", ...(sp ? [sp.id] : [])], CHILD_CAP),
      ]);
      const byParent = new Map<string, RawIssue[]>();
      for (const c of children.issues) {
        const parent = String(c.fields?.parent?.key ?? "");
        byParent.set(parent, [...(byParent.get(parent) ?? []), c]);
      }
      const found = new Map(epics.issues.map((e) => [e.key, e]));
      return {
        epics: keys.map((key) => {
          const epic = found.get(key);
          if (!epic) return { key, error: "not found" };
          const kids = (byParent.get(key) ?? []).map((c) => {
            const points: unknown = sp ? c.fields?.[sp.id] : undefined;
            return {
              category: c.fields?.status?.statusCategory?.key,
              points: typeof points === "number" ? points : undefined,
            };
          });
          return { key, summary: epic.fields?.summary, status: epic.fields?.status?.name, ...epicProgress(kids) };
        }),
        truncated: children.truncated || undefined,
      };
    },
  });
}
