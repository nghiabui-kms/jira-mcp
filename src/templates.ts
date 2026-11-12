import { z } from "zod";

const templateSchema = z
  .object({
    extends: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    issueType: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).optional(),
    components: z.array(z.string().min(1)).optional(),
    assignee: z.string().min(1).optional().describe('accountId or "me"'),
    parent: z.string().min(1).optional(),
    fields: z.record(z.unknown()).optional(),
    description: z.string().optional(),
  })
  .strict();

export const templatesSchema = z.record(templateSchema);

export type Template = z.output<typeof templateSchema>;
export type Templates = z.output<typeof templatesSchema>;
export type ResolvedTemplate = Omit<Template, "extends">;

/** Follows the `extends` chain (root first) and merges it into one template. */
export function resolveTemplate(all: Templates, name: string): ResolvedTemplate {
  const chain: Template[] = [];
  const seen: string[] = [];
  for (let cur: string | undefined = name; cur !== undefined; cur = all[cur].extends) {
    if (seen.includes(cur)) throw new Error(`Template cycle: ${[...seen, cur].join(" -> ")}`);
    if (!Object.hasOwn(all, cur)) {
      throw new Error(
        seen.length
          ? `Template "${seen[seen.length - 1]}" extends unknown template "${cur}"`
          : `Unknown template "${cur}". Available: ${Object.keys(all).join(", ") || "(none)"}`,
      );
    }
    seen.push(cur);
    chain.unshift(all[cur]);
  }
  return chain.reduce<ResolvedTemplate>((acc, t) => {
    const { extends: _parent, ...rest } = t;
    return merge(acc, rest);
  }, {});
}

/** Later values override; labels and components are unioned; fields are merged by key. */
export function merge(base: ResolvedTemplate, over: ResolvedTemplate): ResolvedTemplate {
  const union = (a?: string[], b?: string[]) => (a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined);
  const defined = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined));
  const out: ResolvedTemplate = { ...base, ...defined };
  const labels = union(base.labels, over.labels);
  const components = union(base.components, over.components);
  if (labels) out.labels = labels;
  if (components) out.components = components;
  if (base.fields || over.fields) out.fields = { ...base.fields, ...over.fields };
  return out;
}
