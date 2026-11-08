/** Health endpoint payload — §15.1 SPEC. */

import { processMemory, sha256Text, type CommandIsolation } from "@nouride/runtime";
import { EVENT_PROTOCOL_VERSION, type GatewayStatus } from "@nouride/shared";
import type { DaemonContext } from "@/commons/context.ts";
import { VERSION } from "@/cli/version.ts";
import { EDITION } from "@/commons/build.ts";

/**
 * A write-ahead log past this many megabytes is an issue, and the daemon reports degraded. `[health]
 * wal_warn_threshold_mb` until 0.8.0, which nobody tuned — a fixed value now (`config/global/gone-keys.ts`).
 *
 * A large uncheckpointed WAL is also a backup trap: `nouride.db`, `-wal` and `-shm` are copied together or the copy is
 * not the database.
 */
const WAL_WARN_MB = 100;

export interface HealthPayload {
  /** `starting` from the moment the port is bound until boot is done — always a 503, so a probe waits for it. */
  status: "starting" | "ok" | "degraded" | "shutting_down";
  /** While starting: what boot is doing — "connecting MCP servers". The one thing a box that takes a while can say. */
  phase?: string;
  uptime: number;
  version: string;
  /** The event stream's contract version (`docs/EVENTS.md`) — what a reader compares before it follows the stream. */
  eventProtocol: string;
  /**
   * Which build this is — `basic`, `router`, `pro`, or `unknown` for a
   * source checkout.
   *
   * Beside the version because the two answer one question together and neither answers it
   * alone: "what is deployed here". Two boxes on the same version can differ in whether they
   * have WhatsApp compiled in and whether they can do Nouverse sign-in, and until this line
   * existed the only way to tell them apart was to grep the binary.
   */
  edition: string;
  /**
   * Whether this daemon is a paired Nouride Box: a Pro build with the appliance identity it was
   * flashed with. The same Pro edition runs in a pod too, so the edition cannot say it — and the
   * dashboard shows My Box only where there is a box.
   */
  appliance: boolean;
  agents: number;
  /**
   * Which install this daemon is, as a hash of its data directory.
   *
   * The port is a fixed default, so every install on a machine competes for it — and a CLI run from the
   * wrong directory reaches whichever daemon won, reads its own install's token, and gets a 401 that
   * reads like a corrupted token. Comparing this tells the CLI it is talking to a stranger.
   *
   * Hashed, not the path: `/health` needs no token, and a filesystem layout is not something to hand to
   * anything that can reach the port. A hash still compares.
   */
  install: string;
  gateways: Record<string, GatewayStatus>;
  /**
   * The daemon's own memory at this request, in bytes — `processMemory` in `@nouride/runtime`.
   *
   * Nothing reported it before 0.7.11, so the footprint `docs/SYSTEM_REQUIREMENTS.md` publishes could only be checked
   * with a shell on the box. Read on every request rather than sampled, so a probe sees what is true now, the boot
   * peak included while `status` is `starting`.
   */
  memory: { rssBytes: number; heapUsedBytes: number };
  /**
   * Whether agents' commands run in a cgroup of their own, capped below the daemon's (0.7.19, `isolateCommands`): what
   * stands between a build that eats the machine and a daemon that stops answering. `doctor` says it. Absent before.
   */
  commands?: CommandIsolation;
  /**
   * How agents' commands reach their own users (0.8.0, `boot/agent-users.ts`): through the helper's socket, in the
   * daemon's own process (a Box), or not at all. `doctor` reads it against what it finds itself: a daemon running its
   * agents' commands through a socket that is gone is one whose every command fails. Absent before.
   */
  agentUsers?: { through: "socket" | "local" | null; reason: string };
  issues?: string[];
  /**
   * The packs that did not load, by id — absent when none failed. A daemon with no agent answering looked healthy
   * to every probe. Reported, not a status: an update that rolled back over it could not undo the migration it ran.
   */
  failedAgents?: string[];
}

export interface HealthResult {
  payload: HealthPayload;
  /** 503 when degraded, so an orchestrator's probe reflects reality. */
  httpStatus: 200 | 503;
}



/**
 * Short enough to eyeball in a log line, long enough that two installs on one machine will not collide.
 * Shared with the CLI, which recomputes it from its own config — so this function is the contract and
 * both sides must truncate identically.
 */
export function installFingerprint(dataDir: string): string {
  return sha256Text(dataDir).slice(0, 12);
}

/**
 * What `/health` says before boot has a `DaemonContext` to read — `web/server.ts` answers with it from the moment
 * the port is bound. The fields a probe and the CLI compare are all here: which install, which version, which
 * build. What is not known yet — agents, gateways — is empty rather than guessed.
 */
