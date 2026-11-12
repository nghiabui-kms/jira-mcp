import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchChangelogs } from "../jira/changelog.js";
import { isObj, readValue, type FieldInfo } from "../jira/fields.js";
import type { RawIssue } from "../jira/format.js";
import { agileAll, jqlString, searchAll } from "../jira/paging.js";
import { sprintChanges, summarizeSprint, type SprintChange, type SprintInfo, type SprintIssue } from "../reports/sprint.js";
import { boardIdOrDefault } from "./backlog.js";
import { defineTool, type ToolContext } from "./context.js";

const SPRINT_ISSUE_CAP = 1000;
const REMOVED_CANDIDATE_CAP = 500;
const DAY_MS = 86_400_000;

interface ReportFields {
  sprint: FieldInfo;
  points?: FieldInfo;
  flagged?: FieldInfo;
  automationStatus?: FieldInfo;
  workType?: FieldInfo;
}

async function reportFields(ctx: ToolContext): Promise<ReportFields> {
  const get = (key: string) => ctx.fields.tryResolve(key);
  const sprint = await get("sprint");
  if (!sprint) throw new Error('Sprint field not found; set fields.sprint in jira-mcp.config.json (see list_fields).');
  return {
    sprint,
    points: await get("storyPoints"),
    flagged: await get("flagged"),
    automationStatus: await get("automationStatus"),
    workType: await get("workType"),
  };
}

const BASE_FIELDS = ["summary", "status", "issuetype", "assignee", "issuelinks", "created", "resolutiondate"];
const fieldList = (rf: ReportFields) => [
  ...BASE_FIELDS,
  ...Object.values(rf)
    .filter((f): f is FieldInfo => !!f)
    .map((f) => f.id),
];

const dig = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), v);

export function toSprintIssue(raw: RawIssue, rf: ReportFields): SprintIssue {
  const f = raw.fields ?? {};
  const str = (field: FieldInfo | undefined) => {
    const v = field ? readValue(field, f[field.id]) : undefined;
    return v === undefined ? undefined : String(v);
  };
  const points: unknown = rf.points ? f[rf.points.id] : undefined;
  const sprints: unknown = f[rf.sprint.id];
  const flagged: unknown = rf.flagged ? f[rf.flagged.id] : undefined;
  const links: unknown[] = Array.isArray(f.issuelinks) ? f.issuelinks : [];
  return {
    id: raw.id,
    key: raw.key,
    summary: f.summary ?? "",
    subtask: f.issuetype?.subtask === true,
    status: f.status?.name ?? "?",
    done: f.status?.statusCategory?.key === "done",
    assignee: f.assignee?.displayName ?? null,
    points: typeof points === "number" ? points : undefined,
    workType: str(rf.workType),
    automationStatus: str(rf.automationStatus),
    flagged: Array.isArray(flagged) && flagged.length > 0,
    created: f.created,
    resolved: f.resolutiondate ?? undefined,
    sprints: Array.isArray(sprints)
      ? sprints.filter(isObj).map((s) => ({
          id: Number(s.id),
          name: typeof s.name === "string" ? s.name : undefined,
          state: typeof s.state === "string" ? s.state : undefined,
          startDate: typeof s.startDate === "string" ? s.startDate : undefined,
        }))
      : [],
    // On issue X, an entry with inwardIssue Y and the "is blocked by" phrase means X is blocked by Y.
    openBlockers: links
      .filter(
        (l) =>
          String(dig(l, "type", "inward")).toLowerCase() === "is blocked by" &&
          dig(l, "inwardIssue", "key") !== undefined &&
          dig(l, "inwardIssue", "fields", "status", "statusCategory", "key") !== "done",
      )
      .map((l) => String(dig(l, "inwardIssue", "key"))),
  };
}

