import { describe, expect, it } from "vitest";
import {
  blockedReasons,
  doneInSprint,
  memberAt,
  sprintChanges,
  summarizeSprint,
  type SprintChange,
  type SprintInfo,
  type SprintIssue,
} from "../src/reports/sprint.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { mapLimit } from "../src/util/pool.js";

const T = (d: string) => Date.parse(`2026-11-${d}T00:00:00.000Z`);
const START = "2026-11-02T09:00:00.000Z";
const sprint: SprintInfo = { id: 20, name: "S20", state: "active", startDate: START, endDate: "2026-11-16T09:00:00.000Z" };

const issue = (key: string, over: Partial<SprintIssue> = {}): SprintIssue => ({
  id: key.replace(/\D/g, ""),
  key,
  summary: key,
  subtask: false,
  status: "To Do",
  done: false,
  assignee: "Ann",
  points: 3,
  flagged: false,
  created: "2026-10-01T00:00:00.000Z",
  sprints: [{ id: 20, state: "active", startDate: START }],
  openBlockers: [],
  ...over,
});
const ch = (day: string, from: number[], to: number[]): SprintChange => ({ at: T(day), from, to });
const rules = { statuses: ["Refinement"], automationStatus: ["Blocked"], flagged: true, blockedByLink: true };

describe("sprint maths", () => {
  it("memberAt replays Sprint changes", () => {
    const changes = [ch("01", [], [20]), ch("05", [20], [])];
    expect(memberAt(changes, 20, T("03"), 0, false)).toBe(true);
    expect(memberAt(changes, 20, T("06"), 0, false)).toBe(false);
    expect(memberAt([ch("05", [], [20])], 20, T("03"), 0, true)).toBe(false); // added later
    expect(memberAt([], 20, T("03"), 0, true)).toBe(true); // never changed: current membership
    expect(memberAt([], 20, T("03"), T("04"), true)).toBe(false); // created after t
  });

  it("parses Sprint changelog items for the configured field only", () => {
    const parsed = sprintChanges(
      [
        { created: "2026-11-03T00:00:00.000Z", items: [{ fieldId: "customfield_10020", from: "19", to: "19, 20" }] },
        { created: "2026-11-01T00:00:00.000Z", items: [{ fieldId: "status", from: "1", to: "2" }] },
      ],
      "customfield_10020",
    );
    expect(parsed).toEqual([{ at: T("03"), from: [19], to: [19, 20] }]);
  });

  it("computes committed, added, removed, carried-in and done", () => {
    const issues = [
      issue("A-1", { done: true, status: "Done" }),
      issue("A-2", { points: 5 }), // added after start via changelog
      issue("A-3", { points: undefined, created: "2026-11-04T00:00:00.000Z" }), // created into the sprint after start
      issue("A-4", {
        points: 2,
        assignee: null,
        sprints: [
          { id: 19, state: "closed", name: "S19", startDate: "2026-10-19T09:00:00.000Z" },
          { id: 20, state: "active", startDate: START },
        ],
      }),
    ];
    const removedCandidates = [
      issue("A-5", { points: 8, sprints: [] }), // in at start, removed during sprint
      issue("A-6", { points: 1, sprints: [] }), // never in this sprint
    ];
    const history = new Map([
      ["A-2", [ch("05", [], [20])]],
      ["A-4", [ch("01", [19], [19, 20])]],
      ["A-5", [ch("01", [], [20]), ch("06", [20], [])]],
      ["A-6", [ch("06", [], [21])]],
    ]);
    const s = summarizeSprint({ sprint, issues, removedCandidates, history, blocked: rules });

    expect(s.totals.committed).toEqual({ items: 3, points: 13 }); // A-1, A-4, A-5
    expect(s.totals.scope).toEqual({ items: 4, points: 10 });
    expect(s.totals.done).toEqual({ items: 1, points: 3 });
    expect(s.totals.remaining).toEqual({ items: 3, points: 7 });
    expect(s.totals.unestimated).toBe(1);
    expect(s.scopeChange?.added.issues.map((i) => i.key)).toEqual(["A-2", "A-3"]);
    expect(s.scopeChange?.added.issues[0].at).toBe(new Date(T("05")).toISOString());
    expect(s.scopeChange?.removed).toMatchObject({ items: 1, points: 8, issues: [{ key: "A-5" }] });
    expect(s.scopeChange?.carriedIn.issues).toMatchObject([{ key: "A-4", fromSprints: ["S19"] }]);
    expect(s.byAssignee).toEqual({
      Ann: { items: 3, points: 8, donePoints: 3 },
      Unassigned: { items: 1, points: 2, donePoints: 0 },
    });
    expect(s.byStatus["To Do"]).toEqual({ items: 3, points: 7 });
  });

  it("does not report scope change for a future sprint", () => {
    const s = summarizeSprint({
      sprint: { id: 21, name: "S21", state: "future" },
      issues: [issue("A-1")],
      removedCandidates: [],
      history: new Map(),
      blocked: rules,
    });
    expect(s.scopeChange).toBeUndefined();
    expect(s.totals.committed.items).toBe(1);
  });

  it("closed sprints count only work resolved before the sprint closed", () => {
    const closed: SprintInfo = { ...sprint, state: "closed", completeDate: "2026-11-16T10:00:00.000Z" };
    expect(doneInSprint(issue("A-1", { done: true, resolved: "2026-11-15T00:00:00.000Z" }), closed)).toBe(true);
    expect(doneInSprint(issue("A-1", { done: true, resolved: "2026-11-20T00:00:00.000Z" }), closed)).toBe(false);
    const movedOn = issue("A-1", { done: true, sprints: [{ id: 20 }, { id: 21 }] });
    expect(doneInSprint(movedOn, closed)).toBe(false);
    expect(doneInSprint(issue("A-1", { done: true }), closed)).toBe(true);
  });

  it("applies the blocked rules", () => {
    expect(blockedReasons(issue("A-1", { status: "refinement" }), rules)).toEqual(["status: refinement"]);
    expect(blockedReasons(issue("A-1", { automationStatus: "Blocked" }), rules)).toEqual(["automation status: Blocked"]);
    expect(blockedReasons(issue("A-1", { flagged: true, openBlockers: ["A-9"] }), rules)).toEqual([
      "flagged",
      "blocked by A-9",
    ]);
    expect(blockedReasons(issue("A-1", { flagged: true }), { ...rules, flagged: false })).toEqual([]);
    expect(blockedReasons(issue("A-1", { status: "Refinement" }), DEFAULT_SETTINGS.blocked)).toEqual([]);
  });
});

describe("mapLimit", () => {
  it("keeps order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit(Array.from({ length: 23 }, (_, i) => i), 5, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1 + (n % 3)));
      inFlight--;
      return n * 2;
    });
    expect(peak).toBe(5);
    expect(out).toEqual(Array.from({ length: 23 }, (_, i) => i * 2));
  });
});
