import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi } from "vitest";
import type { Config } from "../src/config.js";
import { ApiTokenAuth } from "../src/jira/auth.js";
import { JiraClient } from "../src/jira/client.js";
import { FieldRegistry, type FieldInfo } from "../src/jira/fields.js";
import { createMcpServer } from "../src/server.js";
import { settingsSchema } from "../src/settings.js";
import type { Templates } from "../src/templates.js";
import type { ToolContext } from "../src/tools/context.js";

export const SITE = "https://example.atlassian.net";

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}
type Route = unknown | ((call: Call) => unknown);

/** Replaces global fetch with a router keyed by "METHOD /path". Returns the list of calls made. */
export function fakeJira(routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const call: Call = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const key = `${method} ${url.pathname}`;
    const route = routes[key];
    if (!Object.hasOwn(routes, key)) {
      return new Response(JSON.stringify({ errorMessages: [`no fake route for ${method} ${url.pathname}`] }), { status: 404 });
    }
    const result = typeof route === "function" ? route(call) : route;
    if (result instanceof Response) return result;
    return result === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(result));
  });
  return calls;
}

export const jiraError = (status: number, errors: Record<string, string>) =>
  new Response(JSON.stringify({ errorMessages: [], errors }), { status });

export function testContext(opts: { settings?: unknown; templates?: Templates; config?: Partial<Config> } = {}): ToolContext {
  const config: Config = {
    JIRA_BASE_URL: SITE,
    JIRA_EMAIL: "bot@example.com",
    JIRA_API_TOKEN: "token",
    MCP_PATH_SECRET: "x".repeat(32),
    PORT: 3000,
    HOST: "127.0.0.1",
    READ_ONLY: false,
    ALLOWED_PROJECTS: [],
    CONFIG_FILE: "./none.json",
    ...opts.config,
  };
  const jira = new JiraClient(new ApiTokenAuth(SITE, config.JIRA_EMAIL, config.JIRA_API_TOKEN));
  const settings = settingsSchema.parse(opts.settings ?? {});
  return {
    jira,
    config,
    settings: () => settings,
    templates: () => opts.templates ?? {},
    fields: new FieldRegistry(jira, () => settings),
  };
}

/** Connects an MCP client to a fresh server over an in-memory transport. */
export async function connect(ctx: ToolContext) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    if (res.isError) throw new Error(text);
    try {
      return JSON.parse(text) as Record<string, unknown> & unknown[];
    } catch {
      return text as never;
    }
  };
  return { client, call };
}

const TEAM = "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team";
const SPRINT = "com.pyxis.greenhopper.jira:gh-sprint";
const SELECT = "com.atlassian.jira.plugin.system.customfieldtypes:select";

export const FIELDS: FieldInfo[] = [
  { id: "summary", name: "Summary", custom: false, schema: { type: "string", system: "summary" } },
  { id: "description", name: "Description", custom: false, schema: { type: "string", system: "description" } },
  { id: "labels", name: "Labels", custom: false, schema: { type: "array", items: "string", system: "labels" } },
  { id: "components", name: "Components", custom: false, schema: { type: "array", items: "component", system: "components" } },
  { id: "fixVersions", name: "Fix versions", custom: false, schema: { type: "array", items: "version", system: "fixVersions" } },
  { id: "priority", name: "Priority", custom: false, schema: { type: "priority", system: "priority" } },
  { id: "assignee", name: "Assignee", custom: false, schema: { type: "user", system: "assignee" } },
  { id: "duedate", name: "Due date", custom: false, schema: { type: "date", system: "duedate" } },
  { id: "customfield_10016", name: "Story point estimate", custom: true, schema: { type: "number", custom: "com.pyxis.greenhopper.jira:jsw-story-points" } },
  { id: "customfield_10020", name: "Sprint", custom: true, schema: { type: "array", items: "json", custom: SPRINT } },
  { id: "customfield_10001", name: "Team", custom: true, schema: { type: "team", custom: TEAM } },
  { id: "customfield_10021", name: "Flagged", custom: true, schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" } },
  { id: "customfield_10100", name: "Automation Status", custom: true, schema: { type: "option", custom: SELECT } },
  { id: "customfield_10101", name: "Work type", custom: true, schema: { type: "option", custom: SELECT } },
  { id: "customfield_10102", name: "Reviewers", custom: true, schema: { type: "array", items: "user", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker" } },
  { id: "customfield_10103", name: "Platforms", custom: true, schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiselect" } },
  { id: "customfield_10104", name: "Notes", custom: true, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" } },
  { id: "customfield_10105", name: "Environment URL", custom: true, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:url" } },
  { id: "customfield_10106", name: "Weird", custom: true, schema: { type: "any", custom: "com.example:weird" } },
  { id: "customfield_10200", name: "Dup", custom: true, schema: { type: "number", custom: "x:float" } },
  { id: "customfield_10201", name: "dup", custom: true, schema: { type: "string", custom: "x:text" } },
];

export const SETTINGS = {
  defaultProjectKey: "AUTOKAT",
  defaultBoardId: 2092,
  fields: {
    automationStatus: ["Automation Status"],
    workType: ["Work type"],
  },
  listFields: ["storyPoints", "sprint", "components", "automationStatus", "workType"],
};
