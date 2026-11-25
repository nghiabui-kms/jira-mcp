import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELDS, SETTINGS, connect, fakeJira, jiraError, testContext } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());
vi.mock("../src/util/clipboard.js", () => ({ readClipboardPng: vi.fn(async () => new Blob(["png"], { type: "image/png" })) }));

const READ_TOOLS = [
  "get_myself",
  "find_users",
  "list_projects",
  "search_issues",
  "get_issue",
  "get_transitions",
  "list_boards",
  "list_sprints",
  "get_sprint_issues",
  "get_worklogs",
  "list_fields",
  "get_create_meta",
  "list_project_components",
  "list_project_versions",
  "list_templates",
  "get_backlog",
  "list_link_types",
  "get_sprint_summary",
  "get_velocity",
  "get_issue_history",
  "get_cycle_time",
  "get_time_report",
  "list_epics",
  "get_epic_progress",
  "list_filters",
  "run_filter",
];
const WRITE_TOOLS = [
  "create_issue",
  "update_issue",
  "add_comment",
  "transition_issue",
  "move_issues_to_sprint",
  "add_worklog",
  "delete_worklog",
  "rank_issues",
  "move_issues_to_backlog",
  "link_issues",
  "remove_issue_link",
  "create_sprint",
  "update_sprint",
  "start_sprint",
  "close_sprint",
  "bulk_update_issues",
];

describe("tool registration", () => {
  it("tools/list returns every tool", async () => {
    const { client } = await connect(testContext());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(names).toHaveLength(42);
  });

  it("READ_ONLY=true hides every write tool", async () => {
    const { client } = await connect(testContext({ config: { READ_ONLY: true } }));
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("marks destructive tools", async () => {
    const { client } = await connect(testContext());
    const destructive = (await client.listTools()).tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive.sort()).toEqual(["close_sprint", "delete_worklog", "remove_issue_link"]);
  });
});

const ISSUE = {
  id: "1",
  key: "AUTOKAT-1",
  fields: {
    summary: "S",
    status: { name: "In Progress" },
    issuetype: { name: "Story" },
    customfield_10016: 3,
    customfield_10020: [{ id: 9, name: "Sprint 9", state: "active", boardId: 2092 }],
    customfield_10021: [{ value: "Impediment" }],
    customfield_10100: { value: "Automated" },
    components: [{ name: "UI" }],
    duedate: "2026-12-01",
  },
};

describe("issue output", () => {
  it("search_issues adds configured list fields, flagged and requested fields", async () => {
    const calls = fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "POST /rest/api/3/search/jql": { issues: [ISSUE], isLast: true },
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    const res = await call("search_issues", { jql: "project = AUTOKAT", fields: ["Due date"] });
    expect((res.issues as unknown[])[0]).toMatchObject({
      key: "AUTOKAT-1",
      storyPoints: 3,
      sprint: [{ id: 9, name: "Sprint 9", state: "active" }],
      components: ["UI"],
      automationStatus: "Automated",
      flagged: true,
      "Due date": "2026-12-01",
    });
    const body = calls.find((c) => c.path === "/rest/api/3/search/jql")?.body as { fields: string[] };
    expect(body.fields).toEqual(expect.arrayContaining(["customfield_10016", "customfield_10020", "customfield_10021", "duedate"]));
  });

  it("get_issue returns estimates, fix versions and link ids", async () => {
    fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "GET /rest/api/3/issue/AUTOKAT-1": {
        ...ISSUE,
        fields: {
          ...ISSUE.fields,
          timetracking: { originalEstimate: "1d", timeSpent: "2h", remainingEstimate: "6h" },
          fixVersions: [{ name: "R1" }],
          issuelinks: [{ id: "500", type: { inward: "is blocked by" }, inwardIssue: { key: "AUTOKAT-2" } }],
        },
      },
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    const res = await call("get_issue", { issueKey: "AUTOKAT-1" });
    expect(res).toMatchObject({
      originalEstimate: "1d",
      timeSpent: "2h",
      remainingEstimate: "6h",
      fixVersions: ["R1"],
      links: [{ id: "500", type: "is blocked by", key: "AUTOKAT-2" }],
    });
  });
});

describe("create_issue / update_issue", () => {
  const templates = {
    base: { project: "AUTOKAT", labels: ["autokat"], fields: { workType: "Maintenance" } },
    maint: { extends: "base", issueType: "Task", components: ["UI"], description: "## Fix\n- ", fields: { storyPoints: 1 } },
  };

  it("applies a template with explicit overrides and converted fields", async () => {
    const calls = fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "POST /rest/api/3/issue": { key: "AUTOKAT-9" },
    });
    const { call } = await connect(testContext({ settings: SETTINGS, templates }));
    const res = await call("create_issue", {
      template: "maint",
      summary: "Fix login script",
      labels: ["login"],
      fields: { "Story point estimate": 2 },
    });
    expect(res.created).toBe("AUTOKAT-9");
    const { fields } = calls.find((c) => c.method === "POST")?.body as { fields: Record<string, unknown> };
    expect(fields).toMatchObject({
      project: { key: "AUTOKAT" },
      issuetype: { name: "Task" },
      labels: ["autokat", "login"],
      components: [{ name: "UI" }],
      customfield_10101: { value: "Maintenance" },
      customfield_10016: 2,
      description: { type: "doc" },
    });
  });

  it("enriches a 400 with the missing required fields", async () => {
    fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "POST /rest/api/3/issue": jiraError(400, { customfield_10100: "Automation Status is required." }),
      "GET /rest/api/3/issue/createmeta/AUTOKAT/issuetypes": { issueTypes: [{ id: "10", name: "Story" }] },
      "GET /rest/api/3/issue/createmeta/AUTOKAT/issuetypes/10": {
        fields: [
          { fieldId: "summary", name: "Summary", required: true },
          {
            fieldId: "customfield_10100",
            name: "Automation Status",
            required: true,
            allowedValues: [{ value: "Automated" }, { value: "Blocked" }],
          },
        ],
      },
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    await expect(call("create_issue", { summary: "x", issueType: "Story" })).rejects.toThrow(
      /Automation Status \(customfield_10100\) allowed: Automated, Blocked/,
    );
  });

  it("blocks writes outside ALLOWED_PROJECTS before calling Jira", async () => {
    const calls = fakeJira({});
    const { call } = await connect(testContext({ settings: SETTINGS, config: { ALLOWED_PROJECTS: ["SANDBOX"] } }));
    await expect(call("create_issue", { summary: "x" })).rejects.toThrow(/AUTOKAT not in ALLOWED_PROJECTS/);
    expect(calls).toHaveLength(0);
  });

  it("update_issue sends label ops, estimates, components and named fields", async () => {
    const calls = fakeJira({
      "GET /rest/api/3/field": FIELDS,
      "PUT /rest/api/3/issue/AUTOKAT-1": undefined,
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    await call("update_issue", {
      issueKey: "AUTOKAT-1",
      addLabels: ["a"],
      removeLabels: ["b"],
      originalEstimate: "1d",
      components: ["API"],
      fields: { automationStatus: "Blocked" },
    });
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      fields: { customfield_10100: { value: "Blocked" }, components: [{ name: "API" }] },
      update: { labels: [{ add: "a" }, { remove: "b" }], timetracking: [{ edit: { originalEstimate: "1d" } }] },
    });
    await expect(call("update_issue", { issueKey: "AUTOKAT-1", labels: ["x"], addLabels: ["y"] })).rejects.toThrow(
      /either labels/,
    );
  });
});