/** Loads a sprint, its issues and Sprint-field history, and computes the summary. */
export async function loadSprintSummary(ctx: ToolContext, sprintId: number) {
  const { jira } = ctx;
  const sprint = await jira.get<SprintInfo>(`/rest/agile/1.0/sprint/${sprintId}`);
  const rf = await reportFields(ctx);
  const fields = fieldList(rf);
  const sprintIssues = await agileAll<RawIssue>(
    jira,
    `/rest/agile/1.0/sprint/${sprintId}/issue`,
    { fields: fields.join(",") },
    "issues",
    SPRINT_ISSUE_CAP,
  );
  const all = sprintIssues.items.map((i) => toSprintIssue(i, rf));
  const issues = all.filter((i) => !i.subtask);
  const notes: string[] = [];
  if (all.length > issues.length) notes.push(`${all.length - issues.length} sub-tasks excluded`);
  if (sprintIssues.truncated) notes.push(`only the first ${SPRINT_ISSUE_CAP} sprint issues were read`);

  let candidates: SprintIssue[] = [];
  let history = new Map<string, SprintChange[]>();
  const start = sprint.activatedDate ?? sprint.startDate;
  if (start) {
    // Issues that left the sprint are no longer returned by it; look for them among recently updated issues.
    const projects = [...new Set(issues.map((i) => i.key.split("-")[0]))];
    const fallback = ctx.settings().defaultProjectKey;
    if (!projects.length && fallback) projects.push(fallback);
    if (projects.length) {
      const since = new Date(Date.parse(start) - DAY_MS).toISOString().slice(0, 10);
      const jql =
        `project in (${projects.map(jqlString).join(",")}) AND updated >= "${since}" ` +
        `AND (sprint is EMPTY OR sprint != ${sprint.id})`;
      const res = await searchAll(jira, jql, fields, REMOVED_CANDIDATE_CAP);
      candidates = res.issues.map((i) => toSprintIssue(i, rf)).filter((i) => !i.subtask);
      if (res.truncated) notes.push(`removed-issue search capped at ${REMOVED_CANDIDATE_CAP} candidates`);
    }
    const logs = await fetchChangelogs(jira, [...issues, ...candidates], [rf.sprint.id]);
    history = new Map([...logs].map(([key, h]) => [key, sprintChanges(h, rf.sprint.id)]));
  }
  const summary = summarizeSprint({
    sprint,
    issues,
    removedCandidates: candidates,
    history,
    blocked: ctx.settings().blocked,
  });
  return { ...summary, notes: notes.length ? notes : undefined };
}

async function activeSprintId(ctx: ToolContext): Promise<number> {
  const board = boardIdOrDefault(ctx);
  const res = await ctx.jira.get<{ values: SprintInfo[] }>(`/rest/agile/1.0/board/${board}/sprint`, { state: "active" });
  if (!res.values.length) throw new Error(`Board ${board} has no active sprint; pass sprintId.`);
  return res.values[0].id;
}

export function registerReportTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "get_sprint_summary",
    title: "Sprint summary",
    description:
      "Sprint health: committed vs done vs remaining (points and items), breakdown by status/assignee/work type, " +
      "unestimated and blocked items, scope change (added after start, removed, carried in from earlier sprints). " +
      "Defaults to the active sprint of defaultBoardId. Sub-tasks excluded; points are current values.",
    input: { sprintId: z.number().int().optional() },
    write: false,
    run: async ({ sprintId }) => loadSprintSummary(ctx, sprintId ?? (await activeSprintId(ctx))),
  });

  defineTool(server, ctx, {
    name: "get_velocity",
    title: "Velocity",
    description:
      "Committed vs completed story points for the last N closed sprints of a board (same maths as " +
      "get_sprint_summary), plus averages. Slow for large N: about 4 Jira calls per sprint.",
    input: {
      boardId: z.number().int().optional().describe("Defaults to defaultBoardId"),
      lastN: z.number().int().min(1).max(12).default(6),
    },
    write: false,
    run: async ({ boardId, lastN }) => {
      const board = boardIdOrDefault(ctx, boardId);
      const { items } = await agileAll<SprintInfo>(
        ctx.jira,
        `/rest/agile/1.0/board/${board}/sprint`,
        { state: "closed" },
        "values",
        1000,
      );
      const endOf = (s: SprintInfo) => Date.parse(s.completeDate ?? s.endDate ?? "") || 0;
      const closed = items
        .filter((s) => !s.originBoardId || s.originBoardId === board)
        .sort((a, b) => endOf(a) - endOf(b))
        .slice(-lastN);
      const sprints: Array<{
        id: number;
        name: string;
        completeDate?: string;
        committed: number;
        completed: number;
        committedItems: number;
        completedItems: number;
      }> = [];
      for (const s of closed) {
        const sum = await loadSprintSummary(ctx, s.id); // sequential: each summary already fans out
        sprints.push({
          id: s.id,
          name: s.name,
          completeDate: s.completeDate,
          committed: sum.totals.committed.points,
          completed: sum.totals.done.points,
          committedItems: sum.totals.committed.items,
          completedItems: sum.totals.done.items,
        });
      }
      const avg = (pick: (r: (typeof sprints)[number]) => number) =>
        sprints.length ? Math.round((sprints.reduce((s, r) => s + pick(r), 0) / sprints.length) * 10) / 10 : 0;
      return {
        boardId: board,
        sprints,
        average: { committed: avg((r) => r.committed), completed: avg((r) => r.completed) },
      };
    },
  });
}
