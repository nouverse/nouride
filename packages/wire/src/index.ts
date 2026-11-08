/**
 * `@nouride/wire` — what the control API sends and takes, as types: the engine's routes and the dashboard both import
 * them, so a payload changed on one side fails the other's typecheck (ARCHITECTURE.md §3).
 *
 * Types only. Nothing here exists at runtime, and the dashboard imports it with `import type` alone (`check-arch.ts`
 * holds both), so no daemon code reaches the browser through it. It may name the types of `@nouride/shared` and
 * `@nouride/acp`, which are the daemon's own words, and nothing else.
 *
 * A field is optional, and its absence read as what a daemon older than the field meant, though the dashboard ships in
 * the same tarball as the daemon: an update swaps `dashboard/` at once and restarts the daemon only once it is idle
 * (`apps/engine/src/modules/update/self-update.ts`) — minutes behind a turn, hours behind a background job — and the
 * engine serves those files from disk on every request, so a reload in between runs the new page against the old
 * daemon. Those fallbacks are not dead; a new field gets one too.
 */

export type * from "./access.ts";
export type * from "./advisories.ts";
export type * from "./agent-tools.ts";
export type * from "./agents.ts";
export type * from "./appliance.ts";
export type * from "./approvals.ts";
export type * from "./chat.ts";
export type * from "./cron.ts";
export type * from "./external-agents.ts";
export type * from "./groups.ts";
export type * from "./jobs.ts";
export type * from "./knowledge.ts";
export type * from "./logs.ts";
export type * from "./look.ts";
export type * from "./mcp.ts";
export type * from "./mcp-catalog.ts";
export type * from "./mcp-library.ts";
export type * from "./mcp-server.ts";
export type * from "./memory.ts";
export type * from "./missions.ts";
export type * from "./notes.ts";
export type * from "./people.ts";
export type * from "./secrets.ts";
export type * from "./settings.ts";
export type * from "./skills.ts";
export type * from "./status.ts";
export type * from "./tiers.ts";
export type * from "./tool-budget.ts";
export type * from "./turns.ts";
export type * from "./update.ts";
export type * from "./web-search.ts";
