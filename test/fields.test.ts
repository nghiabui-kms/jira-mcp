import { afterEach, describe, expect, it, vi } from "vitest";
import { readValue, writeValue, type FieldInfo } from "../src/jira/fields.js";
import { FIELDS, SETTINGS, fakeJira, testContext } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const byId = (id: string) => {
  const f = FIELDS.find((x) => x.id === id);
  if (!f) throw new Error(id);
  return f;
};
const me = async () => "acc-me";

describe("FieldRegistry resolution", () => {
  it("resolves names case-insensitively, IDs, and logical keys via candidates", async () => {
    const calls = fakeJira({ "GET /rest/api/3/field": FIELDS });
    const { fields } = testContext({ settings: SETTINGS });
    expect((await fields.resolve("automation status")).id).toBe("customfield_10100");
    expect((await fields.resolve("CUSTOMFIELD_10101")).name).toBe("Work type");
    // "Story Points" is absent, so the second candidate wins
    expect((await fields.resolve("storyPoints")).id).toBe("customfield_10016");
    expect((await fields.resolve("automationStatus")).id).toBe("customfield_10100");
    expect(calls.length).toBe(1); // cached
  });

  it("errors on ambiguous names, listing the candidates", async () => {
    fakeJira({ "GET /rest/api/3/field": FIELDS });
    const { fields } = testContext();
    await expect(fields.resolve("Dup")).rejects.toThrow(/customfield_10200.*customfield_10201/);
  });

  it("errors on unknown fields and reports tried candidates", async () => {
    fakeJira({ "GET /rest/api/3/field": FIELDS });
    const { fields } = testContext({ settings: { fields: { foo: ["Nope", "Nada"] } } });
    await expect(fields.resolve("foo")).rejects.toThrow(/tried Nope, Nada/);
    await expect(fields.resolve("constructor")).rejects.toThrow(/Unknown field "constructor"/);
  });

  it("outputFields skips missing configured fields and warns on requested ones", async () => {
    fakeJira({ "GET /rest/api/3/field": FIELDS });
    const { fields } = testContext({ settings: { ...SETTINGS, listFields: ["storyPoints", "missingKey"] } });
    const out = await fields.outputFields(["Due date", "Nope", "Dup"]);
    expect(out.fields.map((f) => f.key)).toEqual(["storyPoints", "flagged", "Due date"]);
    expect(out.warnings).toHaveLength(2);
    expect(out.warnings[0]).toMatch(/Unknown field "Nope"/);
    expect(out.warnings[1]).toMatch(/several fields/);
  });

  it("toJiraFields converts keys to IDs and values by schema", async () => {
    fakeJira({ "GET /rest/api/3/field": FIELDS, "GET /rest/api/3/myself": { accountId: "acc-me" } });
    const { fields } = testContext({ settings: SETTINGS });
    expect(
      await fields.toJiraFields({ storyPoints: 3, "Automation Status": "Automated", Reviewers: ["me", "acc-2"] }),
    ).toEqual({
      customfield_10016: 3,
      customfield_10100: { value: "Automated" },
      customfield_10102: [{ accountId: "acc-me" }, { accountId: "acc-2" }],
    });
  });
});

describe("writeValue", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["customfield_10016", 5, 5],
    ["customfield_10016", "2.5", 2.5],
    ["customfield_10105", "https://x", "https://x"],
    ["customfield_10100", "Blocked", { value: "Blocked" }],
    ["customfield_10103", ["Web", "API"], [{ value: "Web" }, { value: "API" }]],
    ["labels", ["a", "b"], ["a", "b"]],
    ["assignee", "acc-1", { accountId: "acc-1" }],
    ["assignee", "me", { accountId: "acc-me" }],
    ["components", ["UI"], [{ name: "UI" }]],
    ["fixVersions", "1.0", [{ name: "1.0" }]],
    ["priority", "P2", { name: "P2" }],
    ["customfield_10020", 42, 42],
    ["customfield_10020", "42", 42],
    ["customfield_10001", "1d2e3f4a-0000-4000-8000-123456789abc", "1d2e3f4a-0000-4000-8000-123456789abc"],
    ["customfield_10021", true, [{ value: "Impediment" }]],
    ["customfield_10021", false, null],
    ["customfield_10106", { anything: 1 }, { anything: 1 }],
    ["customfield_10100", null, null],
    ["customfield_10100", { id: "10001" }, { id: "10001" }],
  ];
  it.each(cases)("%s <- %j", async (id, input, expected) => {
    expect(await writeValue(byId(id), input, me)).toEqual(expected);
  });

  it("writes rich text fields as ADF", async () => {
    const adf = (await writeValue(byId("customfield_10104"), "**hi**", me)) as { type: string };
    expect(adf.type).toBe("doc");
  });

  it("rejects team names and non-numeric sprints", async () => {
    await expect(writeValue(byId("customfield_10001"), "Katalon PSA (Titan)", me)).rejects.toThrow(/team id/);
    await expect(writeValue(byId("customfield_10020"), "Sprint 5", me)).rejects.toThrow(/sprint id/);
  });

  it("passes values through when the schema is unknown", async () => {
    const noSchema: FieldInfo = { id: "x", name: "x", custom: true };
    expect(await writeValue(noSchema, "raw", me)).toBe("raw");
  });
});

describe("readValue", () => {
  it("maps Jira values to compact output", () => {
    expect(readValue(byId("customfield_10100"), { value: "Automated", id: "1" })).toBe("Automated");
    expect(readValue(byId("assignee"), { displayName: "Ann", accountId: "a" })).toBe("Ann");
    expect(readValue(byId("components"), [{ name: "UI", id: "1" }, { name: "API" }])).toEqual(["UI", "API"]);
    expect(
      readValue(byId("customfield_10020"), [{ id: 7, name: "S7", state: "closed", boardId: 1, goal: "" }]),
    ).toEqual([{ id: 7, name: "S7", state: "closed" }]);
    expect(readValue(byId("customfield_10001"), { id: "t1", name: "Titan" })).toBe("Titan");
    expect(
      readValue(byId("customfield_10104"), { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }),
    ).toBe("hi");
    expect(readValue(byId("customfield_10016"), 3)).toBe(3);
    expect(readValue(byId("labels"), [])).toBeUndefined();
    expect(readValue(byId("labels"), null)).toBeUndefined();
  });
});
