import type { History } from "../jira/changelog.js";
import type { Settings } from "../settings.js";

export interface SprintInfo {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  activatedDate?: string;
  goal?: string;
  originBoardId?: number;
}

/** One issue reduced to what the sprint maths needs. */
export interface SprintIssue {
  id: string;
  key: string;
  summary: string;
  subtask: boolean;
  status: string;
  done: boolean;
  assignee: string | null;
  points?: number;
  workType?: string;
  automationStatus?: string;
  flagged: boolean;
  created: string;
  resolved?: string;
  sprints: Array<{ id: number; name?: string; state?: string; startDate?: string }>;
  /** Keys of not-done issues linked as "is blocked by". */
  openBlockers: string[];
}

/** A change of the Sprint field: sprint IDs before and after. */
export interface SprintChange {
  at: number;
  from: number[];
  to: number[];
}

const LIST_CAP = 50;

const sprintIds = (s?: string | null) =>
  (s ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

export function sprintChanges(histories: History[], sprintFieldId: string): SprintChange[] {
  return histories
    .flatMap((h) =>
      h.items
        .filter((i) => i.fieldId === sprintFieldId)
        .map((i) => ({ at: Date.parse(h.created), from: sprintIds(i.from), to: sprintIds(i.to) })),
    )
    .sort((a, b) => a.at - b.at);
}

/** Was the issue in the sprint at time t? `memberNow` is used when the Sprint field never changed. */
export function memberAt(changes: SprintChange[], sprintId: number, t: number, created: number, memberNow: boolean): boolean {
  if (t < created) return false;
  const before = changes.filter((c) => c.at <= t);
  if (before.length) return before[before.length - 1].to.includes(sprintId);
  const after = changes.find((c) => c.at > t);
  return after ? after.from.includes(sprintId) : memberNow;
}

/** Done for this sprint: done now, and for closed sprints resolved before the sprint closed. */
export function doneInSprint(issue: SprintIssue, sprint: SprintInfo): boolean {
  if (!issue.done) return false;
  if (sprint.state !== "closed") return true;
  const end = Date.parse(sprint.completeDate ?? sprint.endDate ?? "");
  const resolved = Date.parse(issue.resolved ?? "");
  if (!Number.isNaN(resolved) && !Number.isNaN(end)) return resolved <= end;
  // No resolution date: count it only if this sprint is the issue's latest (higher id = created later)
  return Math.max(...issue.sprints.map((s) => s.id)) === sprint.id;
}

export function blockedReasons(issue: SprintIssue, rules: Settings["blocked"]): string[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const reasons: string[] = [];
  if (rules.statuses.some((s) => same(s, issue.status))) reasons.push(`status: ${issue.status}`);
  const auto = issue.automationStatus;
  if (auto && rules.automationStatus.some((s) => same(s, auto))) reasons.push(`automation status: ${auto}`);
  if (rules.flagged && issue.flagged) reasons.push("flagged");
  if (rules.blockedByLink && issue.openBlockers.length) reasons.push(`blocked by ${issue.openBlockers.join(", ")}`);
  return reasons;
}

const round = (n: number) => Math.round(n * 100) / 100;
export const total = (list: SprintIssue[]) => ({
  items: list.length,
  points: round(list.reduce((s, i) => s + (i.points ?? 0), 0)),
});

function group(list: SprintIssue[], keyOf: (i: SprintIssue) => string, isDone?: (i: SprintIssue) => boolean) {
  const out: Record<string, { items: number; points: number; donePoints?: number }> = {};
  for (const i of list) {
    const g = (out[keyOf(i)] ??= { items: 0, points: 0, ...(isDone ? { donePoints: 0 } : {}) });
    g.items++;
    g.points = round(g.points + (i.points ?? 0));
    if (isDone?.(i)) g.donePoints = round((g.donePoints ?? 0) + (i.points ?? 0));
  }
  return out;
}

const brief = (i: SprintIssue) => ({ key: i.key, summary: i.summary, points: i.points, assignee: i.assignee, status: i.status });
const iso = (t: number) => new Date(t).toISOString();

/**
 * Sprint maths. `issues` are the sprint's current issues (no sub-tasks); `removedCandidates` are other
 * issues that may have left the sprint; `history` holds Sprint-field changes by issue key.
 */
export function summarizeSprint(input: {
  sprint: SprintInfo;
  issues: SprintIssue[];
  removedCandidates: SprintIssue[];
  history: Map<string, SprintChange[]>;
  blocked: Settings["blocked"];
}) {
  const { sprint, issues: scope } = input;
  const id = sprint.id;
  const start = Date.parse(sprint.activatedDate ?? sprint.startDate ?? "");
  const started = !Number.isNaN(start);
  const end = sprint.state === "closed" ? Date.parse(sprint.completeDate ?? sprint.endDate ?? "") : Infinity;
  const changes = (key: string) => input.history.get(key) ?? [];
  const inAtStart = (i: SprintIssue, memberNow: boolean) =>
    !started || memberAt(changes(i.key), id, start, Date.parse(i.created), memberNow);
  const isDone = (i: SprintIssue) => doneInSprint(i, sprint);

  const added = started ? scope.filter((i) => !inAtStart(i, true)) : [];
  const removedAt = (i: SprintIssue) =>
    changes(i.key).find((c) => c.at >= start && c.at <= end && c.from.includes(id) && !c.to.includes(id))?.at;
  const removed = started ? input.removedCandidates.filter((i) => removedAt(i) !== undefined) : [];
  const committed = [...scope.filter((i) => inAtStart(i, true)), ...removed.filter((i) => inAtStart(i, false))];
  const done = scope.filter(isDone);
  const remaining = scope.filter((i) => !isDone(i));
  const earlierClosed = (i: SprintIssue) =>
    i.sprints.filter(
      (s) =>
        s.id !== id &&
        s.state === "closed" &&
        (started && s.startDate ? Date.parse(s.startDate) < start : s.id < id),
    );
  const carriedIn = scope.filter((i) => earlierClosed(i).length);
  const addedAt = (i: SprintIssue) =>
    changes(i.key).find((c) => c.at >= start && c.to.includes(id) && !c.from.includes(id))?.at ?? Date.parse(i.created);
  const unestimated = scope.filter((i) => i.points === undefined);
  const blocked = remaining
    .map((i) => ({ ...brief(i), reasons: blockedReasons(i, input.blocked) }))
    .filter((b) => b.reasons.length);

  return {
    sprint: {
      id,
      name: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      completeDate: sprint.completeDate,
      goal: sprint.goal || undefined,
    },
    totals: {
      committed: total(committed),
      scope: total(scope),
      done: total(done),
      remaining: total(remaining),
      unestimated: unestimated.length,
      blocked: blocked.length,
    },
    byStatus: group(scope, (i) => i.status),
    byAssignee: group(scope, (i) => i.assignee ?? "Unassigned", isDone),
    byWorkType: group(scope, (i) => i.workType ?? "(none)"),
    unestimated: unestimated.slice(0, LIST_CAP).map(brief),
    blocked: blocked.slice(0, LIST_CAP),
    scopeChange: started
      ? {
          added: { ...total(added), issues: added.slice(0, LIST_CAP).map((i) => ({ ...brief(i), at: iso(addedAt(i)) })) },
          removed: {
            ...total(removed),
            issues: removed.slice(0, LIST_CAP).map((i) => ({ ...brief(i), at: iso(removedAt(i) ?? 0) })),
          },
          carriedIn: {
            ...total(carriedIn),
            issues: carriedIn
              .slice(0, LIST_CAP)
              .map((i) => ({ ...brief(i), fromSprints: earlierClosed(i).map((s) => s.name ?? String(s.id)) })),
          },
        }
      : undefined,
  };
}
