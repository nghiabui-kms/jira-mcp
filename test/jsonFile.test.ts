import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { settingsSchema } from "../src/settings.js";
import { watchedJson } from "../src/util/jsonFile.js";

describe("watchedJson", () => {
  it("uses the fallback when missing, reloads on mtime change, keeps last valid on bad edits", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const path = join(mkdtempSync(join(tmpdir(), "jira-mcp-")), "c.json");
    const read = watchedJson(path, settingsSchema, settingsSchema.parse({}));
    expect(read().defaultBoardId).toBeUndefined();

    const write = (text: string, mtime: number) => {
      writeFileSync(path, text);
      utimesSync(path, mtime, mtime);
    };
    write(JSON.stringify({ defaultBoardId: 2092, fields: { team: ["customfield_10001"] } }), 1000);
    expect(read().defaultBoardId).toBe(2092);
    expect(read().fields.team).toEqual(["customfield_10001"]);
    expect(read().fields.storyPoints).toEqual(["Story Points", "Story point estimate"]); // defaults kept

    write(JSON.stringify({ defaultBoardId: "x" }), 2000);
    expect(read().defaultBoardId).toBe(2092);

    write("{ broken", 3000);
    expect(read().defaultBoardId).toBe(2092);

    write(JSON.stringify({ defaultBoardId: 7 }), 4000);
    expect(read().defaultBoardId).toBe(7);
  });

  it("throws when the file is invalid and there is no previous valid version", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const path = join(mkdtempSync(join(tmpdir(), "jira-mcp-")), "c.json");
    writeFileSync(path, JSON.stringify({ unknownKey: 1 }));
    expect(() => watchedJson(path, settingsSchema, settingsSchema.parse({}))()).toThrow(/unknownKey/);
  });
});
