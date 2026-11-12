# Task: Enhance jira-mcp (remote Jira Cloud MCP server)

## Context

- This repo is a remote MCP server for Jira Cloud: TypeScript, `@modelcontextprotocol/sdk` 1.x, Express, Streamable HTTP in stateless mode. Read `README.md` and everything under `src/` before planning.
- Keep the existing architecture:
  - `jira/auth.ts`: `JiraAuth` interface. Must stay the only auth seam, because OAuth 3LO comes later.
  - `jira/client.ts`: fetch wrapper with 429 retry and readable errors.
  - `jira/adf.ts`, `jira/format.ts`.
  - `tools/*`: every tool is registered through `defineTool()` in `tools/context.ts`, which handles READ_ONLY gating and maps errors to `isError` results.
  - `assertWritable()`: enforces ALLOWED_PROJECTS.
- Users: a QA automation team of about 8 people.
  - Main project `AUTOKAT`, Scrum board `2092` (team "Katalon PSA (Titan)"), 2-week sprints.
  - Issue types: Epic, Story, Bucket Story, Task, Sub-task.
- The team relies on these fields. The names below are as shown in Jira; their IDs are unknown and must be discovered at runtime:
  - Story Points
  - Sprint
  - Team
  - Automation Status: Automated / Maintenance / Ready for Automation / Blocked / N/A / Obsoleted
  - Work type: New implementation / Maintenance / Technical work / Support & analysis
  - Components, Labels, Priority (P1–P4)
  - Original Estimate / time tracking
  - Flagged

## Ground rules

- **APIs:** Jira Cloud REST v3 and Agile 1.0 only.
  - Verify every endpoint against the official Atlassian docs instead of guessing.
  - Search must use `POST /rest/api/3/search/jql` with `nextPageToken`. The old `/rest/api/3/search` has been removed.
- **Backward compatibility:** the existing 16 tool names and their parameters must keep working.
- **No deletion:** no tool deletes issues, sprints, boards or projects.
- **Write tools:**
  - Use `write: true` in `defineTool`.
  - Call `assertWritable` for every affected issue or project before writing anything.
  - Respect READ_ONLY.
- **Output size:** return compact JSON, paginate and cap list sizes, and never return raw Jira JSON.
- **Dependencies:** no new runtime dependencies without a stated reason. Dev dependencies are fine (add vitest).
- **Types:** strict TypeScript. No new `any`; the existing documented cast in `defineTool` stays.
- **Fan-out:** when making per-issue calls, keep at most 5 requests in flight. Write a small local helper for this rather than adding a library.
- **Tool descriptions:** short and specific. Say what the tool does, its limits and key parameters. Avoid long prose, because the tool count will be around 40.

## Working mode

1. Read the codebase. Reply with a short plan: the files to add or change in each phase, plus any open questions. Wait for my OK.
2. Implement phase by phase. After each phase:
   - run `npm run typecheck && npm test && npm run build`;
   - update the README tool table;
   - give a short summary;
   - wait for my OK before starting the next phase.

---

## Phase 1: Foundation (everything else depends on this)

### 1.1 Config file

Add `jira-mcp.config.json`:
- Path comes from env `CONFIG_FILE`, defaulting to `./jira-mcp.config.json`.
- Ship `jira-mcp.config.example.json` with the repo.
- Validate it with zod.
- Re-read it when its mtime changes, so no restart is needed.

```json
{
  "defaultProjectKey": "AUTOKAT",
  "defaultBoardId": 2092,
  "fields": {
    "storyPoints": ["Story Points", "Story point estimate"],
    "sprint": ["Sprint"],
    "team": ["Team"],
    "automationStatus": ["Automation Status"],
    "workType": ["Work type"],
    "flagged": ["Flagged"]
  },
  "listFields": ["storyPoints", "sprint", "components", "automationStatus", "workType"],
  "blocked": {
    "statuses": ["Refinement"],
    "automationStatus": ["Blocked"],
    "flagged": true,
    "blockedByLink": true
  },
  "cycleTime": { "start": ["In Progress"], "end": ["Done", "Closed"] },
  "templatesFile": "./templates.json"
}
```

Each logical key maps to a list of candidate field names. An entry may also be a raw ID such as `customfield_10016`.

### 1.2 Field registry (`jira/fields.ts`)

**Resolution**
- Load fields from `GET /rest/api/3/field` and cache them for 10 minutes.
- Resolve a name or ID to `{ id, name, schema }`, case-insensitively.
- If a name matches several IDs, return an error that lists the candidates. The user can then pin the ID in the config.

**Writing values, chosen by schema**

| Schema | Written as |
|---|---|
| number, string | as given |
| option | `{ value }` |
| array of option | `[{ value }]` |
| array of string (labels) | `["..."]` |
| user | `{ accountId }`, accepting `"me"` |
| components | `[{ name }]` |
| versions | `[{ name }]` |
| priority | `{ name }` |
| sprint | sprint id (number) |
| Atlassian Team field | team id. Check `schema.custom`. If only a name is given and it cannot be resolved, return an error asking for the id. |
| unknown schema | raw value passed through |

