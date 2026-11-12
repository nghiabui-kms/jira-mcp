import { describe, expect, it } from "vitest";
import { merge, resolveTemplate, type Templates } from "../src/templates.js";

const all: Templates = {
  base: { project: "AUTOKAT", assignee: "me", labels: ["autokat"], fields: { workType: "Maintenance", storyPoints: 1 } },
  mid: { extends: "base", issueType: "Task", labels: ["mid"], components: ["UI"], description: "## Base" },
  leaf: { extends: "mid", labels: ["leaf"], fields: { storyPoints: 2 }, description: "## Leaf" },
  loopA: { extends: "loopB" },
  loopB: { extends: "loopA" },
  self: { extends: "self" },
  orphan: { extends: "missing" },
};

describe("templates", () => {
  it("walks the extends chain: child overrides, labels union, fields merge", () => {
    expect(resolveTemplate(all, "leaf")).toEqual({
      project: "AUTOKAT",
      assignee: "me",
      issueType: "Task",
      labels: ["autokat", "mid", "leaf"],
      components: ["UI"],
      fields: { workType: "Maintenance", storyPoints: 2 },
      description: "## Leaf",
    });
  });

  it("detects cycles", () => {
    expect(() => resolveTemplate(all, "loopA")).toThrow("Template cycle: loopA -> loopB -> loopA");
    expect(() => resolveTemplate(all, "self")).toThrow("Template cycle: self -> self");
  });

  it("reports unknown templates and unknown parents", () => {
    expect(() => resolveTemplate(all, "nope")).toThrow(/Unknown template "nope"/);
    expect(() => resolveTemplate(all, "orphan")).toThrow(/extends unknown template "missing"/);
    expect(() => resolveTemplate(all, "toString")).toThrow(/Unknown template/);
  });

  it("explicit arguments override the template; undefined arguments do not", () => {
    const tpl = resolveTemplate(all, "leaf");
    const out = merge(tpl, {
      project: undefined,
      issueType: "Story",
      labels: ["extra", "autokat"],
      components: ["API"],
      description: undefined,
      fields: { "Automation Status": "Automated" },
    });
    expect(out.project).toBe("AUTOKAT");
    expect(out.issueType).toBe("Story");
    expect(out.labels).toEqual(["autokat", "mid", "leaf", "extra"]);
    expect(out.components).toEqual(["UI", "API"]);
    expect(out.description).toBe("## Leaf");
    expect(out.fields).toEqual({ workType: "Maintenance", storyPoints: 2, "Automation Status": "Automated" });
    expect(merge(tpl, { description: "mine" }).description).toBe("mine");
  });
});
