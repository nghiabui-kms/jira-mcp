import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JiraClient } from "../jira/client.js";
import { isObj, type FieldSchema } from "../jira/fields.js";
import { resolveTemplate } from "../templates.js";
import { defineTool, type ToolContext } from "./context.js";

const MAX_ALLOWED_VALUES = 50;

interface CreateField {
  fieldId: string;
  name: string;
  required: boolean;
  hasDefaultValue?: boolean;
  schema?: FieldSchema;
  allowedValues?: unknown[];
}

const typeLabel = (s?: FieldSchema) => (s ? (s.type === "array" ? `array<${s.items ?? "?"}>` : s.type) : undefined);

function compactAllowed(values?: unknown[]) {
  if (!values?.length) return undefined;
  const list = values
    .slice(0, MAX_ALLOWED_VALUES)
    .map((v) => (isObj(v) ? (v.value ?? v.name ?? v.key ?? v.id) : v));
  return values.length > MAX_ALLOWED_VALUES ? [...list, `…${values.length - MAX_ALLOWED_VALUES} more`] : list;
}

/** Create-screen fields for one project + issue type (first 200 fields). */
export async function getCreateMeta(jira: JiraClient, projectKey: string, issueType: string) {
  const project = encodeURIComponent(projectKey.toUpperCase());
  const types = await jira.get<{ issueTypes?: Array<{ id: string; name: string }> }>(
    `/rest/api/3/issue/createmeta/${project}/issuetypes`,
    { maxResults: 200 },
  );
  const list = types.issueTypes ?? [];
  const type = list.find((t) => t.name.toLowerCase() === issueType.trim().toLowerCase());
  if (!type) {
    throw new Error(`Issue type "${issueType}" not available in ${projectKey}. Available: ${list.map((t) => t.name).join(", ")}`);
  }
  const res = await jira.get<{ fields?: CreateField[]; results?: CreateField[] }>(
    `/rest/api/3/issue/createmeta/${project}/issuetypes/${type.id}`,
    { maxResults: 200 },
  );
  return { issueType: type.name, fields: res.fields ?? res.results ?? [] };
}

/** Explains which required fields were not sent; used to enrich create_issue 400 errors. */
export async function missingRequiredHint(
  jira: JiraClient,
  projectKey: string,
  issueType: string,
  sentFieldIds: string[],
): Promise<string> {
  const meta = await getCreateMeta(jira, projectKey, issueType);
  const missing = meta.fields.filter((f) => f.required && !f.hasDefaultValue && !sentFieldIds.includes(f.fieldId));
  if (!missing.length) return "";
  return (
    `\nRequired fields not set for ${projectKey.toUpperCase()}/${meta.issueType}: ` +
    missing
      .map((f) => {
        const allowed = compactAllowed(f.allowedValues);
        return `${f.name} (${f.fieldId})` + (allowed ? ` allowed: ${allowed.join(", ")}` : "");
      })
      .join("; ") +
    ". Pass them in `fields` by name."
  );
}

