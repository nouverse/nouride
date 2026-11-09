/**
 * The daemon's wiring, passed explicitly to whatever needs it.
 *
 * Not a service locator and deliberately not a global: modules take a
 * `DaemonContext` (or, better, the two fields they actually use) as an argument.
 * That keeps tests able to construct one and keeps the dependency direction
 * readable at every call site.
 */

import type { Gateway, GlobalConfig } from "@nouride/shared";
import type { CommandIsolation, SqliteDb } from "@nouride/runtime";
import type { ApplianceRunner } from "nouride-appliance";

export type DaemonStatus = "starting" | "ready" | "degraded" | "shutting_down";

export interface DaemonContext {
  readonly config: GlobalConfig;
  readonly db: SqliteDb;
  /** Keyed by gateway instance id (`telegram:nouva`). */
  readonly gateways: Map<string, Gateway>;
  readonly startedAt: number;
  /** Absolute path the config was read from, or null when running on defaults. */
  readonly configSource: string | null;
  status: DaemonStatus;
  /**
   * The database check this boot ran, or the one a clean stop let it skip — carried into the marker this run
   * leaves at its own clean stop (`boot/integrity.ts`). Absent in tests that build a context by hand.
   */
  readonly integrity?: { ok: boolean; checkedAt: number };
  /** Populated in Phase 1 by the agent registry — the count at boot; `agents` is the live one, where there is a registry. */
  agentCount: number;
  /**
   * The agent registry as `/health` reads it: how many answer, and which packs did not load — live, so a pack fixed
   * and reloaded leaves the probe at once. Absent in a context a test builds.
   */
  readonly agents?: { active(): number; failed(): string[] };
  /** Tracks consecutive LLM failures per provider profile for health reporting. */
  readonly providerErrors: Map<string, number>;
  /** The turn journal's failed writes since boot (`modules/turns/journal.store.ts`), for `/health`. Absent in tests. */
  readonly journal?: { failures(): { count: number; lastAt: number | null } };
  /** The event stream's lost rows, for `/health` (`events.store.ts`). */
  readonly events?: { dropped(): number };
  /**
   * What compaction and the memory pass ran into with their models in the last day, for `/health`
   * (`modules/llm/helper-trouble.ts`) — each as the line it says there. Absent in a context a test builds.
   */
  readonly helpers?: () => readonly { issue: string }[];
  /** Whether agents' commands run in a cgroup of their own, below the daemon's (`isolateCommands`), for `/health`. */
  readonly commands?: CommandIsolation;
  /** How agents' commands reach their own users, as boot found it (`boot/agent-users.ts`), for `/health`. */
  readonly agentUsers?: { through: "socket" | "local" | null; reason: string };
  /**
   * External MCP connections, held so shutdown can close them.
   *
   * On the context rather than passed through `drain`'s parameter list for one reason: every child
   * process this daemon spawned has to be reaped, and a subsystem only some callers know about is one
   * that gets left running.
   */
  mcp?: { close(): Promise<void> };
  /**
   * The daemon's periodic sweeps — retention, backups, the disk check.
   *
   * Held so shutdown can stop them. They are `unref`'d, so they never keep the process alive, and
   * that was taken as enough: it is not. Shutdown has a whole sequence to run before the process
   * ends, and a sweep that fires inside that window touches a database that is closing. That is the
   * failure `approvals.shutDown()` exists for, arrived at from the other direction.
   */
  readonly backgroundTimers: ReturnType<typeof setInterval>[];
  /**
   * This install's hardware identity, when it is a paired Nouride Box.
   *
   * Absent on every ordinary install — and absent from the *binary* on every edition but
   * Pro, which is why the type comes from an ambient declaration rather than from a module
   * the engine imports. `/health` reads it; nothing else in the daemon depends on it.
   */
  appliance?: Pick<ApplianceRunner, "report" | "handle">;
}
