/**
 * A coding CLI updated, and the way back (0.8.24). `nouride agents update <cli>`
 * holds the CLI here — no new turn starts in it — and waits until none runs; installs the version through the shared
 * tools folder, as `nouride tools run` does; then asks here for the check: the CLI started again for the first of its
 * agents, and the new version's handshake read for what Nouride uses (`handshakeProblem`: steering, the presets' modes;
 * the protocol is refused at `initialize`). A failed check leaves only that CLI's agents unavailable, with the version
 * before — the last that passed, recorded — offered back. The CLIs' own updaters stay off (`CliRow.env`, `profileFiles`).
 *
 * A version is checked whenever it first starts, not only after an update: one installed by hand is held to the same.
 */

import { handshakeProblem, type CliRow } from "@nouride/acp";
import { createLogger, type LoadedAgent } from "@nouride/shared";
import { signedOut, type CliConnection } from "./connection.ts";

const log = createLogger("external-agents");

/** The version of each CLI that last passed the check, by CLI id. */
type Versions = { load(): Record<string, string>; save(versions: Record<string, string>): void };

/** What the CLIs' service lends an update. */
export interface UpdateHost {
  /** The CLIs running now, by agent. */
  runningEntries(): [string, CliConnection][];
  /** Whether a running CLI is in the middle of something: a prompt, a turn holding it, a command it left running. */
  occupied(connection: CliConnection): boolean;
  stopAgent(agentId: string): Promise<void>;
  connection(agent: LoadedAgent): Promise<CliConnection>;
  setUnavailable(agentId: string, reason: string | null): void;
  /** Drop the scan kept for a minute: after an update it says the version before (seen on the e2e VM's Models page). */
  forgetScan(): void;
  versions?: Versions;
}

export interface UpdateChecked {
  cli: string;
  passed: boolean;
  /** The version its handshake gave, where it started. */
  version?: string;
  problem?: string;
  /** The version before: the last that passed, offered back. */
  before?: string;
}

/**
 * How long a hold outlives the command that took it: the ten minutes it waits for a turn, an install's few, and room to
 * spare. A command cut off between its hold and its check (an agent's `nouride` call, at its 30 seconds, on the live box
 * on 2026-11-08) left the CLI's agents held, "being updated", until the daemon restarted.
 */
const HOLD_LIMIT_MS = 30 * 60_000;

export class CliUpdates {
  /** The CLIs held for an update, with when the hold was first taken. */
  private readonly holding = new Map<string, number>();
  /** The CLIs whose version failed its check, with the version before it, by CLI id: the way back the Brain tab offers. */
  private readonly failing = new Map<string, { version: string; before?: string }>();

  constructor(
    private readonly host: UpdateHost,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * What a CLI's new version lacks of what Nouride uses, as the reason its agents cannot answer; null where it passed or
   * where there is no verdict yet. Passed, the version is recorded and not checked again. Signed out, a session cannot
   * open and its modes are no verdict: the steering its handshake said is still read, and the check waits for a sign-in.
   */
  async checkVersion(row: CliRow, connection: CliConnection): Promise<string | null> {
    const versions = this.host.versions;
    const version = connection.info?.agentInfo?.version;
    if (!versions || !version || versions.load()[row.id] === version) return null;
    let modes: string[] | null = null;
    let problem: string | null = null;
    try {
      modes = (await connection.probe(connection.launch.cwd)).modes?.availableModes.map((mode) => mode.id) ?? [];
    } catch (err) {
      if (!signedOut(row, err)) problem = `it did not open a session: ${err instanceof Error ? err.message : String(err)}`;
    }
    problem ??= handshakeProblem(row, connection.info, modes);
    if (problem) {
      const before = versions.load()[row.id];
      this.failing.set(row.id, { version, ...(before ? { before } : {}) });
      return `${row.name} ${version} did not pass Nouride's check: ${problem}. ${before ? `Go back to ${before} (\`nouride agents update ${row.id} ${before}\`)` : "Go back to the version before"}, or update Nouride`;
    }
    if (modes !== null) {
      versions.save({ ...versions.load(), [row.id]: version });
      this.failing.delete(row.id);
      log.info("a CLI's new version passed the check", { cli: row.id, version });
    }
    return null;
  }

  /** The version to go back to, where the CLI's version failed its check and one passed before it; else null. */
  wayBack(cliId: string): string | null {
    return this.failing.get(cliId)?.before ?? null;
  }

  /** Why a turn in this CLI cannot start now — it is being updated — or null. */
  heldFor(row: CliRow): string | null {
    const since = this.holding.get(row.id);
    if (since === undefined) return null;
    if (this.now() - since > HOLD_LIMIT_MS) {
      this.holding.delete(row.id);
      log.warn("a coding CLI's update hold expired, its command never came back: its agents answer again", { cli: row.id });
      return null;
    }
    return `${row.name} is being updated: its agents answer again once that is done, in a minute or two`;
  }

  /** Held: no new turn starts in it. How many of its CLIs still work; at none, they are stopped for the install. */
  async hold(cliId: string): Promise<number> {
    // The first hold's time: the command asks again every two seconds while a turn runs.
    if (!this.holding.has(cliId)) this.holding.set(cliId, this.now());
    const mine = this.host.runningEntries().filter(([, connection]) => connection.row.id === cliId);
    const busy = mine.filter(([, connection]) => this.host.occupied(connection)).length;
    if (busy === 0) for (const [agentId] of mine) await this.host.stopAgent(agentId);
    return busy;
  }

  release(cliId: string): void {
    this.holding.delete(cliId);
  }

  /**
   * After the install: released, and the new version started for the first of its agents, which checks it. Failed, every
   * agent on that CLI is unavailable for the same reason; passed, a reason the version before left goes. With no agent
   * on it, the next one made is checked when it starts.
   */
  async check(cliId: string, agents: readonly LoadedAgent[]): Promise<UpdateChecked> {
    this.release(cliId);
    this.host.forgetScan();
    const before = this.host.versions?.load()[cliId];
    const on = agents.filter((agent) => agent.config.external?.cli === cliId);
    const first = on[0];
    if (!first) return { cli: cliId, passed: true, ...(before ? { before } : {}) };
    try {
      const version = (await this.host.connection(first)).info?.agentInfo?.version;
      for (const agent of on) this.host.setUnavailable(agent.config.id, null);
      log.info("a coding CLI was updated and its check passed", { cli: cliId, version, before });
      return { cli: cliId, passed: true, ...(version ? { version } : {}), ...(before ? { before } : {}) };
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err);
      for (const agent of on) this.host.setUnavailable(agent.config.id, problem);
      log.warn("a coding CLI was updated and its check failed: its agents cannot answer", { cli: cliId, problem, before });
      return { cli: cliId, passed: false, problem, ...(before ? { before } : {}) };
    }
  }
}
