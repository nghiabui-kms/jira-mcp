import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELDS, SETTINGS, connect, fakeJira, testContext, type Call } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/rest/api/3/search/jql");

describe("close_sprint", () => {
  const issue = (key: string, cat: string, subtask = false) => ({
    id: key,
    key,
    fields: { summary: key, status: { name: cat, statusCategory: { key: cat } }, issuetype: { subtask } },
  });
  const routes = () => ({
    "GET /rest/agile/1.0/sprint/20": { id: 20, name: "S20", state: "active", originBoardId: 2092 },
    "GET /rest/agile/1.0/sprint/21": { id: 21, name: "S21", state: "future", originBoardId: 2092 },
    "GET /rest/agile/1.0/board/2092": { id: 2092, location: { projectKey: "AUTOKAT" } },
    "GET /rest/agile/1.0/sprint/20/issue": {
      total: 4,
      issues: [issue("AUTOKAT-1", "done"), issue("AUTOKAT-2", "indeterminate"), issue("AUTOKAT-3", "new"), issue("AUTOKAT-4", "new", true)],
    },
    "POST /rest/agile/1.0/sprint/21/issue": undefined,
    "POST /rest/agile/1.0/backlog/issue": undefined,
    "POST /rest/agile/1.0/sprint/20": { id: 20, name: "S20", state: "closed" },
  });

  it("previews without changing anything when confirm is false", async () => {
    const calls = fakeJira(routes());
    const { call } = await connect(testContext({ config: { ALLOWED_PROJECTS: ["AUTOKAT"] } }));
    const res = await call("close_sprint", { sprintId: 20, moveIncompleteTo: 21 });
    expect(res).toMatchObject({ preview: true, incomplete: 2, moveTo: "sprint 21 (S21)" });
    expect((res.issues as Array<{ key: string }>).map((i) => i.key)).toEqual(["AUTOKAT-2", "AUTOKAT-3"]);
    expect(writes(calls)).toHaveLength(0);
  });

  it("moves incomplete issues first, then closes", async () => {
    const calls = fakeJira(routes());
    const { call } = await connect(testContext());
    const res = await call("close_sprint", { sprintId: 20, moveIncompleteTo: 21, confirm: true });
    expect(res).toMatchObject({ moved: 2, movedTo: "sprint 21 (S21)", closed: { state: "closed" } });
    expect(writes(calls).map((c) => [c.path, c.body])).toEqual([
      ["/rest/agile/1.0/sprint/21/issue", { issues: ["AUTOKAT-2", "AUTOKAT-3"] }],
      ["/rest/agile/1.0/sprint/20", { state: "closed" }],
    ]);
  });

  it("moves to the backlog when asked", async () => {
    const calls = fakeJira(routes());
    const { call } = await connect(testContext());
    await call("close_sprint", { sprintId: 20, moveIncompleteTo: "backlog", confirm: true });
    expect(writes(calls)[0].path).toBe("/rest/agile/1.0/backlog/issue");
  });

  it("refuses non-active sprints and a project outside ALLOWED_PROJECTS", async () => {
    const calls = fakeJira({ ...routes(), "GET /rest/agile/1.0/sprint/20": { id: 20, name: "S20", state: "future", originBoardId: 2092 } });
    const { call } = await connect(testContext());
    await expect(call("close_sprint", { sprintId: 20, moveIncompleteTo: "backlog", confirm: true })).rejects.toThrow(/only active/);
    fakeJira(routes());
    const { call: call2 } = await connect(testContext({ config: { ALLOWED_PROJECTS: ["SANDBOX"] } }));
    await expect(call2("close_sprint", { sprintId: 20, moveIncompleteTo: "backlog", confirm: true })).rejects.toThrow(/AUTOKAT/);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe("bulk_update_issues", () => {
  const search = (keys: string[]) => ({
    isLast: true,
    issues: keys.map((key) => ({
      id: key,
      key,
      fields: { summary: key, status: { name: "To Do" }, labels: ["old"], customfield_10100: { value: "Blocked" } },
    })),
  });
  const changes = { fields: { automationStatus: "Automated" }, addLabels: ["new"], removeLabels: ["old"] };

  it("dryRun shows current vs new values and writes nothing", async () => {
    const calls = fakeJira({ "GET /rest/api/3/field": FIELDS, "POST /rest/api/3/search/jql": search(["AUTOKAT-1", "AUTOKAT-2"]) });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    const res = await call("bulk_update_issues", { issueKeys: ["AUTOKAT-1", "AUTOKAT-2"], changes });
    expect(res).toMatchObject({ dryRun: true, count: 2 });
    expect((res.issues as unknown[])[0]).toMatchObject({
      key: "AUTOKAT-1",
      changes: { "Automation Status": { from: "Blocked", to: "Automated" }, labels: { from: ["old"], to: ["new"] } },
    });
    expect(writes(calls)).toHaveLength(0);
  });

  it("applies with per-issue results", async () => {
    const calls = fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "POST /rest/api/3/search/jql": search(["AUTOKAT-1", "AUTOKAT-2"]),
      "PUT /rest/api/3/issue/AUTOKAT-1": undefined,
      "PUT /rest/api/3/issue/AUTOKAT-2": new Response(JSON.stringify({ errors: { labels: "nope" } }), { status: 400 }),
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    const res = await call("bulk_update_issues", { jql: "project = AUTOKAT", changes, dryRun: false });
    expect(res).toMatchObject({
      updated: 1,
      failed: 1,
      results: [{ key: "AUTOKAT-1", ok: true }, { key: "AUTOKAT-2", ok: false }],
    });
    expect(writes(calls)[0].body).toEqual({
      fields: { customfield_10100: { value: "Automated" } },
      update: { labels: [{ add: "new" }, { remove: "old" }] },
    });
  });

  it("checks ALLOWED_PROJECTS for every issue before any write", async () => {
    const calls = fakeJira({ "GET /rest/api/3/field": FIELDS, "POST /rest/api/3/search/jql": search(["AUTOKAT-1", "OTHER-2"]) });
    const { call } = await connect(testContext({ settings: SETTINGS, config: { ALLOWED_PROJECTS: ["AUTOKAT"] } }));
    await expect(call("bulk_update_issues", { jql: "labels = x", changes, dryRun: false })).rejects.toThrow(/OTHER/);
    expect(writes(calls)).toHaveLength(0);
  });

  it("rejects a JQL matching more than 50 issues", async () => {
    const keys = Array.from({ length: 51 }, (_, i) => `AUTOKAT-${i + 1}`);
    fakeJira({ "GET /rest/api/3/field": FIELDS, "POST /rest/api/3/search/jql": search(keys) });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    await expect(call("bulk_update_issues", { jql: "project = AUTOKAT", changes })).rejects.toThrow(/more than 50/);
  });
});

describe("get_time_report", () => {
  it("keeps only worklogs inside the window (account time zone) and groups them", async () => {
    const calls = fakeJira({
      "GET /rest/api/3/myself": { timeZone: "Asia/Ho_Chi_Minh" },
      "POST /rest/api/3/search/jql": {
        isLast: true,
        issues: [{ id: "1", key: "AUTOKAT-1", fields: { summary: "s", components: [{ name: "UI" }], timeoriginalestimate: 7200, timespent: 10800 } }],
      },
      "GET /rest/api/3/issue/AUTOKAT-1/worklog": {
        total: 4,
        worklogs: [
          { author: { displayName: "Ann" }, started: "2026-11-08T23:30:00.000+0700", timeSpentSeconds: 3600 },
          { author: { displayName: "Ann" }, started: "2026-11-09T00:00:00.000+0700", timeSpentSeconds: 3600 },
          { author: { displayName: "Bob" }, started: "2026-11-10T22:00:00.000+0700", timeSpentSeconds: 1800 },
          { author: { displayName: "Bob" }, started: "2026-11-11T00:00:00.000+0700", timeSpentSeconds: 3600 },
        ],
      },
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    const res = await call("get_time_report", { from: "2026-11-09", to: "2026-11-10" });
    expect(res).toMatchObject({
      totalHours: 1.5,
      timeZone: "Asia/Ho_Chi_Minh",
      groups: [
        { key: "Ann", hours: 1 },
        { key: "Bob", hours: 0.5 },
      ],
    });
    const search = calls.find((c) => c.path === "/rest/api/3/search/jql")?.body as { jql: string };
    expect(search.jql).toBe('worklogDate >= "2026-11-09" AND worklogDate <= "2026-11-10" AND project = "AUTOKAT"');
    const wl = calls.find((c) => c.path.endsWith("/worklog"));
    expect(wl?.query.get("startedBefore")).toBe(String(Date.parse("2026-11-10T17:00:00Z")));

    const byIssue = await call("get_time_report", { from: "2026-11-09", to: "2026-11-10", groupBy: "issue" });
    expect((byIssue.groups as unknown[])[0]).toMatchObject({ key: "AUTOKAT-1", hours: 1.5, originalEstimateHours: 2, timeSpentHours: 3 });
  });
});

describe("history, cycle time, epics and filters", () => {
  it("get_issue_history filters by field and returns newest first", async () => {
    fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "GET /rest/api/3/issue/AUTOKAT-1/changelog": {
        isLast: true,
        values: [
          { created: "2026-11-01T00:00:00Z", author: { displayName: "Ann" }, items: [{ field: "status", fieldId: "status", fromString: "To Do", toString: "In Progress" }] },
          { created: "2026-11-02T00:00:00Z", author: { displayName: "Bob" }, items: [{ field: "Story point estimate", fieldId: "customfield_10016", from: null, to: null, toString: "3" }] },
          { created: "2026-11-03T00:00:00Z", author: { displayName: "Ann" }, items: [{ field: "status", fieldId: "status", fromString: "In Progress", toString: "Done" }] },
        ],
      },
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    expect(await call("get_issue_history", { issueKey: "AUTOKAT-1", fields: ["storyPoints"] })).toEqual({
      issueKey: "AUTOKAT-1",
      total: 1,
      entries: [{ when: "2026-11-02T00:00:00Z", who: "Bob", field: "Story point estimate", from: null, to: "3" }],
    });
    const all = await call("get_issue_history", { issueKey: "AUTOKAT-1", maxEntries: 2 });
    expect((all as unknown as { entries: Array<{ to: string }> }).entries.map((e) => e.to)).toEqual(["Done", "3"]);
  });

  it("get_cycle_time uses the bulk changelog and config statuses", async () => {
    const hist = (id: string, start: string, end: string) => ({
      issueId: id,
      changeHistories: [
        { created: start, items: [{ fieldId: "status", field: "status", toString: "In Progress" }] },
        { created: end, items: [{ fieldId: "status", field: "status", toString: "Done" }] },
      ],
    });
    fakeJira({
      "POST /rest/api/3/search/jql": { isLast: true, issues: [1, 2, 3].map((n) => ({ id: String(n), key: `A-${n}`, fields: { summary: `s${n}` } })) },
      "POST /rest/api/3/changelog/bulkfetch": {
        issueChangeLogs: [hist("1", "2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z"), hist("2", "2026-11-01T00:00:00Z", "2026-11-07T00:00:00Z")],
      },
    });
    const { call } = await connect(testContext());
    const res = await call("get_cycle_time", { jql: "project = A", slowest: 1 });
    expect(res).toMatchObject({ issues: 3, measured: 2, days: { median: 4, p85: 6, average: 4 }, slowest: [{ key: "A-2", days: 6 }] });
  });

  it("list_epics builds JQL from filters; get_epic_progress groups children", async () => {
    const calls = fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "POST /rest/api/3/search/jql": (c: Call) => {
        const jql = (c.body as { jql: string }).jql;
        if (jql.startsWith("key in")) return { isLast: true, issues: [{ id: "1", key: "AUTOKAT-1", fields: { summary: "Epic", status: { name: "Open" } } }] };
        if (jql.startsWith("parent in"))
          return {
            isLast: true,
            issues: [
              { id: "2", key: "AUTOKAT-2", fields: { parent: { key: "AUTOKAT-1" }, status: { statusCategory: { key: "done" } }, customfield_10016: 3 } },
              { id: "3", key: "AUTOKAT-3", fields: { parent: { key: "AUTOKAT-1" }, status: { statusCategory: { key: "new" } } } },
            ],
          };
        return { isLast: true, issues: [] };
      },
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    await call("list_epics", { component: "UI", automationStatus: "Automated" });
    expect((calls.find((c) => c.path.endsWith("/search/jql"))?.body as { jql: string }).jql).toBe(
      'issuetype = Epic AND project = "AUTOKAT" AND component = "UI" AND cf[10100] = "Automated" ORDER BY Rank ASC',
    );
    const res = await call("get_epic_progress", { epicKeys: ["AUTOKAT-1", "AUTOKAT-99"] });
    expect(res.epics).toEqual([
      {
        key: "AUTOKAT-1",
        summary: "Epic",
        status: "Open",
        children: 2,
        byStatusCategory: { toDo: 1, inProgress: 0, done: 1 },
        points: { total: 3, done: 3 },
        percentDone: 100,
        percentBasis: "points",
        unestimated: 1,
      },
      { key: "AUTOKAT-99", error: "not found" },
    ]);
  });

  it("run_filter reuses search_issues", async () => {
    const calls = fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "GET /rest/api/3/filter/10": { id: "10", name: "My open", jql: "assignee = currentUser()" },
      "POST /rest/api/3/search/jql": { isLast: true, issues: [{ id: "1", key: "A-1", fields: { summary: "x" } }] },
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    const res = await call("run_filter", { filterId: "10" });
    expect(res).toMatchObject({ filter: { id: "10", name: "My open" }, issues: [{ key: "A-1" }] });
    expect((calls.find((c) => c.method === "POST")?.body as { jql: string }).jql).toBe("assignee = currentUser()");
  });
});
