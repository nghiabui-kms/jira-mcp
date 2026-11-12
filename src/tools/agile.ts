import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIST_FIELDS, simplifyIssue, type RawIssue } from "../jira/format.js";
import { agileAll } from "../jira/paging.js";
import type { SprintInfo } from "../reports/sprint.js";
import { boardIdOrDefault } from "./backlog.js";
import { assertWritable, defineTool, outputFieldsSchema, withWarnings, type ToolContext } from "./context.js";

const sprintState = z.enum(["active", "future", "closed"]);

export function registerAgileTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;
  const site = ctx.config.JIRA_BASE_URL;

  defineTool(server, ctx, {
    name: "list_boards",
    title: "List boards",
    description: "List Scrum/Kanban boards, optionally filtered by project key or board name.",
    input: { projectKey: z.string().optional(), name: z.string().optional() },
    write: false,
    run: async ({ projectKey, name }) => {
      const res = await jira.get<{ values: Array<Record<string, any>> }>("/rest/agile/1.0/board", {
        projectKeyOrId: projectKey,
        name,
        maxResults: 50,
      });
      return res.values.map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type,
        project: b.location?.projectKey,
      }));
    },
  });

  defineTool(server, ctx, {
    name: "list_sprints",
    title: "List sprints",
    description: "List sprints of a Scrum board. Defaults to active and future sprints.",
    input: {
      boardId: z.number().int(),
      states: z.array(sprintState).default(["active", "future"]),
      startAt: z.number().int().min(0).default(0),
    },
    write: false,
    run: async ({ boardId, states, startAt }) => {
      const res = await jira.get<{ values: Array<Record<string, any>>; isLast: boolean }>(
        `/rest/agile/1.0/board/${boardId}/sprint`,
        { state: states.join(","), startAt, maxResults: 50 },
      );
      return {
        sprints: res.values.map((s) => ({
          id: s.id,
          name: s.name,
          state: s.state,
          startDate: s.startDate,
          endDate: s.endDate,
          goal: s.goal || undefined,
        })),
        nextStartAt: res.isLast ? undefined : startAt + res.values.length,
      };
    },
  });

  defineTool(server, ctx, {
    name: "get_sprint_issues",
    title: "Get sprint issues",
    description: "List issues in a sprint, optionally narrowed by extra JQL (e.g. assignee = currentUser()).",
    input: {
      sprintId: z.number().int(),
      jql: z.string().optional(),
      maxResults: z.number().int().min(1).max(100).default(50),
      startAt: z.number().int().min(0).default(0),
      fields: outputFieldsSchema,
    },
    write: false,
    run: async ({ sprintId, jql, maxResults, startAt, fields }) => {
      const out = await ctx.fields.outputFields(fields);
      const res = await jira.get<{ issues: RawIssue[]; total: number }>(
        `/rest/agile/1.0/sprint/${sprintId}/issue`,
        { jql, maxResults, startAt, fields: [...LIST_FIELDS, ...out.ids].join(",") },
      );
      return withWarnings(
        { total: res.total, startAt, issues: res.issues.map((i) => simplifyIssue(i, site, out.fields)) },
        out.warnings,
      );
    },
  });

  defineTool(server, ctx, {
    name: "move_issues_to_sprint",
    title: "Move issues to sprint",
    description: "Move up to 50 issues into a sprint (the sprint must be active or future).",
    input: { sprintId: z.number().int(), issueKeys: z.array(z.string()).min(1).max(50) },
    write: true,
    idempotent: true,
    run: async ({ sprintId, issueKeys }) => {
      assertWritable(ctx, issueKeys);
      await jira.post(`/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: issueKeys });
      return { sprintId, moved: issueKeys };
    },
  });

  // ---------- sprint management ----------

  defineTool(server, ctx, {
    name: "create_sprint",
    title: "Create sprint",
    description: "Create a future sprint on a board. Dates are ISO (2026-11-16 or 2026-11-16T09:00:00+07:00).",
    input: {
      boardId: z.number().int().optional().describe("Defaults to defaultBoardId"),
      name: z.string().min(1).max(30),
      startDate: isoDate.optional(),
      endDate: isoDate.optional(),
      goal: z.string().optional(),
    },
    write: true,
    idempotent: false,
    run: async ({ boardId, name, startDate, endDate, goal }) => {
      const board = boardIdOrDefault(ctx, boardId);
      await assertBoardWritable(ctx, board);
      const s = await jira.post<SprintInfo>("/rest/agile/1.0/sprint", { name, originBoardId: board, startDate, endDate, goal });
      return sprintOut(s);
    },
  });

  defineTool(server, ctx, {
    name: "update_sprint",
    title: "Update sprint",
    description: "Change a sprint's name, dates or goal; only what you pass changes. Closed sprints accept name and goal only.",
    input: {
      sprintId: z.number().int(),
      name: z.string().min(1).max(30).optional(),
      startDate: isoDate.optional(),
      endDate: isoDate.optional(),
      goal: z.string().optional(),
    },
    write: true,
    idempotent: true,
    run: async ({ sprintId, ...changes }) => {
      if (!Object.values(changes).some((v) => v !== undefined)) throw new Error("Nothing to update.");
      const sprint = await getSprint(ctx, sprintId);
      await assertBoardWritable(ctx, sprint.originBoardId);
      return sprintOut(await jira.post<SprintInfo>(`/rest/agile/1.0/sprint/${sprintId}`, changes));
    },
  });

  defineTool(server, ctx, {
    name: "start_sprint",
    title: "Start sprint",
    description:
      "Start a future sprint. startDate defaults to the sprint's planned start, else now; endDate is required " +
      "unless the sprint already has one.",
    input: { sprintId: z.number().int(), startDate: isoDate.optional(), endDate: isoDate.optional() },
    write: true,
    idempotent: false,
    run: async ({ sprintId, startDate, endDate }) => {
      const sprint = await getSprint(ctx, sprintId);
      if (sprint.state !== "future") throw new Error(`Sprint ${sprint.name} is ${sprint.state}; only future sprints can be started.`);
      const end = endDate ?? sprint.endDate;
      if (!end) throw new Error("endDate is required (the sprint has no planned end date).");
      await assertBoardWritable(ctx, sprint.originBoardId);
      const body = { state: "active", startDate: startDate ?? sprint.startDate ?? new Date().toISOString(), endDate: end };
      return sprintOut(await jira.post<SprintInfo>(`/rest/agile/1.0/sprint/${sprintId}`, body));
    },
  });

  defineTool(server, ctx, {
    name: "close_sprint",
    title: "Close sprint",
    description:
      "Close an active sprint. Incomplete issues (status category not Done; sub-tasks follow their parent) are first " +
      'moved to moveIncompleteTo (a sprint id or "backlog"), then the sprint is closed. confirm=false (default) only ' +
      "previews the issues that would move.",
    input: {
      sprintId: z.number().int(),
      moveIncompleteTo: z.union([z.number().int(), z.literal("backlog")]),
      confirm: z.boolean().default(false),
    },
    write: true,
    idempotent: false,
    destructive: true,
    run: async ({ sprintId, moveIncompleteTo, confirm }) => {
      const sprint = await getSprint(ctx, sprintId);
      if (sprint.state !== "active") throw new Error(`Sprint ${sprint.name} is ${sprint.state}; only active sprints can be closed.`);
      let target: SprintInfo | undefined;
      if (moveIncompleteTo !== "backlog") {
        if (moveIncompleteTo === sprintId) throw new Error("moveIncompleteTo must be another sprint.");
        target = await getSprint(ctx, moveIncompleteTo);
        if (target.state === "closed") throw new Error(`Target sprint ${target.name} is closed.`);
      }
      const { items, truncated } = await agileAll<RawIssue>(
        jira,
        `/rest/agile/1.0/sprint/${sprintId}/issue`,
        { fields: "summary,status,issuetype,assignee" },
        "issues",
        CLOSE_CAP,
      );
      if (truncated) throw new Error(`Sprint has more than ${CLOSE_CAP} issues; close it in Jira instead.`);
      const incomplete = items.filter((i) => i.fields?.status?.statusCategory?.key !== "done" && !i.fields?.issuetype?.subtask);
      const keys = incomplete.map((i) => i.key);
      const destination = target ? `sprint ${target.id} (${target.name})` : "backlog";
      await assertBoardWritable(ctx, sprint.originBoardId);
      assertWritable(ctx, keys);

      if (!confirm) {
        return {
          preview: true,
          sprint: sprintOut(sprint),
          incomplete: keys.length,
          moveTo: destination,
          issues: incomplete.slice(0, 100).map((i) => ({
            key: i.key,
            summary: i.fields?.summary,
            status: i.fields?.status?.name,
            assignee: i.fields?.assignee?.displayName ?? null,
          })),
          note: "Nothing changed. Call again with confirm=true to move these issues and close the sprint.",
        };
      }
      // The Cloud API would send incomplete issues to the backlog on close; move them explicitly first.
      for (let i = 0; i < keys.length; i += 50) {
        const issues = keys.slice(i, i + 50);
        if (target) await jira.post(`/rest/agile/1.0/sprint/${target.id}/issue`, { issues });
        else await jira.post("/rest/agile/1.0/backlog/issue", { issues });
      }
      const closed = await jira.post<SprintInfo>(`/rest/agile/1.0/sprint/${sprintId}`, { state: "closed" });
      return { closed: sprintOut(closed), moved: keys.length, movedTo: destination };
    },
  });
}

const CLOSE_CAP = 1000;

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "ISO date, e.g. 2026-11-16 or 2026-11-16T09:00:00+07:00")
  .transform((s) => new Date(s).toISOString());

const sprintOut = (s: SprintInfo) => ({
  id: s.id,
  name: s.name,
  state: s.state,
  startDate: s.startDate,
  endDate: s.endDate,
  completeDate: s.completeDate,
  goal: s.goal || undefined,
});

const getSprint = (ctx: ToolContext, id: number) => ctx.jira.get<SprintInfo>(`/rest/agile/1.0/sprint/${id}`);

/** With ALLOWED_PROJECTS set, sprint writes need the board's project to be allowed. */
async function assertBoardWritable(ctx: ToolContext, boardId: number | undefined): Promise<void> {
  if (!ctx.config.ALLOWED_PROJECTS.length) return;
  const board = boardId
    ? await ctx.jira.get<{ location?: { projectKey?: string } }>(`/rest/agile/1.0/board/${boardId}`)
    : undefined;
  const project = board?.location?.projectKey;
  if (!project) throw new Error(`Write blocked: cannot tell the project of board ${boardId ?? "?"} while ALLOWED_PROJECTS is set.`);
  assertWritable(ctx, [project]);
}