describe("metadata tools", () => {
  it("list_project_versions puts unreleased first and hides archived", async () => {
    fakeJira({
      "GET /rest/api/3/project/AUTOKAT/versions": [
        { id: "1", name: "R1", released: true, releaseDate: "2026-01-01" },
        { id: "2", name: "R3", released: false, releaseDate: "2026-12-01" },
        { id: "3", name: "R2", released: true, releaseDate: "2026-06-01" },
        { id: "4", name: "Old", released: true, archived: true },
        { id: "5", name: "R4", released: false },
      ],
    });
    const { call } = await connect(testContext({ settings: SETTINGS }));
    const res = await call("list_project_versions");
    expect((res.versions as Array<{ name: string }>).map((v) => v.name)).toEqual(["R3", "R4", "R2", "R1"]);
  });

  it("list_templates returns resolved templates and per-template errors", async () => {
    const { call } = await connect(
      testContext({ templates: { a: { labels: ["x"], description: "## S" }, b: { extends: "a", labels: ["y"] }, c: { extends: "c" } } }),
    );
    expect(await call("list_templates")).toEqual([
      { name: "a", labels: ["x"], description: "## S" },
      { name: "b", labels: ["x", "y"], description: "## S" },
      { name: "c", error: "Template cycle: c -> c" },
    ]);
  });
});

