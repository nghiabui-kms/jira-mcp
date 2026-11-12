import { z } from "zod";

const schema = z.object({
  JIRA_BASE_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, "")),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().min(1, "is required"),
  MCP_PATH_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -hex 32)"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  READ_ONLY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ALLOWED_PROJECTS: z
    .string()
    .optional()
    .transform((s) =>
      (s ?? "")
        .split(",")
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean),
    ),
  CONFIG_FILE: z.string().default("./jira-mcp.config.json"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid configuration (.env):");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
