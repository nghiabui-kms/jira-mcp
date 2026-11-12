/**
 * Conversion between light Markdown and Atlassian Document Format (REST API v3 rich text).
 *
 * Supported both ways: paragraphs and line breaks, # headings (1-6), - / * / 1. lists with one
 * nested level (indent 2 spaces), ``` code blocks, | a | b | tables (header row when followed by
 * | --- |), **bold**, *italic* / _italic_, `code`, [text](url), bare URLs, and mentions written as
 * @[accountId] or @[accountId|Display Name].
 */
export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

// ---------- Markdown -> ADF ----------

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
const INLINE = new RegExp(
  [
    "`([^`]+)`", // 1 code
    "\\*\\*(.+?)\\*\\*", // 2 bold
    "\\[([^\\]]+)\\]\\(([^)\\s]+)\\)", // 3,4 link
    "@\\[([^\\]|]+)(?:\\|([^\\]]*))?\\]", // 5,6 mention
    "(https?:\\/\\/[^\\s<>()]*[^\\s<>().,;:!?'\"])", // 7 bare URL
    "\\*([^*\\s](?:[^*]*?[^*\\s])?)\\*", // 8 italic *
    "(?<!\\w)_([^_\\s](?:[^_]*?[^_\\s])?)_(?!\\w)", // 9 italic _
  ].join("|"),
  "g",
);

export function textToAdf(input: string): AdfNode {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence
      const text = code.join("\n");
      content.push({
        type: "codeBlock",
        ...(language ? { attrs: { language } } : {}),
        content: text ? [{ type: "text", text }] : [],
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      content.push({ type: "heading", attrs: { level: heading[1].length }, content: inline(heading[2].trim()) });
      i++;
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(lines[i++]);
      content.push(table(rows));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const [node, next] = list(lines, i, 0);
      content.push(node);
      i = next;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    content.push(paragraph(para));
  }

  return { type: "doc", version: 1, content };
}

const isBlockStart = (l: string) => FENCE.test(l) || HEADING.test(l) || TABLE_ROW.test(l) || LIST_ITEM.test(l);

function paragraph(lines: string[]): AdfNode {
  const content: AdfNode[] = [];
  lines.forEach((text, idx) => {
    if (idx > 0) content.push({ type: "hardBreak" });
    content.push(...inline(text));
  });
  return { type: "paragraph", content };
}

/** Parses a list starting at line i; depth 0 may contain one nested level. Returns [node, next line]. */
function list(lines: string[], i: number, depth: number): [AdfNode, number] {
  const first = LIST_ITEM.exec(lines[i]);
  const base = first ? first[1].length : 0;
  const ordered = /\d/.test(first?.[2] ?? "");
  const items: AdfNode[] = [];

  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m) break;
    const indent = m[1].length;
    if (indent < base) break; // back to the parent list
    const last = items[items.length - 1];
    if (indent >= base + 2 && depth === 0 && last) {
      const [sub, next] = list(lines, i, 1);
      last.content?.push(sub);
      i = next;
      continue;
    }
    if (indent < base + 2 && /\d/.test(m[2]) !== ordered) break; // list type changed: new list
    items.push({ type: "listItem", content: [{ type: "paragraph", content: inline(m[3]) }] });
    i++;
  }
  return [{ type: ordered ? "orderedList" : "bulletList", content: items }, i];
}

function table(rows: string[]): AdfNode {
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const hasHeader = rows.length > 1 && TABLE_SEP.test(rows[1]);
  const body = hasHeader ? [rows[0], ...rows.slice(2)] : rows;
  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: body.map((row, r) => ({
      type: "tableRow",
      content: cells(row).map((c) => ({
        type: r === 0 && hasHeader ? "tableHeader" : "tableCell",
        content: [{ type: "paragraph", content: inline(c) }],
      })),
    })),
  };
}

function inline(text: string, marks: AdfMark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  const push = (t: string, m: AdfMark[]) => {
    if (t) out.push(m.length ? { type: "text", text: t, marks: m } : { type: "text", text: t }); // no empty text nodes
  };
  const link = (href: string): AdfMark => ({ type: "link", attrs: { href } });
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    push(text.slice(last, at), marks);
    last = at + m[0].length;
    if (m[1] !== undefined) {
      // ADF only allows the code mark together with link
      push(m[1], [...marks.filter((k) => k.type === "link"), { type: "code" }]);
    } else if (m[2] !== undefined) out.push(...inline(m[2], [...marks, { type: "strong" }]));
    else if (m[3] !== undefined) out.push(...inline(m[3], [...marks, link(m[4])]));
    else if (m[5] !== undefined) {
      out.push({ type: "mention", attrs: { id: m[5].trim(), ...(m[6] ? { text: "@" + m[6].trim() } : {}) } });
    } else if (m[7] !== undefined) push(m[7], [...marks, link(m[7])]);
    else out.push(...inline(m[8] ?? m[9], [...marks, { type: "em" }]));
  }
  push(text.slice(last), marks);
  return out;
}