**Reading values, for output**
- option → its value
- user → displayName
- arrays → mapped item by item
- sprint → `[{ id, name, state }]`
- team → its name
- ADF → text

### 1.3 Richer issue output

- `search_issues`, `get_issue`, `get_sprint_issues` and every new list tool include the configured `listFields` plus `flagged`. Key them by logical name (`storyPoints`, `sprint`, `components`, `automationStatus`, `workType`, `team`).
- Add an optional `fields: string[]` parameter (names or IDs) that adds more fields to the output.
- `get_issue` also returns:
  - originalEstimate, timeSpent and remainingEstimate;
  - fixVersions;
  - every configured field;
  - the `id` of each issue link.

### 1.4 Write fields by name

- `create_issue` / `update_issue`: add a `fields: Record<string, unknown>` parameter. Keys can be the display name, the logical key or the field ID; values are converted through the registry. Keep `extraFields` as a raw passthrough.
- `update_issue` also gains:
  - `originalEstimate` and `remainingEstimate` (Jira durations), mapped to `timetracking`;
  - `components` (list of names, replaces the current list);
  - `addLabels` / `removeLabels` via `update` operations. The existing `labels` parameter still replaces the whole list.

### 1.5 Metadata tools (read-only)

- `list_fields(query?)`: returns id, name, type and custom.
- `get_create_meta(projectKey, issueType)`: returns required fields and their allowedValues.
  - Use `GET /rest/api/3/issue/createmeta/{project}/issuetypes` and then `.../issuetypes/{id}`.
  - Also use this to enrich the error message when `create_issue` fails with a 400 for missing fields.
- `list_project_components(projectKey)`.
- `list_project_versions(projectKey)`, with unreleased versions first.

### 1.6 ADF upgrade (`jira/adf.ts`)

- **Write (Markdown → ADF):**
  - headings `#` to `######`;
  - `**bold**`, `*italic*` / `_italic_`, `` `code` ``;
  - `[text](url)` and bare URLs as links;
  - mentions written as `@[accountId]`, which become mention nodes (document this syntax in the tool descriptions);
  - simple tables `| a | b |`;
  - one level of nested lists.
- **Read (ADF → Markdown):** render the same constructs back to Markdown.
- **Tests:** cover both directions plus a round-trip.

### 1.7 Task templates

- `templates.json`:
  - path comes from the config;
  - validated with zod;
  - reloaded when the file changes.
- A template can set:
  - project, issueType, labels, components;
  - assignee (`"me"` allowed), parent;
  - `fields` (by name);
  - `description` (a Markdown skeleton of sections);
  - `extends`: a single parent template. Detect cycles.
- `create_issue` gains a `template` parameter. Merge order:
  1. Walk the `extends` chain.
  2. Explicit arguments override template values.
  3. labels and components are the union of template and arguments.
  4. If a description is passed, use it; otherwise use the template's.
- `list_templates()`: returns each template's name, its resolved values and its description skeleton, so the model can fill in the sections.
- Templates are edited by people in git only. Do not add a write tool for templates. Ship `templates.example.json` with 2 realistic examples (an IFS script task and a maintenance task).

---

## Phase 2: Backlog, links, sprint insight

### 2.1 Backlog and ranking

- `get_backlog(boardId?, jql?, maxResults, startAt)`:
  - uses `GET /rest/agile/1.0/board/{id}/backlog`;
  - includes points;
  - returns totals: item count, points, and number of unestimated items.
- `rank_issues(issueKeys ≤ 50, before | after)`: uses `PUT /rest/agile/1.0/issue/rank`.
- `move_issues_to_backlog(issueKeys ≤ 50)`: uses `POST /rest/agile/1.0/backlog/issue`.

### 2.2 Issue links

- `list_link_types()`.
- `link_issues(type, fromKey, toKey, comment?)`:
  - uses `POST /rest/api/3/issueLink`;
  - accepts the link type name or its inward/outward phrase (for example "is blocked by");
  - maps the phrase to the correct inward/outward direction.
- `remove_issue_link(linkId)`: set `destructiveHint` to true.

### 2.3 Sprint summary and velocity

**`get_sprint_summary(sprintId?)`**
- With no `sprintId`, use the active sprint of `defaultBoardId`.
- Totals:
  - committed points and items;
  - done (statusCategory = done) and remaining.
- Breakdowns:
  - by status;
  - by assignee: items, points, done points;
  - by workType.
- Lists:
  - unestimated items;
  - blocked items, using the `config.blocked` rules.
- Scope change:
  - items added after the sprint started, and items removed, read from the Sprint field in the changelog;
  - use `POST /rest/api/3/changelog/bulkfetch` if it is available, otherwise fetch per issue with concurrency 5;
  - carried-in items: issues whose Sprint field contains an earlier closed sprint.
