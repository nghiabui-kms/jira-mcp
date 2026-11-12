// Stdio entry for local clients (Claude Desktop) that spawn the server as a child process.
// stdout carries the MCP protocol, so log only to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ApiTokenAuth } from "./jira/auth.js";
import { JiraClient } from "./jira/client.js";
import { createMcpServer } from "./server.js";
import { createToolContext } from "./tools/context.js";

const config = loadConfig();
const jira = new JiraClient(new ApiTokenAuth(config.JIRA_BASE_URL, config.JIRA_EMAIL, config.JIRA_API_TOKEN));
await createMcpServer(createToolContext(jira, config)).connect(new StdioServerTransport());
console.error(`Jira MCP (stdio) ready. Site: ${config.JIRA_BASE_URL}  read-only: ${config.READ_ONLY}`);