// ---------- ADF -> Markdown ----------

export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return typeof node === "string" ? node : "";
  return block(node as AdfNode);
}

const isList = (n: AdfNode) => n.type === "bulletList" || n.type === "orderedList";

function blocks(nodes: AdfNode[] | undefined, sep = "\n\n"): string {
  return (nodes ?? [])
    .map(block)
    .filter((s) => s !== "")
    .join(sep);
}

function block(n: AdfNode): string {
  switch (n.type) {
    case "paragraph":
      return inlines(n.content);
    case "heading":
      return "#".repeat(Number(n.attrs?.level ?? 1)) + " " + inlines(n.content);
    case "codeBlock":
      return "```" + String(n.attrs?.language ?? "") + "\n" + (n.content ?? []).map((c) => c.text ?? "").join("") + "\n```";
    case "bulletList":
    case "orderedList":
      return listBlock(n, "");
    case "table":
      return tableBlock(n);
    case "blockquote":
      return blocks(n.content)
        .split("\n")
        .map((l) => "> " + l)
        .join("\n");
    case "rule":
      return "---";
    case "mediaSingle":
    case "mediaGroup":
      return "[attachment]";
    case "text":
    case "hardBreak":
    case "mention":
    case "emoji":
    case "inlineCard":
    case "status":
    case "date":
      return inlineNode(n);
    default:
      return blocks(n.content); // doc, panel, expand, layouts, ...
  }
}

function listBlock(n: AdfNode, indent: string): string {
  let num = Number(n.attrs?.order ?? 1);
  return (n.content ?? [])
    .map((item) => {
      const marker = n.type === "orderedList" ? `${num++}. ` : "- ";
      let head: string | undefined;
      const rest: string[] = [];
      for (const c of item.content ?? []) {
        if (isList(c)) rest.push(listBlock(c, indent + "  "));
        else if (head === undefined) head = block(c);
        else rest.push(indent + "  " + block(c));
      }
      return [indent + marker + (head ?? ""), ...rest].join("\n");
    })
    .join("\n");
}

function tableBlock(n: AdfNode): string {
  const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => blocks(c.content, " ").replace(/\n/g, " ")));
  const line = (cells: string[]) => "| " + cells.join(" | ") + " |";
  const out = rows.map(line);
  const header = n.content?.[0]?.content?.every((c) => c.type === "tableHeader");
  if (header && rows.length) out.splice(1, 0, line(rows[0].map(() => "---")));
  return out.join("\n");
}

function inlines(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(inlineNode).join("");
}

function inlineNode(n: AdfNode): string {
  const a = n.attrs ?? {};
  switch (n.type) {
    case "text":
      return marked(n.text ?? "", n.marks ?? []);
    case "hardBreak":
      return "\n";
    case "mention": {
      const name = String(a.text ?? "").replace(/^@/, "");
      return name ? `@[${String(a.id)}|${name}]` : `@[${String(a.id)}]`;
    }
    case "emoji":
      return String(a.shortName ?? "");
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return String(a.url ?? "");
    case "status":
      return `[${String(a.text ?? "")}]`;
    case "date":
      return new Date(Number(a.timestamp)).toISOString().slice(0, 10);
    default:
      return inlines(n.content);
  }
}

function marked(text: string, marks: AdfMark[]): string {
  const has = (type: string) => marks.find((m) => m.type === type);
  let t = text;
  if (has("code")) t = "`" + t + "`";
  if (has("em")) t = has("strong") ? `_${t}_` : `*${t}*`; // avoid ***x***, which does not parse back
  if (has("strong")) t = `**${t}**`;
  if (has("strike")) t = `~~${t}~~`;
  const link = has("link");
  if (link) {
    const href = String(link.attrs?.href ?? "");
    if (href !== text || marks.length > 1) t = `[${t}](${href})`; // a bare URL stays bare
  }
  return t;
}

/** Trim ADF-derived text so a single issue cannot flood the model's context. */
export function adfToShortText(node: unknown, max = 4000): string | null {
  if (!node) return null;
  const text = adfToText(node).replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? text.slice(0, max) + `\n…[truncated, ${text.length - max} more chars]` : text;
}