- Optional: when env `USE_GREENHOPPER=true`, use `/rest/greenhopper/1.0/rapid/charts/sprintreport` (undocumented API) for committed and punted issues. Otherwise use public APIs only.

**`get_velocity(boardId?, lastN = 6)`**
- For each closed sprint: committed vs completed points, using the same calculation as above.
- Return the average as well.

---

## Phase 3: Sprint management, history, time, epics, bulk, filters

### 3.1 Sprint management

- `create_sprint(boardId?, name, startDate?, endDate?, goal?)`: uses `POST /rest/agile/1.0/sprint`.
- `update_sprint(sprintId, name?, startDate?, endDate?, goal?)`: uses `POST /rest/agile/1.0/sprint/{id}` (partial update).
- `start_sprint(sprintId, startDate?, endDate?)`: sets state to active. Dates are required.
- `close_sprint(sprintId, moveIncompleteTo: sprintId | "backlog", confirm: boolean)`:
  - When `confirm` is false: return a preview of the incomplete issues and change nothing.
  - When `confirm` is true: first move the incomplete issues explicitly, then set the state to closed.
  - Set `destructiveHint` to true.
  - Check in the docs how the API itself treats incomplete issues on close, and handle that explicitly.

### 3.2 Changelog and cycle time

- `get_issue_history(issueKey, fields?)`:
  - uses `GET /rest/api/3/issue/{key}/changelog`, paginated;
  - returns compact entries `{ when, who, field, from, to }`.
- `get_cycle_time(jql, maxIssues = 200)`:
  - for each issue, measure from the first entry into a `config.cycleTime.start` status to the last entry into a `config.cycleTime.end` status;
  - return median, p85 and average, plus the slowest N issues;
  - use the bulk changelog fetch where available.

### 3.3 Time report

- `get_time_report(from, to, jql?, groupBy: "author" | "issue" | "component" | "week" | "epic")`.
- Steps:
  1. Find issues with JQL `worklogDate >= from AND worklogDate <= to`, plus the user's JQL; default to the default project.
  2. For each issue, fetch worklogs with `startedAfter` / `startedBefore` in milliseconds.
  3. Keep only entries strictly inside the window.
  4. Aggregate hours by the chosen group.
- Cap at 300 issues and report when the result was truncated.
- With `groupBy: "issue"`, include original estimate vs time spent.

### 3.4 Epics

- `list_epics(jql?, component?, automationStatus?, team?, maxResults)`: issue type Epic plus the given filters.
- `get_epic_progress(epicKeys ≤ 50)`:
  - fetch children with a single JQL `parent in (...)`, paginated;
  - for each epic return: children count by statusCategory, total and done points, % done, and unestimated children.

### 3.5 Bulk update

- `bulk_update_issues(issueKeys ≤ 50 | jql, changes, dryRun = true)`:
  - `jql` may return at most 50 issues; reject anything larger.
  - `changes` can contain `fields`, `addLabels`, `removeLabels`, `assignee`, `transition`.
- With `dryRun` (the default): return current vs new values for each issue, and write nothing.
- When applying:
  - run `assertWritable` for all issues before any write;
  - process issues with concurrency 5;
  - return `{ key, ok, error? }` for each issue.

### 3.6 Saved filters

- `list_filters(query?, favouritesOnly?)`: uses `GET /rest/api/3/filter/search?expand=jql`, or `/rest/api/3/filter/favourite`.
- `run_filter(filterId, maxResults, nextPageToken)`: resolve the filter's JQL and reuse the `search_issues` logic.

---

## Tests (vitest)

- Mock `fetch` with a small fake router. No network access.
- Cover:
  - field resolution and value conversion for each schema type;
  - ADF write, read and round-trip;
  - template merge, `extends`, and cycle detection;
  - sprint summary maths: scope change, carried-in, blocked rules;
  - cycle time calculation;
  - time report window filtering;
  - bulk update dryRun vs apply, and that `assertWritable` runs before any write;
  - `close_sprint` preview vs confirm.
- Smoke tests:
  - `tools/list` returns every tool;
  - `READ_ONLY=true` hides every write tool.

## Docs

Update the README with:
- A tool table grouped as Issues, Fields & metadata, Templates, Backlog & sprints, Reports, Bulk, Filters.
- How the config file and templates work.
- Example prompts.
- Safety notes: `dryRun`, `confirm`, READ_ONLY, ALLOWED_PROJECTS.
- A troubleshooting section, including: "connector only shows read tools → check READ_ONLY and the connector's tool permissions in claude.ai".
- A manual verification checklist against real Jira:
  1. Run `list_fields` and pin field IDs in the config.
  2. Run `get_sprint_summary` on board 2092.
  3. Run `create_issue` with a template in a sandbox project.

## Out of scope

- Zephyr test cases
- Katalon execution, RCA and flaky-test data
- Planning Tool data
- OAuth 3LO and Cloudflare Workers deployment
- Attachments
- Deleting issues or sprints

## Definition of done

- `npm run typecheck`, `npm test` and `npm run build` all pass.
- The README is updated.
- Existing tools behave as before.
