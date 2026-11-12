import type { Settings } from "../settings.js";
import { adfToShortText, textToAdf } from "./adf.js";
import type { JiraClient } from "./client.js";

export interface FieldSchema {
  type: string;
  items?: string;
  system?: string;
  custom?: string;
}

export interface FieldInfo {
  id: string;
  key?: string;
  name: string;
  custom: boolean;
  schema?: FieldSchema;
}

/** A field to show in issue output under a logical key (e.g. storyPoints). */
export interface OutputField {
  key: string;
  field: FieldInfo;
}

export const SPRINT_TYPE = "com.pyxis.greenhopper.jira:gh-sprint";
export const TEAM_TYPE = "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team";
const TEXTAREA_TYPE = "com.atlassian.jira.plugin.system.customfieldtypes:textarea";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 10 * 60_000;

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class FieldRegistry {
  private cache?: { at: number; fields: Promise<FieldInfo[]> };

  constructor(
    private readonly jira: JiraClient,
    private readonly settings: () => Settings,
  ) {}

  all(): Promise<FieldInfo[]> {
    if (!this.cache || Date.now() - this.cache.at > TTL_MS) {
      const fields = this.jira.get<FieldInfo[]>("/rest/api/3/field");
      const entry = { at: Date.now(), fields };
      fields.catch(() => {
        if (this.cache === entry) this.cache = undefined; // do not cache failures
      });
      this.cache = entry;
    }
    return this.cache.fields;
  }

  /** Find by ID/key, then by name (case-insensitive). Throws when a name matches several fields. */
  async find(nameOrId: string): Promise<FieldInfo | undefined> {
    const all = await this.all();
    const q = nameOrId.trim().toLowerCase();
    const byId = all.find((f) => f.id.toLowerCase() === q || f.key?.toLowerCase() === q);
    if (byId) return byId;
    const byName = all.filter((f) => f.name.toLowerCase() === q);
    if (byName.length > 1) {
      throw new Error(
        `Field "${nameOrId}" matches several fields: ` +
          byName.map((f) => `${f.id} (${f.schema?.custom ?? f.schema?.type ?? "?"})`).join(", ") +
          ". Pin the ID in jira-mcp.config.json \"fields\".",
      );
    }
    return byName[0];
  }

  /** Candidates for a logical key from the config, or the input itself (display name or ID). */
  candidates(keyOrName: string): string[] {
    const fields = this.settings().fields;
    return Object.hasOwn(fields, keyOrName) ? fields[keyOrName] : [keyOrName];
  }

  async tryResolve(keyOrName: string): Promise<FieldInfo | undefined> {
    for (const c of this.candidates(keyOrName)) {
      const f = await this.find(c);
      if (f) return f;
    }
    return undefined;
  }

  async resolve(keyOrName: string): Promise<FieldInfo> {
    const f = await this.tryResolve(keyOrName);
    if (f) return f;
    const tried = this.candidates(keyOrName);
    throw new Error(
      `Unknown field "${keyOrName}"` +
        (tried[0] !== keyOrName ? ` (tried ${tried.join(", ")})` : "") +
        ". Use list_fields to find its name or ID.",
    );
  }

  /**
   * Fields for issue output: config listFields + flagged (+ every configured field when `allConfigured`),
   * plus fields the caller asked for. Configured fields missing on this site are skipped silently;
   * ambiguous or unknown requested fields become warnings so the call still succeeds.
   */
  async outputFields(requested: string[] = [], allConfigured = false) {
    const s = this.settings();
    const configured = new Set([...s.listFields, "flagged", ...(allConfigured ? Object.keys(s.fields) : [])]);
    const fields: OutputField[] = [];
    const warnings: string[] = [];
    const add = async (key: string, warnIfMissing: boolean) => {
      try {
        const field = await this.tryResolve(key);
        if (field) fields.push({ key, field });
        else if (warnIfMissing) warnings.push(`Unknown field "${key}"`);
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    };
    for (const key of configured) await add(key, false);
    for (const key of requested) if (!configured.has(key)) await add(key, true);
    return { fields, ids: [...new Set(fields.map((f) => f.field.id))], warnings };
  }

  /** Converts {name|logicalKey|id: value} into Jira's {fieldId: jiraValue}. */
  async toJiraFields(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      const field = await this.resolve(k);
      out[field.id] = await writeValue(field, v, () => this.myAccountId());
    }
    return out;
  }

  private async myAccountId(): Promise<string> {
    return (await this.jira.get<{ accountId: string }>("/rest/api/3/myself")).accountId;
  }
}

/** Converts a friendly value into what Jira expects for this field's schema. */
export async function writeValue(field: FieldInfo, value: unknown, me: () => Promise<string>): Promise<unknown> {
  const s = field.schema;
  if (value === null || !s) return value;

  if (s.custom === SPRINT_TYPE) {
    const n = Number(Array.isArray(value) ? value[0] : isObj(value) ? value.id : value);
    if (!Number.isInteger(n)) throw new Error(`Field "${field.name}" needs a sprint id (number).`);
    return n;
  }
  if (s.custom === TEAM_TYPE) {
    const id = isObj(value) ? value.id : value;
    if (typeof id === "string" && UUID.test(id)) return id;
    throw new Error(
      `Field "${field.name}" needs the team id (UUID), got ${JSON.stringify(value)}. ` +
        "Team names cannot be resolved with the Jira REST API; copy the id from the team's page URL.",
    );
  }
  if (s.type === "array") {
    // The Flagged field is a checkbox with the single option "Impediment".
    if (s.items === "option" && typeof value === "boolean") return value ? [{ value: "Impediment" }] : null;
    const list = Array.isArray(value) ? value : [value];
    return Promise.all(list.map((v) => writeItem(s.items, v, me)));
  }
  if (s.type === "string" && typeof value === "string") {
    const rich = s.custom === TEXTAREA_TYPE || s.system === "description" || s.system === "environment";
    return rich ? textToAdf(value) : value;
  }
  return writeItem(s.type, value, me);
}

async function writeItem(kind: string | undefined, v: unknown, me: () => Promise<string>): Promise<unknown> {
  if (isObj(v)) return v; // already in Jira shape
  switch (kind) {
    case "option":
      return { value: String(v) };
    case "user":
      return { accountId: String(v).toLowerCase() === "me" ? await me() : String(v) };
    case "component":
    case "version":
    case "priority":
      return { name: String(v) };
    case "number":
      return typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
    default:
      return v;
  }
}

/** Converts a Jira field value into a compact display value; undefined when empty. */
export function readValue(field: FieldInfo, value: unknown): unknown {
  if (value === null || value === undefined || (Array.isArray(value) && !value.length)) return undefined;
  const custom = field.schema?.custom;
  if (custom === SPRINT_TYPE && Array.isArray(value)) {
    return value.filter(isObj).map((s) => ({ id: s.id, name: s.name, state: s.state }));
  }
  if (custom === TEAM_TYPE && isObj(value)) return value.name ?? value.title ?? value.id;
  return plain(value);
}

function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (!isObj(v)) return v;
  if (v.type === "doc") return adfToShortText(v, 2000);
  return v.value ?? v.displayName ?? v.name ?? v.key ?? v.id ?? v;
}
