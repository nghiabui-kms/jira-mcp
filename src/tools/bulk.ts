import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readValue } from "../jira/fields.js";
import { searchAll } from "../jira/paging.js";
import { FAN_OUT, mapLimit } from "../util/pool.js";
import {
  assertWritable,
  defineTool,
  issueKeySchema as issueKey,
  resolveAccountId,
  type ToolContext,
} from "./context.js";
import { labelAndEstimateOps, resolveTransition } from "./issues.js";

const MAX_ISSUES = 50;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function registerBulkTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;

  defineTool(server, ctx, {
    name: "bulk_update_issues",
    title: "Bulk update issues",
    description:
      "Apply the same changes to up to 50 issues (issueKeys, or a jql matching at most 50). changes: fields (by " +
      'name), addLabels, removeLabels, assignee (accountId, "me" or null), transition. dryRun=true (default) only ' +
      "shows current vs new values; dryRun=false applies, 5 issues at a time, and reports each result.",
    input: {
      issueKeys: z.array(issueKey).min(1).max(MAX_ISSUES).optional(),
      jql: z.string().min(1).optional(),
      changes: z
        .object({
          fields: z.record(z.unknown()).optional(),
          addLabels: z.array(z.string().min(1)).optional(),
          removeLabels: z.array(z.string().min(1)).optional(),
          assignee: z.string().nullable().optional(),
          transition: z.string().min(1).optional().describe("Transition name, id or target status"),
        })
        .strict(),
      dryRun: z.boolean().default(true),
    },
    write: true,
    idempotent: false,
    run: async ({ issueKeys, jql, changes, dryRun }) => {
      if (!issueKeys === !jql) throw new Error("Pass exactly one of issueKeys / jql.");
      if (!Object.values(changes).some((v) => v !== undefined)) throw new Error("changes is empty.");

      const named = await Promise.all(
        Object.entries(changes.fields ?? {}).map(async ([name, value]) => ({ name, value, field: await ctx.fields.resolve(name) })),
      );
      const fields = changes.fields ? await ctx.fields.toJiraFields(changes.fields) : {};
      const update = labelAndEstimateOps(changes);

      const query = jql ?? `key in (${(issueKeys ?? []).join(",")})`;
      const read = ["summary", "status", "labels", "assignee", ...named.map((n) => n.field.id)];
      const { issues, truncated } = await searchAll(jira, query, read, MAX_ISSUES + 1);
      if (truncated || issues.length > MAX_ISSUES) throw new Error(`The JQL matches more than ${MAX_ISSUES} issues; narrow it down.`);
      if (!issues.length) throw new Error("No issues matched.");
      assertWritable(ctx, issues.map((i) => i.key)); // all issues are checked before any write

      const assignee =
        changes.assignee === undefined ? undefined : changes.assignee === null ? null : await resolveAccountId(ctx, changes.assignee);

      if (dryRun) {
        const preview = await mapLimit(issues, FAN_OUT, async (i) => {
          const f = i.fields ?? {};
          const diff: Record<string, { from: unknown; to: unknown }> = {};
          for (const n of named) diff[n.field.name] = { from: readValue(n.field, f[n.field.id]) ?? null, to: n.value };
          if (changes.addLabels || changes.removeLabels) {
            const current: string[] = f.labels ?? [];
            const next = [...new Set([...current.filter((l) => !changes.removeLabels?.includes(l)), ...(changes.addLabels ?? [])])];
            diff.labels = { from: current, to: next };
          }
          if (changes.assignee !== undefined) diff.assignee = { from: f.assignee?.displayName ?? null, to: changes.assignee };
          let error: string | undefined;
          if (changes.transition) {
            try {
              const t = await resolveTransition(ctx, i.key, changes.transition);
              diff.status = { from: f.status?.name, to: t.to ?? t.name };
            } catch (err) {
              error = message(err);
            }
          }
          return { key: i.key, summary: f.summary, changes: diff, error };
        });
        return {
          dryRun: true,
          count: issues.length,
          issues: preview,
          note: "Nothing changed. Call again with dryRun=false to apply.",
        };
      }

      const results = await mapLimit(issues, FAN_OUT, async (i) => {
        try {
          if (Object.keys(fields).length || Object.keys(update).length) {
            await jira.put(`/rest/api/3/issue/${i.key}`, {
              ...(Object.keys(fields).length ? { fields } : {}),
              ...(Object.keys(update).length ? { update } : {}),
            });
          }
          if (assignee !== undefined) await jira.put(`/rest/api/3/issue/${i.key}/assignee`, { accountId: assignee });
          if (changes.transition) {
            const t = await resolveTransition(ctx, i.key, changes.transition);
            await jira.post(`/rest/api/3/issue/${i.key}/transitions`, { transition: { id: t.id } });
          }
          return { key: i.key, ok: true };
        } catch (err) {
          return { key: i.key, ok: false, error: message(err) };
        }
      });
      return {
        dryRun: false,
        updated: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      };
    },
  });
}