export function startingHealth(dataDir: string, startedAt: number, phase: string, readMemory: () => HealthPayload["memory"] = processMemory): HealthResult {
  return {
    payload: {
      status: "starting",
      phase,
      edition: EDITION,
      appliance: false,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      version: VERSION,
      eventProtocol: EVENT_PROTOCOL_VERSION,
      agents: 0,
      install: installFingerprint(dataDir),
      gateways: {},
      memory: readMemory(),
    },
    httpStatus: 503,
  };
}

/**
 * A gateway that is reconnecting is degraded, not down: messages are buffered and
 * the daemon is still serving. One that hit its retry ceiling, or lost its session,
 * needs a human — that is what warrants a failing probe.
 */
export function buildHealth(ctx: DaemonContext, readMemory: () => HealthPayload["memory"] = processMemory): HealthResult {
  // The app is in place a moment before boot calls itself ready, and nothing in that moment is ready to be read.
  if (ctx.status === "starting") return startingHealth(ctx.config.daemon.dataDir, ctx.startedAt, "starting the control plane", readMemory);
  const gateways: Record<string, GatewayStatus> = {};
  const issues: string[] = [];

  for (const [name, gateway] of ctx.gateways) {
    if (gateway.internal) continue;
    gateways[name] = gateway.status;
    if (gateway.status === "dead") issues.push(`${name}: dead`);
    else if (gateway.status === "reconnecting") issues.push(`${name}: reconnecting`);
    else if (gateway.status === "disconnected") issues.push(`${name}: disconnected`);
  }

  const walMb = ctx.db.walSizeBytes() / (1024 * 1024);
  if (walMb > WAL_WARN_MB) {
    issues.push(`sqlite wal ${Math.round(walMb)}MB exceeds threshold`);
  }

  const PROVIDER_FAIL_THRESHOLD = 3;
  for (const [provider, failures] of ctx.providerErrors) {
    if (failures >= PROVIDER_FAIL_THRESHOLD) {
      issues.push(`provider ${provider}: ${failures} consecutive failures`);
    }
  }

  // A journal write that failed: the daemon still answers, but a crash now loses more of a turn than it should,
  // and the next one says less about what ran. An issue rather than a status — a restart does not empty a full disk.
  const journal = ctx.journal?.failures();
  if (journal && journal.count > 0) {
    issues.push(`turn journal: ${journal.count} write(s) failed since start, the last at ${new Date(journal.lastAt ?? 0).toISOString()}`);
  }

  // Rows the event stream could not write: a follower is missing them, and nothing else says so on a default install.
  const lostRows = ctx.events?.dropped() ?? 0;
  if (lostRows > 0) issues.push(`event stream: ${lostRows} row(s) not recorded since start`);

  // A compaction or a memory pass whose model failed in the last day, or a helper model the agents' own stood in for:
  // each was a `warn` in the journal and nowhere else, and a conversation went uncompacted all afternoon (2026-10-21).
  // Read from the stored log, so a restart does not hide it. Not `degraded` — every message is still answered.
  issues.push(...(ctx.helpers?.() ?? []).map((trouble) => trouble.issue));

  // An appliance reports its own problems: a license naming different hardware, or one that does
  // not verify. Neither is fatal — the box answers messages either way — so they are issues rather
  // than a status, and the degraded rule below deliberately does not read them.
  issues.push(...(ctx.appliance?.report().issues ?? []));

  const shuttingDown = ctx.status === "shutting_down";
  const providerDown = [...ctx.providerErrors.values()].some((n) => n >= PROVIDER_FAIL_THRESHOLD);
  const degraded = issues.some((i) => i.endsWith("dead")) || walMb > WAL_WARN_MB || providerDown;
  // Named, and deliberately not read by `degraded`: the update's confirmation and Docker's healthcheck go on as before.
  const failedAgents = ctx.agents?.failed() ?? [];

  return {
    payload: {
      status: shuttingDown ? "shutting_down" : degraded ? "degraded" : "ok",
      edition: EDITION,
      appliance: Boolean(ctx.appliance),
      uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
      version: VERSION,
      eventProtocol: EVENT_PROTOCOL_VERSION,
      agents: ctx.agents?.active() ?? ctx.agentCount,
      install: installFingerprint(ctx.config.daemon.dataDir),
      gateways,
      memory: readMemory(),
      ...(ctx.commands ? { commands: ctx.commands } : {}),
      ...(ctx.agentUsers ? { agentUsers: ctx.agentUsers } : {}),
      ...(issues.length > 0 ? { issues } : {}),
      ...(failedAgents.length > 0 ? { failedAgents } : {}),
    },
    httpStatus: shuttingDown || degraded ? 503 : 200,
  };
}
