import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { loadConfig } from "./config.js";
import { ApiTokenAuth } from "./jira/auth.js";
import { JiraClient } from "./jira/client.js";
import { createMcpServer } from "./server.js";
import { createToolContext } from "./tools/context.js";

const config = loadConfig();
const jira = new JiraClient(new ApiTokenAuth(config.JIRA_BASE_URL, config.JIRA_EMAIL, config.JIRA_API_TOKEN));
const ctx = createToolContext(jira, config);

const secretHash = createHash("sha256").update(config.MCP_PATH_SECRET).digest();
const secretMatches = (given: string) =>
  timingSafeEqual(createHash("sha256").update(given).digest(), secretHash);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post("/mcp/:secret", async (req: Request, res: Response) => {
  if (!secretMatches(req.params.secret)) {
    res.status(404).end();
    return;
  }
  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// GET (SSE stream) and DELETE (session end) are not used in stateless mode.
app.all("/mcp/:secret", (req: Request, res: Response) => {
  if (!secretMatches(req.params.secret)) {
    res.status(404).end();
    return;
  }
  res
    .status(405)
    .set("Allow", "POST")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.use((_req, res) => {
  res.status(404).end();
});

app.listen(config.PORT, config.HOST, () => {
  const masked = config.MCP_PATH_SECRET.slice(0, 4) + "…";
  console.log(`Jira MCP listening on http://${config.HOST}:${config.PORT}/mcp/${masked}`);
  console.log(`Jira site: ${config.JIRA_BASE_URL}  read-only: ${config.READ_ONLY}` +
    (config.ALLOWED_PROJECTS.length ? `  allowed projects: ${config.ALLOWED_PROJECTS.join(",")}` : ""));
});
