import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openAsBlob } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { textToAdf, type AdfNode } from "../jira/adf.js";
import { JiraError } from "../jira/client.js";
import { LIST_FIELDS, simplifyIssue, simplifyIssueDetail, type RawIssue } from "../jira/format.js";
import { merge, resolveTemplate } from "../templates.js";
import { readClipboardPng } from "../util/clipboard.js";
import {
  assertWritable,
  defineTool,
  durationSchema,
  issueKeySchema as issueKey,
  outputFieldsSchema,
  resolveAccountId,
  withWarnings,
  type ToolContext,
} from "./context.js";
import { missingRequiredHint } from "./meta.js";
const accountId = z.string().describe('Atlassian accountId (from find_users), or "me"');
const namedFields = z
  .record(z.unknown())
  .optional()
  .describe(
    'Fields by display name, config key or ID, e.g. {"Story Points": 3, "automationStatus": "Automated", "Sprint": 123}. ' +
      'Values are converted by field type (options by value, users by accountId or "me", team by id).',
  );
const MARKDOWN_HELP =
  "Markdown: # headings, **bold**, *italic*, `code`, [text](url), - lists (2-space nesting), 1. lists, " +
  "| a | b | tables, ``` code blocks, mentions @[accountId].";

/** Attachments are read from the server's disk, so only ATTACHMENTS_DIR is reachable (no .env, keys, etc.). */
async function resolveAttachmentPaths(ctx: ToolContext, paths: string[]): Promise<string[]> {
  const dir = ctx.config.ATTACHMENTS_DIR;
  if (!dir) throw new Error("Attachments are disabled: set ATTACHMENTS_DIR in the server .env.");
  const root = await realpath(dir);
  return Promise.all(
    paths.map(async (p) => {
      // realpath also resolves symlinks, so a link inside the folder cannot point outside it.
      const real = await realpath(p).catch(() => {
        throw new Error(`Attachment not found: ${p}`);
      });
      const rel = relative(root, real);
      if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
        throw new Error(`Attachment ${p} is outside ATTACHMENTS_DIR (${dir}).`);
      }
      return real;
    }),
  );
}

