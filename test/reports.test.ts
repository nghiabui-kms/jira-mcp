import { describe, expect, it } from "vitest";
import { itemText, type ChangeItem, type History } from "../src/jira/changelog.js";
import { cycleWindow, stats } from "../src/reports/cycle.js";
import { aggregate, inWindow, nextDay, parseJiraDate, weekOf, zonedMidnight } from "../src/reports/time.js";
import { epicProgress } from "../src/tools/epics.js";

const status = (created: string, to: string): History => ({
  created,
  items: [JSON.parse(JSON.stringify({ field: "status", fieldId: "status", from: "1", to: "2", toString: to })) as ChangeItem],
});

describe("changelog text", () => {
  it("reads fromString/toString as own properties only", () => {
    const withText = JSON.parse('{"field":"status","from":"1","to":"3","fromString":"To Do","toString":"Done"}') as ChangeItem;
    expect(itemText(withText, "to")).toBe("Done");
    expect(itemText(withText, "from")).toBe("To Do");
    expect(itemText({ field: "x", from: "a", to: "b" }, "to")).toBe("b"); // not Object.prototype.toString
    expect(itemText({ field: "x" }, "to")).toBeNull();
  });
});

describe("cycle time", () => {
  const start = ["In Progress"];
  const end = ["Done", "Closed"];
  it("measures first start entry to last end entry", () => {
    const h = [
      status("2026-11-01T00:00:00Z", "In Progress"),
      status("2026-11-02T00:00:00Z", "Review"),
      status("2026-11-03T00:00:00Z", "in progress"),
      status("2026-11-04T00:00:00Z", "Done"),
      status("2026-11-05T00:00:00Z", "Reopened"),
      status("2026-11-06T00:00:00Z", "Closed"),
    ];
    const w = cycleWindow(h, start, end);
    expect(w).toEqual({ start: Date.parse("2026-11-01T00:00:00Z"), end: Date.parse("2026-11-06T00:00:00Z") });
  });

  it("skips issues that never started or never finished", () => {
    expect(cycleWindow([status("2026-11-01T00:00:00Z", "Done")], start, end)).toBeUndefined();
    expect(cycleWindow([status("2026-11-01T00:00:00Z", "In Progress")], start, end)).toBeUndefined();
    expect(cycleWindow([], start, end)).toBeUndefined();
  });

  it("computes median, p85 and average", () => {
    expect(stats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ median: 5.5, p85: 9, average: 5.5 });
    expect(stats([4, 1, 3])).toEqual({ median: 3, p85: 4, average: 2.7 });
    expect(stats([])).toEqual({ median: 0, p85: 0, average: 0 });
  });
});

describe("time report helpers", () => {
  it("finds midnight in the account time zone", () => {
    expect(new Date(zonedMidnight("2026-11-10", "Asia/Ho_Chi_Minh")).toISOString()).toBe("2026-11-09T17:00:00.000Z");
    expect(new Date(zonedMidnight("2026-11-10", "UTC")).toISOString()).toBe("2026-11-10T00:00:00.000Z");
    // DST: New York is UTC-4 before 2026-11-01 and UTC-5 after
    expect(new Date(zonedMidnight("2026-11-02", "America/New_York")).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(new Date(zonedMidnight("2026-10-31", "America/New_York")).toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });

  it("keeps only worklogs strictly inside [from, to)", () => {
    const from = zonedMidnight("2026-11-09", "Asia/Ho_Chi_Minh");
    const to = zonedMidnight("2026-11-11", "Asia/Ho_Chi_Minh");
    expect(parseJiraDate("2026-11-09T00:00:00.000+0700")).toBe(from);
    expect(inWindow("2026-11-09T00:00:00.000+0700", from, to)).toBe(true);
    expect(inWindow("2026-11-08T23:59:59.000+0700", from, to)).toBe(false);
    expect(inWindow("2026-11-10T23:59:59.000+0700", from, to)).toBe(true);
    expect(inWindow("2026-11-11T00:00:00.000+0700", from, to)).toBe(false);
    expect(inWindow("2026-11-10T20:00:00.000+0000", from, to)).toBe(false); // = 11-11 03:00 in VN
  });

  it("groups by week (Monday) and aggregates hours", () => {
    expect(weekOf("2026-11-11T09:00:00.000+0700")).toBe("2026-11-09");
    expect(weekOf("2026-11-15T23:00:00.000+0700")).toBe("2026-11-09");
    expect(weekOf("2026-11-16T01:00:00.000+0700")).toBe("2026-11-16");
    expect(
      aggregate([
        { keys: ["Ann"], seconds: 3600 },
        { keys: ["Bob"], seconds: 9000 },
        { keys: ["Ann", "Bob"], seconds: 1800 },
      ]),
    ).toEqual([
      { key: "Bob", hours: 3 },
      { key: "Ann", hours: 1.5 },
    ]);
  });
});

describe("epic progress", () => {
  it("counts by status category and points", () => {
    expect(
      epicProgress([
        { category: "done", points: 3 },
        { category: "indeterminate", points: 5 },
        { category: "new" },
        { category: "done", points: 2 },
      ]),
    ).toEqual({
      children: 4,
      byStatusCategory: { toDo: 1, inProgress: 1, done: 2 },
      points: { total: 10, done: 5 },
      percentDone: 50,
      percentBasis: "points",
      unestimated: 1,
    });
    expect(epicProgress([{ category: "done" }, { category: "new" }])).toMatchObject({ percentDone: 50, percentBasis: "items" });
    expect(epicProgress([])).toMatchObject({ children: 0, percentDone: 0 });
  });
});
