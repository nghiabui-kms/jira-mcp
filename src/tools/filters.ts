import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, outputFieldsSchema, type ToolContext } from "./context.js";
import { searchIssues } from "./issues.js";

interface Filter {
  id: string;
  name: string;
  jql?: string;
  favourite?: boolean;
  owner?: { displayName?: string };
}

const filterOut = (f: Filter) => ({ id: f.id, name: f.name, owner: f.owner?.displayName, favourite: f.favourite, jql: f.jql });

export function registerFilterTools(server: McpServer, ctx: ToolContext): void {
  const { jira } = ctx;

  defineTool(server, ctx, {
    name: "list_filters",
    title: "List saved filters",
    description: "Find saved Jira filters by name (or only your favourites), with their JQL. Max 50.",
    input: {
      query: z.string().optional().describe("Part of the filter name"),
      favouritesOnly: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(50).default(25),
    },
    write: false,
    run: async ({ query, favouritesOnly, maxResults }) => {
      if (favouritesOnly) {
        const q = query?.toLowerCase();
        const list = await jira.get<Filter[]>("/rest/api/3/filter/favourite");
        return list.filter((f) => !q || f.name.toLowerCase().includes(q)).slice(0, maxResults).map(filterOut);
      }
      const res = await jira.get<{ values: Filter[] }>("/rest/api/3/filter/search", {
        filterName: query,
        expand: "jql,owner,favourite",
        maxResults,
      });
      return res.values.map(filterOut);
    },
  });

  defineTool(server, ctx, {
    name: "run_filter",
    title: "Run saved filter",
    description: "Run a saved filter's JQL; same output and paging (nextPageToken) as search_issues.",
    input: {
      filterId: z.string().regex(/^\d+$/, "Numeric filter id"),
      maxResults: z.number().int().min(1).max(100).default(25),
      nextPageToken: z.string().optional(),
      fields: outputFieldsSchema,
    },
    write: false,
    run: async ({ filterId, maxResults, nextPageToken, fields }) => {
      const filter = await jira.get<Filter>(`/rest/api/3/filter/${filterId}`);
      if (!filter.jql) throw new Error(`Filter ${filterId} has no JQL.`);
      return {
        filter: { id: filter.id, name: filter.name },
        jql: filter.jql,
        ...(await searchIssues(ctx, filter.jql, maxResults, nextPageToken, fields)),
      };
    },
  });
}
