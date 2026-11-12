import { z } from "zod";

/** Logical field key -> candidate field names or IDs (first one found on the site wins). */
const DEFAULT_FIELDS: Record<string, string[]> = {
  storyPoints: ["Story Points", "Story point estimate"],
  sprint: ["Sprint"],
  team: ["Team"],
  flagged: ["Flagged"],
};

export const settingsSchema = z
  .object({
    defaultProjectKey: z.string().min(1).optional(),
    defaultBoardId: z.number().int().positive().optional(),
    fields: z
      .record(z.array(z.string().min(1)).min(1))
      .default({})
      .transform((f) => ({ ...DEFAULT_FIELDS, ...f })),
    listFields: z.array(z.string().min(1)).default(["storyPoints", "sprint", "components"]),
    blocked: z
      .object({
        statuses: z.array(z.string()).default([]),
        automationStatus: z.array(z.string()).default([]),
        flagged: z.boolean().default(true),
        blockedByLink: z.boolean().default(true),
      })
      .strict()
      .default({}),
    cycleTime: z
      .object({
        start: z.array(z.string()).min(1).default(["In Progress"]),
        end: z.array(z.string()).min(1).default(["Done", "Closed"]),
      })
      .strict()
      .default({}),
    templatesFile: z.string().default("./templates.json"),
  })
  .strict();

export type Settings = z.output<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});
