import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELDS, SETTINGS, connect, fakeJira, testContext, type Call } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const LINK_TYPES = {
  issueLinkTypes: [
    { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    { id: "2", name: "Relates", inward: "relates to", outward: "relates to" },
  ],
};

describe("links", () => {
  // All three mean "A-1 blocks A-2", which Jira stores as inwardIssue A-1, outwardIssue A-2.
  it.each([
    ["blocks", "A-1", "A-2"],
    ["Blocks", "A-1", "A-2"],
    ["is blocked by", "A-2", "A-1"],
  ])('link_issues "%s" from %s to %s', async (type, fromKey, toKey) => {
    const calls = fakeJira({ "GET /rest/api/3/issueLinkType": LINK_TYPES, "POST /rest/api/3/issueLink": undefined });
    const { call } = await connect(testContext());
    const res = await call("link_issues", { type, fromKey, toKey });
    expect(res.linked).toBe(`${fromKey} ${type.toLowerCase()} ${toKey}`);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "A-1" },
      outwardIssue: { key: "A-2" },
    });
  });

  it("link_issues rejects unknown types with the available list", async () => {
    fakeJira({ "GET /rest/api/3/issueLinkType": LINK_TYPES });
    const { call } = await connect(testContext());
    await expect(call("link_issues", { type: "clones", fromKey: "A-1", toKey: "A-2" })).rejects.toThrow(
      /Available: Blocks \(blocks \/ is blocked by\)/,
    );
  });

  it("remove_issue_link checks ALLOWED_PROJECTS for both issues before deleting", async () => {
    const link = { type: { outward: "blocks" }, inwardIssue: { key: "A-1" }, outwardIssue: { key: "OTHER-2" } };
    const calls = fakeJira({ "GET /rest/api/3/issueLink/77": link, "DELETE /rest/api/3/issueLink/77": undefined });
    const { call } = await connect(testContext({ config: { ALLOWED_PROJECTS: ["A"] } }));
    await expect(call("remove_issue_link", { linkId: "77" })).rejects.toThrow(/OTHER not in ALLOWED_PROJECTS/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    const { call: call2 } = await connect(testContext());
    expect(await call2("remove_issue_link", { linkId: "77" })).toEqual({ removed: "77", was: "A-1 blocks OTHER-2" });
  });
});

describe("backlog", () => {
  it("get_backlog returns the page plus whole-backlog totals without sub-tasks", async () => {
    const page = [
      { id: "1", key: "A-1", fields: { summary: "a", issuetype: { name: "Story" }, customfield_10016: 3 } },
      { id: "2", key: "A-2", fields: { summary: "b", issuetype: { name: "Task" } } },
    ];
    const calls = fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "GET /rest/agile/1.0/board/2092/backlog": (c: Call) =>
        c.query.get("fields") === "issuetype,customfield_10016"
          ? {
              total: 3,
              issues: [...page, { id: "3", key: "A-3", fields: { issuetype: { subtask: true }, customfield_10016: 9 } }],
            }
          : { total: 3, issues: page },
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    const res = await call("get_backlog", { maxResults: 2 });
    expect(res.totals).toEqual({ items: 2, points: 3, unestimated: 1 });
    expect((res.issues as Array<Record<string, unknown>>)[0]).toMatchObject({ key: "A-1", storyPoints: 3 });
    expect(calls.filter((c) => c.path.endsWith("/backlog"))).toHaveLength(2);
  });

  it("rank_issues reports per-issue failures from a 207", async () => {
    const calls = fakeJira({
      "PUT /rest/agile/1.0/issue/rank": new Response(
        JSON.stringify({ entries: [{ issueKey: "A-1", status: 200 }, { issueKey: "A-2", status: 503, errors: ["busy"] }] }),
        { status: 207 },
      ),
    });
    const { call } = await connect(testContext());
    const res = await call("rank_issues", { issueKeys: ["A-1", "A-2"], before: "A-9" });
    expect(res).toEqual({ ranked: ["A-1"], position: { before: "A-9" }, failed: [{ key: "A-2", errors: ["busy"] }] });
    expect(calls[0].body).toEqual({ issues: ["A-1", "A-2"], rankBeforeIssue: "A-9" });
    await expect(call("rank_issues", { issueKeys: ["A-1"] })).rejects.toThrow(/exactly one/);
  });
});

