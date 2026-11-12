import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textToAdf } from "../jira/adf.js";
import type { JiraClient } from "../jira/client.js";
import { assertWritable, defineTool, issueKeySchema as issueKey, type ToolContext } from "./context.js";

interface LinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

async function linkTypes(jira: JiraClient): Promise<LinkType[]> {
  return (await jira.get<{ issueLinkTypes: LinkType[] }>("/rest/api/3/issueLinkType")).issueLinkTypes;
}

/**
 * Finds the link type for a name or phrase. Jira's model: inwardIssue <outward phrase> outwardIssue
 * (e.g. A blocks B = inwardIssue A, outwardIssue B), so an inward phrase swaps the two issues.
 */
export function matchLinkType(types: LinkType[], input: string): { type: LinkType; inwardPhrase: boolean } {
  const q = input.trim().toLowerCase();
  const byName = types.find((t) => t.name.toLowerCase() === q || t.outward.toLowerCase() === q);
  if (byName) return { type: byName, inwardPhrase: false };
  const byInward = types.find((t) => t.inward.toLowerCase() === q);
  if (byInward) return { type: byInward, inwardPhrase: true };
  throw new Error(
    `Unknown link type "${input}". Available: ` + types.map((t) => `${t.name} (${t.outward} / ${t.inward})`).join(", "),
  );
}

export function registerLinkTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;

  defineTool(server, ctx, {
    name: "list_link_types",
    title: "List issue link types",
    description: "List issue link types with their outward/inward phrases (e.g. Blocks: blocks / is blocked by).",
    input: {},
    write: false,
    run: async () => (await linkTypes(jira)).map(({ id, name, outward, inward }) => ({ id, name, outward, inward })),
  });

  defineTool(server, ctx, {
    name: "link_issues",
    title: "Link issues",
    description:
      'Link two issues so that "fromKey <type> toKey" reads correctly. type: link type name or phrase, ' +
      'e.g. "blocks", "is blocked by", "relates to", "Duplicate". Optional comment is added to the link.',
    input: {
      type: z.string().min(1),
      fromKey: issueKey,
      toKey: issueKey,
      comment: z.string().optional(),
    },
    write: true,
    idempotent: true,
    run: async ({ type, fromKey, toKey, comment }) => {
      assertWritable(ctx, [fromKey, toKey]);
      const { type: t, inwardPhrase } = matchLinkType(await linkTypes(jira), type);
      const [inwardIssue, outwardIssue] = inwardPhrase ? [toKey, fromKey] : [fromKey, toKey];
      await jira.post("/rest/api/3/issueLink", {
        type: { name: t.name },
        inwardIssue: { key: inwardIssue },
        outwardIssue: { key: outwardIssue },
        ...(comment ? { comment: { body: textToAdf(comment) } } : {}),
      });
      return { linked: `${fromKey} ${inwardPhrase ? t.inward : t.outward} ${toKey}`, type: t.name };
    },
  });

  defineTool(server, ctx, {
    name: "remove_issue_link",
    title: "Remove issue link",
    description: "Delete one issue link by its id (shown in get_issue links). The issues themselves are not touched.",
    input: { linkId: z.string().regex(/^\d+$/, "Numeric link id") },
    write: true,
    idempotent: true,
    destructive: true,
    run: async ({ linkId }) => {
      const link = await jira.get<{
        type: { outward: string };
        inwardIssue: { key: string };
        outwardIssue: { key: string };
      }>(`/rest/api/3/issueLink/${linkId}`);
      assertWritable(ctx, [link.inwardIssue.key, link.outwardIssue.key]);
      await jira.delete(`/rest/api/3/issueLink/${linkId}`);
      return { removed: linkId, was: `${link.inwardIssue.key} ${link.type.outward} ${link.outwardIssue.key}` };
    },
  });
}