export function registerMetaTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;

  defineTool(server, ctx, {
    name: "list_fields",
    title: "List fields",
    description:
      "List Jira fields (id, name, type, custom type), filtered by a name/ID substring. Max 100 results. " +
      "Use it to find field IDs to pin in jira-mcp.config.json.",
    input: { query: z.string().optional().describe("Substring of the field name or ID, case-insensitive") },
    write: false,
    run: async ({ query }) => {
      const q = query?.trim().toLowerCase();
      const all = await ctx.fields.all();
      const hits = q ? all.filter((f) => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q)) : all;
      return {
        total: hits.length,
        fields: hits.slice(0, 100).map((f) => ({
          id: f.id,
          name: f.name,
          type: typeLabel(f.schema),
          custom: f.schema?.custom?.split(":").pop(),
        })),
      };
    },
  });

  defineTool(server, ctx, {
    name: "get_create_meta",
    title: "Get create metadata",
    description:
      "Required fields (with allowed values, max 50 each) and optional field names for creating an issue " +
      "of a given type in a project.",
    input: {
      projectKey: z.string().min(1).optional().describe("Defaults to defaultProjectKey from the config"),
      issueType: z.string().min(1).describe("Issue type name, e.g. Story"),
    },
    write: false,
    run: async ({ projectKey, issueType }) => {
      const project = projectKey ?? ctx.settings().defaultProjectKey;
      if (!project) throw new Error("projectKey is required (no defaultProjectKey in the config).");
      const meta = await getCreateMeta(jira, project, issueType);
      return {
        project: project.toUpperCase(),
        issueType: meta.issueType,
        required: meta.fields
          .filter((f) => f.required)
          .map((f) => ({
            id: f.fieldId,
            name: f.name,
            type: typeLabel(f.schema),
            hasDefault: f.hasDefaultValue || undefined,
            allowedValues: compactAllowed(f.allowedValues),
          })),
        optional: meta.fields.filter((f) => !f.required).map((f) => `${f.name} (${f.fieldId})`),
      };
    },
  });

  defineTool(server, ctx, {
    name: "list_project_components",
    title: "List project components",
    description: "List components of a project (id, name, lead).",
    input: { projectKey: z.string().min(1).optional().describe("Defaults to defaultProjectKey") },
    write: false,
    run: async ({ projectKey }) => {
      const project = projectKey ?? ctx.settings().defaultProjectKey;
      if (!project) throw new Error("projectKey is required (no defaultProjectKey in the config).");
      const list = await jira.get<Array<{ id: string; name: string; description?: string; lead?: { displayName?: string } }>>(
        `/rest/api/3/project/${encodeURIComponent(project.toUpperCase())}/components`,
      );
      return list.map((c) => ({ id: c.id, name: c.name, lead: c.lead?.displayName, description: c.description || undefined }));
    },
  });

  defineTool(server, ctx, {
    name: "list_project_versions",
    title: "List project versions",
    description: "List versions of a project, unreleased first. Archived versions are skipped unless includeArchived. Max 100.",
    input: {
      projectKey: z.string().min(1).optional().describe("Defaults to defaultProjectKey"),
      includeArchived: z.boolean().default(false),
    },
    write: false,
    run: async ({ projectKey, includeArchived }) => {
      const project = projectKey ?? ctx.settings().defaultProjectKey;
      if (!project) throw new Error("projectKey is required (no defaultProjectKey in the config).");
      const list = await jira.get<
        Array<{ id: string; name: string; released?: boolean; archived?: boolean; releaseDate?: string; startDate?: string }>
      >(`/rest/api/3/project/${encodeURIComponent(project.toUpperCase())}/versions`);
      const versions = list
        .filter((v) => includeArchived || !v.archived)
        .sort((a, b) =>
          a.released === b.released
            ? (a.released ? -1 : 1) * (a.releaseDate ?? "9999").localeCompare(b.releaseDate ?? "9999")
            : a.released
              ? 1
              : -1,
        );
      return {
        total: versions.length,
        versions: versions.slice(0, 100).map((v) => ({
          id: v.id,
          name: v.name,
          released: !!v.released,
          archived: v.archived || undefined,
          startDate: v.startDate,
          releaseDate: v.releaseDate,
        })),
      };
    },
  });

  defineTool(server, ctx, {
    name: "list_templates",
    title: "List task templates",
    description:
      "List task templates for create_issue(template=...): resolved values (extends applied) and the description " +
      "skeleton to fill in. Templates are maintained in git, not through this server.",
    input: {},
    write: false,
    run: async () => {
      const all = ctx.templates();
      return Object.keys(all).map((name) => {
        try {
          return { name, ...resolveTemplate(all, name) };
        } catch (err) {
          return { name, error: err instanceof Error ? err.message : String(err) };
        }
      });
    },
  });
}
