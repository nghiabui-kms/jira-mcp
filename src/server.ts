import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgileTools } from "./tools/agile.js";
import { registerBacklogTools } from "./tools/backlog.js";
import { registerBulkTools } from "./tools/bulk.js";
import { registerEpicTools } from "./tools/epics.js";
import { registerFilterTools } from "./tools/filters.js";
import { registerHistoryTools } from "./tools/history.js";
import type { ToolContext } from "./tools/context.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerLinkTools } from "./tools/links.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerReportTools } from "./tools/reports.js";
import { registerTimeTools } from "./tools/time.js";
import { registerWorklogTools } from "./tools/worklogs.js";

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "jira-mcp", version: "0.1.0" },
    {
      instructions:
        "Tools for one Jira Cloud site. Before changing an issue, confirm the target issue and the change " +
        "with the user. Use find_users to turn a person's name into an accountId, get_transitions before " +
        "transition_issue when unsure of the workflow, and list_boards then list_sprints to find a sprint id. " +
        "Custom fields can be read and written by display name; use list_fields / get_create_meta when unsure, " +
        "and list_templates before creating a task from a template. bulk_update_issues and close_sprint " +
        "preview by default (dryRun / confirm); show the preview to the user before applying.",
    },
  );
  registerIssueTools(server, ctx);
  registerAgileTools(server, ctx);
  registerWorklogTools(server, ctx);
  registerMetaTools(server, ctx);
  registerBacklogTools(server, ctx);
  registerLinkTools(server, ctx);
  registerReportTools(server, ctx);
  registerHistoryTools(server, ctx);
  registerTimeTools(server, ctx);
  registerEpicTools(server, ctx);
  registerBulkTools(server, ctx);
  registerFilterTools(server, ctx);
  return server;
}
