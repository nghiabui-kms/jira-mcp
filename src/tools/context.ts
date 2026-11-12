import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import type { Config } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { FieldRegistry } from "../jira/fields.js";
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "../settings.js";
import { templatesSchema, type Templates } from "../templates.js";
import { watchedJson } from "../util/jsonFile.js";

export interface ToolContext {
  jira: JiraClient;
  config: Config;
  /** jira-mcp.config.json, re-read when it changes. */
  settings: () => Settings;
  /** Task templates, re-read when the file changes. */
  templates: () => Templates;
  fields: FieldRegistry;
}

export function createToolContext(jira: JiraClient, config: Config): ToolContext {
  const settings = watchedJson(config.CONFIG_FILE, settingsSchema, DEFAULT_SETTINGS);
  let watched: { path: string; read: () => Templates } | undefined;
  const templates = () => {
    // templatesFile is relative to the config file and may change on reload
    const path = resolve(dirname(config.CONFIG_FILE), settings().templatesFile);
    if (watched?.path !== path) watched = { path, read: watchedJson(path, templatesSchema, {}) };
    return watched.read();
  };
  return { jira, config, settings, templates, fields: new FieldRegistry(jira, settings) };
}

interface ToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Write tools are skipped when READ_ONLY=true. */
  write: boolean;
  /** Re-running with the same input has no extra effect. */
  idempotent?: boolean;
  /** Removes or irreversibly changes data (e.g. deleting a link, closing a sprint). */
  destructive?: boolean;
  run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>;
}

/** Registers a tool with consistent annotations, JSON output and error handling. */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  spec: ToolSpec<S>,
): void {
  if (spec.write && ctx.config.READ_ONLY) return;

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      annotations: {
        readOnlyHint: !spec.write,
        destructiveHint: spec.destructive ?? false,
        idempotentHint: spec.idempotent ?? !spec.write,
        openWorldHint: true,
      },
    },
    // Cast: the SDK's generic callback type does not infer through a generic shape S.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (args: any): Promise<CallToolResult> => {
      try {
        const data = await spec.run(args);
        const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: message }] };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
}

/** Blocks writes outside ALLOWED_PROJECTS (when it is set). */
export function assertWritable(ctx: ToolContext, projectOrIssueKeys: string[]): void {
  const allowed = ctx.config.ALLOWED_PROJECTS;
  if (!allowed.length) return;
  const blocked = projectOrIssueKeys
    .map((k) => k.trim().toUpperCase().split("-")[0])
    .filter((p) => !allowed.includes(p));
  if (blocked.length) {
    throw new Error(
      `Write blocked: project(s) ${[...new Set(blocked)].join(", ")} not in ALLOWED_PROJECTS (${allowed.join(", ")}).`,
    );
  }
}

/** Accepts an accountId or "me"; returns an accountId. */
export async function resolveAccountId(ctx: ToolContext, value: string): Promise<string> {
  if (value.toLowerCase() !== "me") return value;
  const me = await ctx.jira.get<{ accountId: string }>("/rest/api/3/myself");
  return me.accountId;
}

export const issueKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/, "Issue key like ABC-123");
export const durationSchema = z.string().regex(/^\s*(\d+(\.\d+)?\s*[wdhm]\s*)+$/i, "Jira duration like 1h 30m");
/** Extra output fields (names, logical keys or IDs) for issue-returning tools. */
export const outputFieldsSchema = z
  .array(z.string().min(1))
  .max(20)
  .optional()
  .describe("Extra fields to include, by name, config key or ID (e.g. [\"Due date\", \"customfield_10050\"])");

/** Adds `warnings` to a result only when there are some. */
export const withWarnings = <T extends object>(result: T, warnings: string[]) =>
  warnings.length ? { ...result, warnings } : result;