describe("add_comment attachments", () => {
  const media = (uuid: string) =>
    new Response(null, { status: 303, headers: { location: `https://api.media.atlassian.com/file/${uuid}/binary?token=x` } });
  const U1 = "11111111-1111-1111-1111-111111111111";
  const U2 = "22222222-2222-2222-2222-222222222222";

  async function setup() {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "att-"));
    const outside = await mkdtemp(join(tmpdir(), "out-"));
    await writeFile(join(dir, "shot.png"), "png");
    await writeFile(join(dir, "run.log"), "log");
    await writeFile(join(outside, "secret.env"), "x");
    return { dir, file: (n: string) => join(dir, n), outsideFile: join(outside, "secret.env") };
  }

  it("uploads files, shows images inline and other files as a file card", async () => {
    const { dir, file } = await setup();
    const calls = fakeJira({
      "POST /rest/api/3/issue/AUTOKAT-1/attachments": [
        { id: "10", filename: "shot.png", mimeType: "image/png" },
        { id: "11", filename: "run.log", mimeType: "text/plain" },
      ],
      "GET /rest/api/3/attachment/content/10": media(U1),
      "GET /rest/api/3/attachment/content/11": media(U2),
      "POST /rest/api/3/issue/AUTOKAT-1/comment": { id: "500" },
    });
    const { call } = await connect(testContext({ config: { ATTACHMENTS_DIR: dir } }));
    const res = await call("add_comment", { issueKey: "AUTOKAT-1", body: "See **this**", attachments: [file("shot.png"), file("run.log")] });

    expect(res).toEqual({ issueKey: "AUTOKAT-1", commentId: "500", attachments: [{ id: "10", filename: "shot.png" }, { id: "11", filename: "run.log" }] });
    const upload = calls[0];
    expect(upload.headers["X-Atlassian-Token"]).toBe("no-check");
    expect((upload.body as FormData).getAll("file").map((f) => (f as File).name)).toEqual(["shot.png", "run.log"]);
    const doc = (calls.at(-1)!.body as { body: { content: unknown[] } }).body;
    expect(doc.content.slice(1)).toEqual([
      { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { type: "file", id: U1, collection: "", alt: "shot.png" } }] },
      { type: "mediaGroup", content: [{ type: "media", attrs: { type: "file", id: U2, collection: "", alt: "run.log" } }] },
    ]);
  });

  it("rejects files outside ATTACHMENTS_DIR and when it is unset, before calling Jira", async () => {
    const { dir, file, outsideFile } = await setup();
    const calls = fakeJira({});
    const { call } = await connect(testContext({ config: { ATTACHMENTS_DIR: dir } }));
    await expect(call("add_comment", { issueKey: "AUTOKAT-1", body: "x", attachments: [outsideFile] })).rejects.toThrow(/outside ATTACHMENTS_DIR/);
    await expect(call("add_comment", { issueKey: "AUTOKAT-1", body: "x", attachments: [file("../" + "x")] })).rejects.toThrow(/not found|outside/);
    const off = await connect(testContext());
    await expect(off.call("add_comment", { issueKey: "AUTOKAT-1", body: "x", attachments: [file("shot.png")] })).rejects.toThrow(/disabled/);
    expect(calls).toHaveLength(0);
  });

  it("attaches the clipboard image without needing body or ATTACHMENTS_DIR", async () => {
    const calls = fakeJira({
      "POST /rest/api/3/issue/AUTOKAT-1/attachments": [{ id: "10", filename: "clipboard.png", mimeType: "image/png" }],
      "GET /rest/api/3/attachment/content/10": media(U1),
      "POST /rest/api/3/issue/AUTOKAT-1/comment": { id: "500" },
    });
    const { call } = await connect(testContext());
    await call("add_comment", { issueKey: "AUTOKAT-1", clipboardImage: true });
    const file = (calls[0].body as FormData).get("file") as File;
    expect(file.name).toMatch(/^clipboard-\d{14}\.png$/);
    expect(file.type).toBe("image/png");
    const doc = (calls.at(-1)!.body as { body: { content: Array<{ type: string }> } }).body;
    expect(doc.content.map((n) => n.type)).toEqual(["mediaSingle"]);
  });

  it("rejects an empty comment", async () => {
    fakeJira({});
    const { call } = await connect(testContext());
    await expect(call("add_comment", { issueKey: "AUTOKAT-1", body: "  " })).rejects.toThrow(/Nothing to post/);
  });

  it("falls back to a link when the media id cannot be resolved", async () => {
    const { dir, file } = await setup();
    const calls = fakeJira({
      "POST /rest/api/3/issue/AUTOKAT-1/attachments": [{ id: "10", filename: "shot.png", mimeType: "image/png" }],
      "GET /rest/api/3/attachment/content/10": () => new Response("bytes"),
      "POST /rest/api/3/issue/AUTOKAT-1/comment": { id: "500" },
    });
    const { call } = await connect(testContext({ config: { ATTACHMENTS_DIR: dir } }));
    await call("add_comment", { issueKey: "AUTOKAT-1", body: "x", attachments: [file("shot.png")] });
    const doc = (calls.at(-1)!.body as { body: { content: unknown[] } }).body;
    expect(doc.content[1]).toMatchObject({ type: "paragraph", content: [{ text: "shot.png", marks: [{ type: "link" }] }] });
  });
});