describe("get_sprint_summary", () => {
  const SPRINT_FIELD = "customfield_10020";
  const raw = (key: string, id: string, extra: Record<string, unknown> = {}) => ({
    id,
    key,
    fields: {
      summary: key,
      status: { name: "To Do", statusCategory: { key: "new" } },
      issuetype: { name: "Story" },
      created: "2026-10-01T00:00:00.000Z",
      customfield_10016: 2,
      [SPRINT_FIELD]: [{ id: 20, name: "S20", state: "active", startDate: "2026-11-02T09:00:00.000Z" }],
      ...extra,
    },
  });
  const routes = (bulk: unknown) => ({
    "GET /rest/api/3/field": FIELDS,
    "GET /rest/agile/1.0/board/2092/sprint": { values: [{ id: 20, name: "S20", state: "active" }] },
    "GET /rest/agile/1.0/sprint/20": { id: 20, name: "S20", state: "active", startDate: "2026-11-02T09:00:00.000Z" },
    "GET /rest/agile/1.0/sprint/20/issue": {
      total: 2,
      issues: [
        raw("A-1", "101", {
          issuelinks: [
            {
              id: "9",
              type: { inward: "is blocked by" },
              inwardIssue: { key: "A-7", fields: { status: { statusCategory: { key: "indeterminate" } } } },
            },
          ],
        }),
        raw("A-2", "102"),
      ],
    },
    "POST /rest/api/3/search/jql": { issues: [raw("A-3", "103", { [SPRINT_FIELD]: [] })], isLast: true },
    "POST /rest/api/3/changelog/bulkfetch": bulk,
    "GET /rest/api/3/issue/A-1/changelog": { values: [], isLast: true },
    "GET /rest/api/3/issue/A-2/changelog": {
      values: [{ created: "2026-11-05T00:00:00.000Z", items: [{ fieldId: SPRINT_FIELD, from: "", to: "20" }] }],
      isLast: true,
    },
    "GET /rest/api/3/issue/A-3/changelog": {
      values: [
        { created: "2026-11-01T00:00:00.000Z", items: [{ fieldId: SPRINT_FIELD, from: "", to: "20" }] },
        { created: "2026-11-06T00:00:00.000Z", items: [{ fieldId: SPRINT_FIELD, from: "20", to: "" }] },
      ],
      isLast: true,
    },
  });

  const expectSummary = (res: Record<string, unknown>) =>
    expect(res).toMatchObject({
      totals: { committed: { items: 2, points: 4 }, scope: { items: 2, points: 4 }, blocked: 1 },
      blocked: [{ key: "A-1", reasons: ["blocked by A-7"] }],
      scopeChange: { added: { issues: [{ key: "A-2" }] }, removed: { issues: [{ key: "A-3" }] } },
    });

  it("uses the active sprint of the default board and the bulk changelog API", async () => {
    const bulk = {
      issueChangeLogs: [
        { issueId: "102", changeHistories: [{ created: "2026-11-05T00:00:00.000Z", items: [{ fieldId: SPRINT_FIELD, from: "", to: "20" }] }] },
        {
          issueId: "103",
          changeHistories: [
            { created: "2026-11-01T00:00:00.000Z", items: [{ fieldId: SPRINT_FIELD, from: "", to: "20" }] },
            { created: "2026-11-06T00:00:00.000Z", items: [{ fieldId: SPRINT_FIELD, from: "20", to: "" }] },
          ],
        },
      ],
    };
    const calls = fakeJira(routes(bulk));
    const { call } = await connect(testContext({ settings: SETTINGS }));
    expectSummary(await call("get_sprint_summary"));
    const search = calls.find((c) => c.path === "/rest/api/3/search/jql")?.body as { jql: string };
    expect(search.jql).toBe('project in ("A") AND updated >= "2026-11-01" AND (sprint is EMPTY OR sprint != 20)');
    expect(calls.some((c) => c.path.endsWith("/changelog"))).toBe(false);
  });

  it("falls back to per-issue changelogs when bulk fetch is unavailable", async () => {
    const calls = fakeJira(routes(new Response("{}", { status: 404 })));
    const { call } = await connect(testContext({ settings: SETTINGS }));
    expectSummary(await call("get_sprint_summary", { sprintId: 20 }));
    expect(calls.filter((c) => c.path.endsWith("/changelog"))).toHaveLength(3);
  });
});