export function registerIssueTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;
  const site = ctx.config.JIRA_BASE_URL;

  // ---------- read ----------

  defineTool(server, ctx, {
    name: "get_myself",
    title: "Who am I",
    description: "Return the Jira account this server acts as (accountId, name, timezone).",
    input: {},
    write: false,
    run: async () => {
      const me = await jira.get<Record<string, string>>("/rest/api/3/myself");
      return { accountId: me.accountId, displayName: me.displayName, email: me.emailAddress, timeZone: me.timeZone };
    },
  });

  defineTool(server, ctx, {
    name: "find_users",
    title: "Find users",
    description: "Search Jira users by name or email to get their accountId (needed for assignee).",
    input: { query: z.string().min(1) },
    write: false,
    run: async ({ query }) => {
      const users = await jira.get<Array<Record<string, string>>>("/rest/api/3/user/search", {
        query,
        maxResults: 10,
      });
      return users
        .filter((u) => u.accountType === "atlassian")
        .map((u) => ({ accountId: u.accountId, displayName: u.displayName, email: u.emailAddress }));
    },
  });

  defineTool(server, ctx, {
    name: "list_projects",
    title: "List projects",
    description: "List Jira projects visible to the account, optionally filtered by name/key.",
    input: { query: z.string().optional() },
    write: false,
    run: async ({ query }) => {
      const res = await jira.get<{ values: Array<Record<string, string>> }>("/rest/api/3/project/search", {
        query,
        maxResults: 50,
      });
      return res.values.map((p) => ({ key: p.key, name: p.name, id: p.id }));
    },
  });

  defineTool(server, ctx, {
    name: "search_issues",
    title: "Search issues (JQL)",
    description:
      "Search issues with JQL. The JQL must contain at least one restriction (e.g. project = ABC); " +
      "an unbounded query like 'ORDER BY created' is rejected by Jira. " +
      "Use nextPageToken from the previous result to get the next page. " +
      "Output includes the configured list fields (story points, sprint, ...) and flagged.",
    input: {
      jql: z.string().min(1).describe('e.g. project = ABC AND assignee = currentUser() AND statusCategory != Done'),
      maxResults: z.number().int().min(1).max(100).default(25),
      nextPageToken: z.string().optional(),
      fields: outputFieldsSchema,
    },
    write: false,
    run: async ({ jql, maxResults, nextPageToken, fields }) => searchIssues(ctx, jql, maxResults, nextPageToken, fields),
  });

  defineTool(server, ctx, {
    name: "get_issue",
    title: "Get issue",
    description:
      "Get one issue: description (Markdown), all configured fields, estimates, fix versions, subtasks, " +
      "links (with link id) and latest comments.",
    input: { issueKey, commentLimit: z.number().int().min(0).max(50).default(5), fields: outputFieldsSchema },
    write: false,
    run: async ({ issueKey, commentLimit, fields }) => {
      const out = await ctx.fields.outputFields(fields, true);
      const issue = await jira.get<RawIssue>(`/rest/api/3/issue/${issueKey}`, {
        fields: [
          ...LIST_FIELDS,
          "description",
          "comment",
          "timetracking",
          "fixVersions",
          "subtasks",
          "issuelinks",
          ...out.ids,
        ].join(","),
      });
      return withWarnings(simplifyIssueDetail(issue, site, commentLimit, out.fields), out.warnings);
    },
  });

  defineTool(server, ctx, {
    name: "get_transitions",
    title: "Get available transitions",
    description: "List the workflow transitions currently available for an issue.",
    input: { issueKey },
    write: false,
    run: async ({ issueKey }) => listTransitions(ctx, issueKey),
  });

  // ---------- write ----------

  defineTool(server, ctx, {
    name: "create_issue",
    title: "Create issue",
    description:
      "Create an issue, optionally from a template (see list_templates; explicit arguments override it, " +
      "labels/components are merged). Use parentKey for subtasks or epic children. Custom fields go in " +
      "`fields` by name. " +
      MARKDOWN_HELP,
    input: {
      projectKey: z.string().min(1).optional().describe("Defaults to the template's project, then defaultProjectKey"),
      summary: z.string().min(1).max(255),
      issueType: z.string().optional().describe("Issue type name, e.g. Task, Story, Sub-task. Default: template's, else Task"),
      description: z.string().optional().describe("Markdown. Default: the template's skeleton"),
      assignee: accountId.optional(),
      priority: z.string().optional().describe("Priority name, e.g. P2"),
      labels: z.array(z.string()).optional(),
      components: z.array(z.string()).optional().describe("Component names"),
      parentKey: issueKey.optional(),
      template: z.string().optional().describe("Template name from list_templates"),
      fields: namedFields,
      extraFields: z
        .record(z.unknown())
        .optional()
        .describe('Raw Jira fields passed through unchanged, e.g. {"customfield_10016": 3}'),
    },
    write: true,
    idempotent: false,
    run: async (a) => {
      const tpl = a.template ? resolveTemplate(ctx.templates(), a.template) : {};
      const m = merge(tpl, {
        project: a.projectKey,
        issueType: a.issueType,
        description: a.description,
        assignee: a.assignee,
        labels: a.labels,
        components: a.components,
        parent: a.parentKey,
        fields: a.fields,
      });
      const project = (m.project ?? ctx.settings().defaultProjectKey)?.toUpperCase();
      if (!project) throw new Error("projectKey is required (no template project and no defaultProjectKey).");
      assertWritable(ctx, [project]);
      const issueType = m.issueType ?? "Task";
      const fields: Record<string, unknown> = {
        ...(m.fields ? await ctx.fields.toJiraFields(m.fields) : {}),
        project: { key: project },
        summary: a.summary,
        issuetype: { name: issueType },
        ...(m.description ? { description: textToAdf(m.description) } : {}),
        ...(m.assignee ? { assignee: { accountId: await resolveAccountId(ctx, m.assignee) } } : {}),
        ...(a.priority ? { priority: { name: a.priority } } : {}),
        ...(m.labels ? { labels: m.labels } : {}),
        ...(m.components ? { components: m.components.map((name) => ({ name })) } : {}),
        ...(m.parent ? { parent: { key: m.parent } } : {}),
        ...(a.extraFields ?? {}),
      };
      try {
        const res = await jira.post<{ key: string }>("/rest/api/3/issue", { fields });
        return { created: res.key, url: `${site}/browse/${res.key}`, template: a.template };
      } catch (err) {
        if (!(err instanceof JiraError) || err.status !== 400) throw err;
        const hint = await missingRequiredHint(jira, project, issueType, Object.keys(fields)).catch(() => "");
        throw new Error(err.message + hint);
      }
    },
  });

  defineTool(server, ctx, {
    name: "update_issue",
    title: "Update issue",
    description:
      "Update an issue. Only what you pass changes. assignee: accountId, \"me\", or null to unassign. " +
      "labels/components replace the whole list; addLabels/removeLabels edit it. Estimates use Jira durations (2h, 1d). " +
      MARKDOWN_HELP,
    input: {
      issueKey,
      summary: z.string().min(1).max(255).optional(),
      description: z.string().optional(),
      assignee: accountId.nullable().optional(),
      priority: z.string().optional(),
      labels: z.array(z.string()).optional(),
      addLabels: z.array(z.string().min(1)).optional(),
      removeLabels: z.array(z.string().min(1)).optional(),
      components: z.array(z.string()).optional().describe("Component names; replaces the current list"),
      originalEstimate: durationSchema.optional(),
      remainingEstimate: durationSchema.optional(),
      fields: namedFields,
      extraFields: z.record(z.unknown()).optional().describe("Raw Jira fields passed through unchanged"),
    },
    write: true,
    idempotent: true,
    run: async (a) => {
      assertWritable(ctx, [a.issueKey]);
      if (a.labels && (a.addLabels || a.removeLabels)) {
        throw new Error("Use either labels (replace) or addLabels/removeLabels, not both.");
      }
      const fields: Record<string, unknown> = {
        ...(a.fields ? await ctx.fields.toJiraFields(a.fields) : {}),
        ...(a.summary !== undefined ? { summary: a.summary } : {}),
        ...(a.description !== undefined ? { description: textToAdf(a.description) } : {}),
        ...(a.priority !== undefined ? { priority: { name: a.priority } } : {}),
        ...(a.labels !== undefined ? { labels: a.labels } : {}),
        ...(a.components !== undefined ? { components: a.components.map((name) => ({ name })) } : {}),
        ...(a.extraFields ?? {}),
      };
      const update = labelAndEstimateOps(a);
      const changed: string[] = [];
      if (Object.keys(fields).length || Object.keys(update).length) {
        await jira.put(`/rest/api/3/issue/${a.issueKey}`, {
          ...(Object.keys(fields).length ? { fields } : {}),
          ...(Object.keys(update).length ? { update } : {}),
        });
        changed.push(...Object.keys(fields), ...Object.keys(update));
      }
      // Dedicated endpoint works even when assignee is not on the edit screen.
      if (a.assignee !== undefined) {
        const id = a.assignee === null ? null : await resolveAccountId(ctx, a.assignee);
        await jira.put(`/rest/api/3/issue/${a.issueKey}/assignee`, { accountId: id });
        changed.push("assignee");
      }
      if (!changed.length) throw new Error("Nothing to update: pass at least one field.");
      return { updated: a.issueKey, fields: changed, url: `${site}/browse/${a.issueKey}` };
    },
  });

  defineTool(server, ctx, {
    name: "add_comment",
    title: "Add comment",
    description:
      "Add a comment to an issue (plain text with simple Markdown). `attachments`: file paths on the server " +
      "(inside ATTACHMENTS_DIR) uploaded to the issue and shown in the comment, images inline. " +
      "`clipboardImage`: true attaches the image on the user's clipboard; use it when the user pasted a screenshot " +
      "into the chat and wants it on the issue (pasting leaves it on the clipboard).",
    input: {
      issueKey,
      body: z.string().optional().describe("Comment text; may be empty when attaching files"),
      attachments: z.array(z.string().min(1)).max(10).optional().describe("Absolute file paths, max 10"),
      clipboardImage: z.boolean().optional().describe("Attach the image currently on the clipboard (Windows)"),
    },
    write: true,
    idempotent: false,
    run: async ({ issueKey, body = "", attachments, clipboardImage }) => {
      assertWritable(ctx, [issueKey]);
      if (!body.trim() && !attachments?.length && !clipboardImage) {
        throw new Error("Nothing to post: pass body, attachments or clipboardImage.");
      }
      const files = attachments?.length ? await resolveAttachmentPaths(ctx, attachments) : [];
      const form = new FormData();
      for (const f of files) form.append("file", await openAsBlob(f), basename(f));
      if (clipboardImage) {
        const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
        form.append("file", await readClipboardPng(), `clipboard-${stamp}.png`);
      }
      const doc = textToAdf(body);
      const uploaded: Array<{ id: string; filename: string }> = [];
      if (form.has("file")) {
        const res = await jira.post<Array<{ id: string; filename: string; mimeType: string }>>(
          `/rest/api/3/issue/${issueKey}/attachments`,
          form,
        );
        for (const a of res) {
          uploaded.push({ id: a.id, filename: a.filename });
          doc.content!.push(await attachmentNode(a));
        }
      }
      const res = await jira.post<{ id: string }>(`/rest/api/3/issue/${issueKey}/comment`, { body: doc });
      return { issueKey, commentId: res.id, ...(uploaded.length ? { attachments: uploaded } : {}) };
    },
  });

  /** ADF media nodes reference the media-store UUID, which Jira only exposes via the content redirect. */
  async function attachmentNode(a: { id: string; filename: string; mimeType: string }): Promise<AdfNode> {
    const location = await jira.redirectLocation(`/rest/api/3/attachment/content/${a.id}`);
    const uuid = /\/file\/([0-9a-f-]{36})\//i.exec(location ?? "")?.[1];
    if (!uuid) {
      // Fallback: still visible on the issue, linked from the comment.
      const href = `${site}/rest/api/3/attachment/content/${a.id}`;
      return { type: "paragraph", content: [{ type: "text", text: a.filename, marks: [{ type: "link", attrs: { href } }] }] };
    }
    const media: AdfNode = { type: "media", attrs: { type: "file", id: uuid, collection: "", alt: a.filename } };
    return a.mimeType.startsWith("image/")
      ? { type: "mediaSingle", attrs: { layout: "center" }, content: [media] }
      : { type: "mediaGroup", content: [media] };
  }

  defineTool(server, ctx, {
    name: "transition_issue",
    title: "Transition issue",
    description:
      "Move an issue through its workflow. transition can be the transition name (e.g. 'In Progress', " +
      "'Done', case-insensitive), the target status name, or the transition id. Optionally add a comment.",
    input: { issueKey, transition: z.string().min(1), comment: z.string().optional() },
    write: true,
    idempotent: false,
    run: async ({ issueKey, transition, comment }) => {
      assertWritable(ctx, [issueKey]);
      const match = await resolveTransition(ctx, issueKey, transition);
      await jira.post(`/rest/api/3/issue/${issueKey}/transitions`, {
        transition: { id: match.id },
        ...(comment ? { update: { comment: [{ add: { body: textToAdf(comment) } }] } } : {}),
      });
      return { issueKey, transition: match.name, newStatus: match.to };
    },
  });
}

