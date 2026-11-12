import { readFileSync, statSync } from "node:fs";
import type { z } from "zod";

/**
 * Returns a getter for a zod-validated JSON file that re-reads the file when its mtime changes.
 * Missing file -> fallback. Invalid file -> keeps the last valid value (logged), or throws if there is none.
 */
export function watchedJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  fallback: z.output<S>,
): () => z.output<S> {
  let mtime = -1;
  let value: z.output<S> | undefined;
  let error: Error | undefined;

  return () => {
    let current: number;
    try {
      current = statSync(path).mtimeMs;
    } catch {
      return fallback;
    }
    if (current !== mtime) {
      mtime = current;
      try {
        const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        if (!parsed.success) {
          throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
        }
        value = parsed.data;
        error = undefined;
      } catch (err) {
        error = new Error(`Invalid ${path}: ${err instanceof Error ? err.message : String(err)}`);
        console.error(error.message + (value !== undefined ? " (keeping the last valid version)" : ""));
      }
    }
    if (value !== undefined) return value;
    throw error ?? new Error(`Cannot read ${path}`);
  };
}
