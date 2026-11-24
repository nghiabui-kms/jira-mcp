import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { adfToShortText, textToAdf } from "../jira/adf.js";
import { toJiraDateTime } from "../jira/format.js";
import { assertWritable, defineTool, durationSchema, issueKeySchema as issueKey, type ToolContext } from "./context.js";

export function registerWorklogTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;

  defineTool(server, ctx, {
    name: "get_worklogs",
    title: "Get worklogs",
    description: "List worklogs of an issue, optionally only those started after a date.",
    input: {
      issueKey,
      startedAfter: z.string().optional().describe("ISO date/time, e.g. 2026-11-01 or 2026-11-01T00:00:00+07:00"),
    },
    write: false,
    run: async ({ issueKey, startedAfter }) => {
      const after = startedAfter ? parseDate(startedAfter).getTime() : undefined;
      const res = await jira.get<{ total: number; worklogs: Array<Record<string, any>> }>(
        `/rest/api/3/issue/${issueKey}/worklog`,
        { startedAfter: after, maxResults: 100 },
      );
      return {
        total: res.total,
        worklogs: res.worklogs.map((w) => ({
          id: w.id,
          author: w.author?.displayName,
          started: w.started,
          timeSpent: w.timeSpent,
          timeSpentSeconds: w.timeSpentSeconds,
          comment: adfToShortText(w.comment, 500),
        })),
      };
    },
  });

  defineTool(server, ctx, {
    name: "add_worklog",
    title: "Log work",
    description:
      "Log time on an issue. timeSpent uses Jira format ('1h 30m', '2d', '45m'). " +
      "started is ISO 8601 with offset (e.g. 2026-11-10T09:00:00+07:00); defaults to now.",
    input: {
      issueKey,
      timeSpent: durationSchema,
      started: z.string().optional(),
      comment: z.string().optional(),
    },
    write: true,
    idempotent: false,
    run: async ({ issueKey, timeSpent, started, comment }) => {
      assertWritable(ctx, [issueKey]);
      const res = await jira.post<{ id: string; timeSpent: string; started: string }>(
        `/rest/api/3/issue/${issueKey}/worklog`,
        {
          timeSpent: timeSpent.trim(),
          started: toJiraDateTime(started ? parseDate(started) : new Date()),
          ...(comment ? { comment: textToAdf(comment) } : {}),
        },
      );
      return { issueKey, worklogId: res.id, timeSpent: res.timeSpent, started: res.started };
    },
  });

  defineTool(server, ctx, {
    name: "delete_worklog",
    title: "Delete worklog",
    description:
      "Delete one worklog of an issue (get the id from get_worklogs). " +
      "Jira auto-adjusts the remaining estimate. Cannot be undone.",
    input: { issueKey, worklogId: z.string().regex(/^\d+$/, "Numeric worklog id") },
    write: true,
    idempotent: true,
    destructive: true,
    run: async ({ issueKey, worklogId }) => {
      assertWritable(ctx, [issueKey]);
      const path = `/rest/api/3/issue/${issueKey}/worklog/${worklogId}`;
      const w = await jira.get<Record<string, any>>(path);
      await jira.delete(path);
      return {
        issueKey,
        deleted: worklogId,
        was: { author: w.author?.displayName, started: w.started, timeSpent: w.timeSpent },
      };
    },
  });
}

function parseDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: "${value}" (use ISO 8601)`);
  return d;
}
