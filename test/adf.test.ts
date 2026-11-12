import { describe, expect, it } from "vitest";
import { adfToText, textToAdf, type AdfNode } from "../src/jira/adf.js";

const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", version: 1, content });
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const t = (text: string, ...marks: string[]): AdfNode =>
  marks.length ? { type: "text", text, marks: marks.map((type) => ({ type })) } : { type: "text", text };

describe("textToAdf", () => {
  it("parses headings and inline marks", () => {
    expect(textToAdf("## Title **b** *i* _j_ `c`")).toEqual(
      doc({
        type: "heading",
        attrs: { level: 2 },
        content: [t("Title "), t("b", "strong"), t(" "), t("i", "em"), t(" "), t("j", "em"), t(" "), t("c", "code")],
      }),
    );
  });

  it("parses links, bare URLs and mentions; leaves snake_case alone", () => {
    const out = textToAdf("see [docs](https://a.io/x) or https://b.io/y. ping @[abc-123] @[def|Ann B] my_var_name");
    expect(out.content?.[0].content).toEqual([
      t("see "),
      { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://a.io/x" } }] },
      t(" or "),
      { type: "text", text: "https://b.io/y", marks: [{ type: "link", attrs: { href: "https://b.io/y" } }] },
      t(". ping "),
      { type: "mention", attrs: { id: "abc-123" } },
      t(" "),
      { type: "mention", attrs: { id: "def", text: "@Ann B" } },
      t(" my_var_name"),
    ]);
  });

  it("keeps code mark valid inside bold (code only combines with link)", () => {
    expect(textToAdf("**a `x`**").content?.[0].content).toEqual([t("a ", "strong"), t("x", "code")]);
  });

  it("parses nested lists one level deep", () => {
    expect(textToAdf("- a\n  1. a1\n  2. a2\n- b")).toEqual(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              p(t("a")),
              {
                type: "orderedList",
                content: [
                  { type: "listItem", content: [p(t("a1"))] },
                  { type: "listItem", content: [p(t("a2"))] },
                ],
              },
            ],
          },
          { type: "listItem", content: [p(t("b"))] },
        ],
      }),
    );
  });

  it("parses tables with a header row", () => {
    const out = textToAdf("| H1 | H2 |\n| --- | --- |\n| a | **b** |");
    const table = out.content?.[0];
    expect(table?.type).toBe("table");
    expect(table?.content?.map((r) => r.content?.map((c) => c.type))).toEqual([
      ["tableHeader", "tableHeader"],
      ["tableCell", "tableCell"],
    ]);
    expect(table?.content?.[1].content?.[1].content).toEqual([p(t("b", "strong"))]);
  });

  it("parses code blocks, paragraphs with hard breaks, and never emits empty text", () => {
    expect(textToAdf("line1\nline2\n\n```js\nx()\n```")).toEqual(
      doc(p(t("line1"), { type: "hardBreak" }, t("line2")), {
        type: "codeBlock",
        attrs: { language: "js" },
        content: [t("x()")],
      }),
    );
    expect(JSON.stringify(textToAdf("- \n\n|  |"))).not.toContain('"text":""');
  });
});

describe("adfToText", () => {
  it("renders marks, mentions, links and other nodes as Markdown", () => {
    const node = doc(
      { type: "heading", attrs: { level: 3 }, content: [t("H")] },
      p(
        t("b", "strong"),
        t(" "),
        t("bi", "strong", "em"),
        t(" "),
        { type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://x.io" } }] },
        t(" "),
        { type: "mention", attrs: { id: "a1", text: "@Ann" } },
        { type: "hardBreak" },
        { type: "inlineCard", attrs: { url: "https://card" } },
      ),
      { type: "rule" },
    );
    expect(adfToText(node)).toBe("### H\n\n**b** **_bi_** [x](https://x.io) @[a1|Ann]\nhttps://card\n\n---");
  });

  it("renders ordered lists from attrs.order", () => {
    const list: AdfNode = {
      type: "orderedList",
      attrs: { order: 3 },
      content: [{ type: "listItem", content: [p(t("c"))] }, { type: "listItem", content: [p(t("d"))] }],
    };
    expect(adfToText(doc(list))).toBe("3. c\n4. d");
  });

  it("handles strings and empty input", () => {
    expect(adfToText("plain")).toBe("plain");
    expect(adfToText(null)).toBe("");
  });
});

describe("round trip", () => {
  const md = [
    "# Title",
    "Some **bold**, *italic*, `code`, [link](https://a.b/c) and https://x.y/z with @[abc123|Nghia].",
    "- one\n  - nested **x**\n  - nested 2\n- two",
    "1. first\n2. second",
    "| a | b |\n| --- | --- |\n| 1 | **2** |",
    "| no | header |",
    "```js\nconst x = 1;\n```",
    "line one\nline two",
  ].join("\n\n");

  it("Markdown -> ADF -> Markdown is stable", () => {
    expect(adfToText(textToAdf(md))).toBe(md);
  });

  it("ADF -> Markdown -> ADF is stable", () => {
    const adf = textToAdf(md);
    expect(textToAdf(adfToText(adf))).toEqual(adf);
  });
});
