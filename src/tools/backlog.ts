import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIST_FIELDS, simplifyIssue, type RawIssue } from "../jira/format.js";
import { agileAll } from "../jira/paging.js";
import {
  assertWritable,
  defineTool,
  issueKeySchema as issueKey,
  outputFieldsSchema,
  withWarnings,
  type ToolContext,
} from "./context.js";

const TOTALS_CAP = 2000;

export function boardIdOrDefault(ctx: ToolContext, boardId?: number): number {
  const id = boardId ?? ctx.settings().defaultBoardId;
  if (!id) throw new Error("boardId is required (no defaultBoardId in the config).");
  return id;
}

export function registerBacklogTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;
  const site = ctx.config.JIRA_BASE_URL;

  defineTool(server, ctx, {
    name: "get_backlog",
    title: "Get backlog",
    description:
      "List a board's backlog in rank order (issues not in an active/future sprint), with story points. " +
      "The first page (startAt=0) also returns totals for the whole backlog: items, points, unestimated (sub-tasks excluded).",
    input: {
      boardId: z.number().int().optional().describe("Defaults to defaultBoardId"),
      jql: z.string().optional().describe("Extra filter, e.g. component = API"),
      maxResults: z.number().int().min(1).max(100).default(50),
      startAt: z.number().int().min(0).default(0),
      fields: outputFieldsSchema,
    },
    write: false,
    run: async ({ boardId, jql, maxResults, startAt, fields }) => {
      const board = boardIdOrDefault(ctx, boardId);
      const path = `/rest/agile/1.0/board/${board}/backlog`;
      const out = await ctx.fields.outputFields([...(fields ?? []), "storyPoints"]);
      const res = await jira.get<{ issues: RawIssue[]; total: number }>(path, {
        jql,
        startAt,
        maxResults,
        fields: [...LIST_FIELDS, ...out.ids].join(","),
      });
      let totals: Record<string, unknown> | undefined;
      if (startAt === 0) {
        const sp = await ctx.fields.tryResolve("storyPoints").catch(() => undefined);
        const all = await agileAll<RawIssue>(
          jira,
          path,
          { jql, fields: ["issuetype", ...(sp ? [sp.id] : [])].join(",") },
          "issues",
          TOTALS_CAP,
        );
        const parents = all.items.filter((i) => !i.fields?.issuetype?.subtask);
        const pts = parents.map((i): unknown => (sp ? i.fields?.[sp.id] : undefined));
        totals = {
          items: parents.length,
          points: Math.round(pts.reduce<number>((s, p) => s + (typeof p === "number" ? p : 0), 0) * 100) / 100,
          unestimated: pts.filter((p) => typeof p !== "number").length,
          truncated: all.truncated || undefined,
        };
      }
      return withWarnings(
        { boardId: board, total: res.total, startAt, totals, issues: res.issues.map((i) => simplifyIssue(i, site, out.fields)) },
        out.warnings,
      );
    },
  });

  defineTool(server, ctx, {
    name: "rank_issues",
    title: "Rank issues",
    description: "Move up to 50 issues to just before or just after another issue in rank order. Pass exactly one of before/after.",
    input: {
      issueKeys: z.array(issueKey).min(1).max(50),
      before: issueKey.optional().describe("Rank the issues before this issue"),
      after: issueKey.optional().describe("Rank the issues after this issue"),
    },
    write: true,
    idempotent: true,
    run: async ({ issueKeys, before, after }) => {
      if (!before === !after) throw new Error("Pass exactly one of before / after.");
      assertWritable(ctx, issueKeys);
      // 204 = all ranked; 207 = per-issue results
      const res = await jira.put<{ entries?: Array<{ issueKey: string; status: number; errors?: string[] }> } | undefined>(
        "/rest/agile/1.0/issue/rank",
        { issues: issueKeys, ...(before ? { rankBeforeIssue: before } : { rankAfterIssue: after }) },
      );
      const failed = (res?.entries ?? [])
        .filter((e) => e.status >= 300)
        .map((e) => ({ key: e.issueKey, errors: e.errors }));
      return {
        ranked: issueKeys.filter((k) => !failed.some((f) => f.key === k)),
        position: before ? { before } : { after },
        failed: failed.length ? failed : undefined,
      };
    },
  });

  defineTool(server, ctx, {
    name: "move_issues_to_backlog",
    title: "Move issues to backlog",
    description: "Remove up to 50 issues from their active/future sprint, moving them to the backlog.",
    input: { issueKeys: z.array(issueKey).min(1).max(50) },
    write: true,
    idempotent: true,
    run: async ({ issueKeys }) => {
      assertWritable(ctx, issueKeys);
      await jira.post("/rest/agile/1.0/backlog/issue", { issues: issueKeys });
      return { movedToBacklog: issueKeys };
    },
  });
}