/** Runs a JQL search and formats issues with the configured output fields. */
export async function searchIssues(
  ctx: ToolContext,
  jql: string,
  maxResults: number,
  nextPageToken?: string,
  extraFields?: string[],
) {
  const out = await ctx.fields.outputFields(extraFields);
  const res = await ctx.jira.post<{ issues: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
    "/rest/api/3/search/jql",
    { jql, maxResults, fields: [...LIST_FIELDS, ...out.ids], nextPageToken },
  );
  return withWarnings(
    {
      issues: res.issues.map((i) => simplifyIssue(i, ctx.config.JIRA_BASE_URL, out.fields)),
      nextPageToken: res.isLast ? undefined : res.nextPageToken,
    },
    out.warnings,
  );
}

/** `update` operations for label add/remove and time-tracking edits. */
export function labelAndEstimateOps(a: {
  addLabels?: string[];
  removeLabels?: string[];
  originalEstimate?: string;
  remainingEstimate?: string;
}): Record<string, unknown[]> {
  const update: Record<string, unknown[]> = {};
  const labels = [...(a.addLabels ?? []).map((l) => ({ add: l })), ...(a.removeLabels ?? []).map((l) => ({ remove: l }))];
  if (labels.length) update.labels = labels;
  if (a.originalEstimate || a.remainingEstimate) {
    const edit = {
      ...(a.originalEstimate ? { originalEstimate: a.originalEstimate.trim() } : {}),
      ...(a.remainingEstimate ? { remainingEstimate: a.remainingEstimate.trim() } : {}),
    };
    update.timetracking = [{ edit }];
  }
  return update;
}

/** Finds a transition by id, name or target status (case-insensitive); throws listing the available ones. */
export async function resolveTransition(ctx: ToolContext, issueKey: string, transition: string) {
  const available = await listTransitions(ctx, issueKey);
  const wanted = transition.trim().toLowerCase();
  const match =
    available.find((t) => t.id === transition.trim()) ??
    available.find((t) => t.name.toLowerCase() === wanted) ??
    available.find((t) => t.to?.toLowerCase() === wanted);
  if (!match) {
    throw new Error(
      `Transition "${transition}" is not available for ${issueKey}. Available: ` +
        available.map((t) => `${t.name} (id ${t.id} -> ${t.to})`).join(", "),
    );
  }
  return match;
}

async function listTransitions(ctx: ToolContext, key: string) {
  const res = await ctx.jira.get<{
    transitions: Array<{ id: string; name: string; to?: { name: string } }>;
  }>(`/rest/api/3/issue/${key}/transitions`);
  return res.transitions.map((t) => ({ id: t.id, name: t.name, to: t.to?.name }));
}
