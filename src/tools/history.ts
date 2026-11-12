import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchChangelogs, issueChangelog, itemText } from "../jira/changelog.js";
import { searchAll } from "../jira/paging.js";
import { DAY_MS, cycleWindow, stats } from "../reports/cycle.js";
import { defineTool, issueKeySchema as issueKey, type ToolContext } from "./context.js";

const MAX_TEXT = 300;
const clip = (s: string | null) => (s && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s);

export function registerHistoryTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;

  defineTool(server, ctx, {
    name: "get_issue_history",
    title: "Get issue history",
    description:
      "Change history of an issue as {when, who, field, from, to}, newest first. Filter with fields (names, " +
      "config keys or IDs). Long values are cut at 300 chars.",
    input: {
      issueKey,
      fields: z.array(z.string().min(1)).max(20).optional(),
      maxEntries: z.number().int().min(1).max(500).default(100),
    },
    write: false,
    run: async ({ issueKey, fields, maxEntries }) => {
      let wanted: Set<string> | undefined;
      if (fields?.length) {
        wanted = new Set(fields.map((f) => f.toLowerCase()));
        for (const f of fields) {
          const info = await ctx.fields.tryResolve(f).catch(() => undefined);
          if (info) wanted.add(info.id.toLowerCase()).add(info.name.toLowerCase());
        }
      }
      const entries = (await issueChangelog(jira, issueKey)).flatMap((h) =>
        h.items
          .filter((it) => !wanted || wanted.has((it.field ?? "").toLowerCase()) || wanted.has((it.fieldId ?? "").toLowerCase()))
          .map((it) => ({
            when: h.created,
            who: h.author?.displayName,
            field: it.field,
            from: clip(itemText(it, "from")),
            to: clip(itemText(it, "to")),
          })),
      );
      return { issueKey, total: entries.length, entries: entries.slice(-maxEntries).reverse() };
    },
  });

  defineTool(server, ctx, {
    name: "get_cycle_time",
    title: "Cycle time",
    description:
      "Cycle time in days for issues matching JQL: first entry into a cycleTime.start status to the last entry into " +
      "a cycleTime.end status (from the config). Returns median, p85, average and the slowest issues. " +
      "Issues that never passed both statuses are skipped.",
    input: {
      jql: z.string().min(1),
      maxIssues: z.number().int().min(1).max(500).default(200),
      slowest: z.number().int().min(0).max(50).default(10),
    },
    write: false,
    run: async ({ jql, maxIssues, slowest }) => {
      const cfg = ctx.settings().cycleTime;
      const { issues, truncated } = await searchAll(jira, jql, ["summary"], maxIssues);
      const logs = await fetchChangelogs(jira, issues, ["status"]);
      const rows = issues.flatMap((i) => {
        const w = cycleWindow(logs.get(i.key) ?? [], cfg.start, cfg.end);
        if (!w) return [];
        const days = Math.round(((w.end - w.start) / DAY_MS) * 10) / 10;
        const summary: unknown = i.fields?.summary;
        return [{ key: i.key, summary, days, start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() }];
      });
      return {
        startStatuses: cfg.start,
        endStatuses: cfg.end,
        issues: issues.length,
        measured: rows.length,
        truncated: truncated || undefined,
        days: stats(rows.map((r) => r.days)),
        slowest: [...rows].sort((a, b) => b.days - a.days).slice(0, slowest),
      };
    },
  });
}
