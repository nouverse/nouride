/**
 * Housekeeping that runs at boot and then on a timer: retention, backups, disk.
 *
 * All three share the same shape — do it now, then do it again on an interval — and all three exist
 * because something in this daemon only ever grows. Kept together so "what does this process delete,
 * and how often" has one answer you can read in one sitting.
 *
 * Every timer is `unref`'d: housekeeping must never be the reason the process stays alive.
 */

import { INBOX_KEEP_MS } from "@/modules/pipeline/inbox.store.ts";
import { contained, createLogger, crashDetail } from "@nouride/shared";
import { copyFileAtomic, freeDiskBytes, statFile, truncateFile, type SqliteDb } from "@nouride/runtime";
import type { GlobalConfig } from "@nouride/shared";
import { backupAgents, newestAgentBackupAt, prepareBackupDir } from "@nouride/persona";
import { backupDatabase, newestBackupAt } from "@/db/backup.ts";
import { scheduledBackupDir } from "@/commons/backup-dir.ts";
import { backupKnowledge, backupVault, newestKnowledgeBackupAt, newestVaultBackupAt } from "@/modules/memory/backup.ts";
import { knowledgeDirOf } from "@/modules/memory/index.ts";
import { backupConfig, backupSkillPool, newestSnapshotOf } from "@/modules/config/snapshot.ts";
import { sweepScratchpads } from "@nouride/persona";
import type { ChatEventsPort } from "@/modules/chat-events/chat-events.store.ts";
import type { RoomMessagesPort } from "@/modules/chat-events/room-messages.store.ts";
import type { ChatAttachmentsPort } from "@/modules/attachments/chat-attachments.store.ts";
import type { AttachmentStore } from "@/modules/attachments/store.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { LogsPort } from "@/commons/logs.store.ts";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import type { JobsPort } from "@/modules/jobs/jobs.store.ts";
import type { Notifier } from "@/commons/notify.ts";
import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import type { UploadStore } from "@/modules/web/control/uploads.ts";
import type { ToolOutputSpill } from "@/modules/llm/spill.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import type { DraftsPort } from "@/modules/reflection/drafts.store.ts";

const log = createLogger("daemon");

const DAILY_MS = 24 * 60 * 60_000;

/**
 * Free space in the data directory below which the daemon warns at boot and alerts on the heartbeat, and `nouride
 * doctor` says so: a gigabyte. `[health] disk_warn_threshold_mb` until 0.8.0, which nobody tuned — a fixed value now
 * (`config/global/gone-keys.ts`), as the heartbeat's minute is.
 */
export const DISK_WARN_MB = 1024;

/** How often the heartbeat looks at the disk: a minute. `[health] heartbeat_interval_ms` until 0.8.0. */
const HEARTBEAT_MS = 60_000;

/**
 * How often each kind is snapshotted: weekly, keeping `backup_keep` (four, a month back). Weekly since
 * 2026-11-03: the scheduled snapshot was the largest write the daemon makes, the whole database (69 MB on the live
 * box) copied every day beside the vault and the packs, on a card a Box runs from.
 */
const SNAPSHOT_EVERY_MS = 7 * 24 * 60 * 60_000;

/**
 * A snapshot younger than this at boot is the boot snapshot — see `onSnapshotSchedule`.
 *
 * A week, as the schedule: half a day still snapshotted a box that restarts nightly for its update at every boot.
 * A crash loop (five starts in two minutes before systemd gives up) writes the file once instead of five times.
 */
const BOOT_SNAPSHOT_FRESH_MS = SNAPSHOT_EVERY_MS;

/** How often each kind looks at whether its snapshot is due. */
const SNAPSHOT_CHECK_MS = 60 * 60_000;

/**
 * Free space in the data directory, logged when it is short.
 *
 * Run at boot and on the heartbeat. SQLite writes fail when the filesystem is full, and nothing else
 * in the daemon would tell you which of the many resulting symptoms to look at.
 */
export function checkDisk(config: GlobalConfig): number | null {
  const free = freeDiskBytes(config.daemon.dataDir);
  if (free === null) return null;
  const freeMb = Math.round(free / (1024 * 1024));
  if (freeMb < DISK_WARN_MB) {
    log.error("low disk space in the data directory", {
      free_mb: freeMb,
      threshold_mb: DISK_WARN_MB,
    });
  }
  return freeMb;
}

/**
 * At boot and daily. `retention_days` was a config value that deleted nothing for the whole of
 * Phase 1 — now there are files to delete, so it either works or it should not be in the file.
 */
export function startRetentionSweep(deps: {
  config: GlobalConfig;
  attachments: AttachmentStore;
  usage: UsagePort;
  sessions: SessionsPort;
  /** What each turn did. Same knob as sessions — it is the same history, seen from the other side. */
  turns: TurnsPort;
  /**
   * Things that happened *to* a conversation. Same knob again, for the same reason twice over: an
   * event annotates a conversation, so outliving it would leave a transcript of nothing but notices.
   */
  chatEvents: ChatEventsPort;
  /** What people said in a room. Same knob again — one transcript, three tables. */
  roomMessages: RoomMessagesPort;
  attachmentIndex: ChatAttachmentsPort;
  jobs: JobsPort;
  spill: ToolOutputSpill;
  /** Spare copies of the dashboard's uploads. Their own short window — see `UPLOAD_RETENTION_DAYS`. */
  uploads: UploadStore;
  audit: AuditPort;
  /** Settled approval requests. On the audit knob — see the note at the call site. */
  approvals: { sweep(retentionDays: number, now?: number): number };
  /** The daemon's own log lines. Its own short knob — see `[retention] log_days`. */
  logs: LogsPort;
  cron: CronPort;
  /** Skill drafts. Only *decided* rows are swept — see below. */
  drafts: DraftsPort;
  /** Ended missions — on the sessions knob: each one's page is its conversation's record (`missions.store.ts`). */
  missions?: { sweep(retentionDays: number, now?: number): number };
  /** Settled inbox rows — kept two days, long enough to recognise a redelivery (`pipeline/inbox.store.ts`). */
  inbox?: { sweep(before: number): number };
  /** Memory's change feed — kept ninety days, a window of its own rather than a knob (`memory-state.store.ts`). */
  memoryChanges?: { sweepChanges(now?: number): number };
  /** Work notes: tasks untouched two weeks set aside, the copy kept before a clear dropped after a day (`notes/store.ts`). */
  notes?: { sweep(now?: number): Promise<number> };
  /** The weekly review of the skill library, run when a week has passed since the last (`reflection/curator.ts`). */
  skillReview?: { reviewIfDue(): Promise<unknown> };
}): ReturnType<typeof setInterval> {
  const { config, attachments, attachmentIndex, usage, sessions, turns, chatEvents, roomMessages, jobs, spill, uploads, audit, approvals, logs, cron, drafts } =
    deps;

  /**
   * One store's sweep, on its own: one that throws — a table locked past the busy timeout, a directory gone
   * unreadable — is logged, and the stores after it are swept anyway. Run as one, the first failure skipped every
   * sweep after it, and a store that failed every day would have left the log table and the audit log growing for
   * good; on the timer, the throw ended the daemon.
   */
  const swept = (store: string, sweepOne: () => number): number => {
    try {
      return sweepOne();
    } catch (err) {
      log.error("a retention sweep failed, but the other stores are swept anyway", { store, ...crashDetail(err) });
      return 0;
    }
  };

  const sweep = () => {
    /**
     * Files on the conversation window, which is the same argument the turn store already makes.
     *
     * They had their own knob — `[attachments] retention_days`, seven days against thirty — and the
     * result was a transcript that mentioned a screenshot for another twenty-three days after the
     * screenshot was deleted. The index kept a ref, the ref resolved to nothing, and
     * `attachment_read` answered "no local copy and no way to fetch it again" for a file the
     * conversation was still visibly about.
     *
     * "A transcript and a media file are not the same thing to keep" is what the comment here used to
     * say, and it is true of *size* and false of *lifetime*: a file is part of what was said. Two
     * knobs for one history is how the turn store's own note puts it, and it applies unchanged.
     */
    const removed = swept("attachments", () => attachments.sweep(config.retention.sessionDays).removed);
    if (removed > 0) log.info("old attachments removed", { directories: removed });
    /**
     * Usage on the audit window, not the attachment one.
     *
     * It was on `[attachments] retention_days` — nothing to do with what a provider call cost, and a
     * coincidence of both wanting a number. `[retention] audit_days` is the window for "what did this
     * daemon do and what did it spend", which is the question `llm_usage` answers.
     */
    const usageRows = swept("usage", () => usage.sweep(config.retention.auditDays));
    if (usageRows > 0) log.info("old usage rows removed", { rows: usageRows });

    const staleSessions = swept("sessions", () => sessions.sweep(config.retention.sessionDays));
    if (staleSessions > 0) log.info("stale sessions removed", { rows: staleSessions });
    // On the sessions knob, not its own: a turn record is that conversation's history seen from the
    // other side, and two knobs for one history is how you end up with steps for a transcript that
    // has been deleted.
    const staleTurns = swept("turns", () => turns.sweep(config.retention.sessionDays));
    if (staleTurns > 0) log.info("stale turn records removed", { rows: staleTurns });
    const staleEvents = swept("room events", () => chatEvents.sweep(config.retention.sessionDays));
    if (staleEvents > 0) log.info("stale room events removed", { rows: staleEvents });
    const staleMessages = swept("room messages", () => roomMessages.sweep(config.retention.sessionDays));
    if (staleMessages > 0) log.info("stale room messages removed", { rows: staleMessages });
    // On the sessions knob too: a mission's page is its conversation's record, and outliving it opened onto turns gone.
    const staleMissions = swept("missions", () => deps.missions?.sweep(config.retention.sessionDays) ?? 0);
    if (staleMissions > 0) log.info("ended missions removed", { rows: staleMissions });
    const settledInbox = swept("inbox", () => deps.inbox?.sweep(Date.now() - INBOX_KEEP_MS) ?? 0);
    if (settledInbox > 0) log.info("settled inbox rows removed", { rows: settledInbox });
    // On the sessions knob as well: this is the list of what a conversation contained, so it belongs with the
    // transcript that mentions it — and with the bytes, swept above on the same knob. The two are separate sweeps, so a
    // row can still outlive its file by a day, which is why a read verifies the path and re-fetches instead of
    // trusting it.
    const staleFiles = swept("attachment index", () => attachmentIndex.sweep(config.retention.sessionDays));
    if (staleFiles > 0) log.info("stale attachment index rows removed", { rows: staleFiles });
    // The two directories of transient files the daemon writes and nothing used to delete. Both hold
    // paths an agent may still be carrying, so neither can be cleaned at the end of a turn — which is
    // why they needed a sweep and not a `finally`.
    const jobLogs = swept("job logs", () => jobs.sweepLogs(config.retention.jobLogDays));
    if (jobLogs > 0) log.info("old job logs removed", { jobs: jobLogs });
    const spilled = swept("spilled tool output", () => spill.sweep(config.retention.toolOutputDays));
    if (spilled > 0) log.info("old spilled tool output removed", { conversations: spilled });
    // Not on a configured knob: these are duplicates of files the attachment store already holds, and
    // keeping them for the retention window would keep two of everything anybody ever sent.
    const uploaded = swept("upload copies", () => uploads.sweep());
    if (uploaded > 0) log.info("old upload copies removed", { files: uploaded });
    // Its own count is logged by the store; a failure is one store's, as above.
    void deps.notes?.sweep().catch((err: unknown) => log.error("a retention sweep failed, but the other stores are swept anyway", { store: "work notes", ...crashDetail(err) }));
    void deps.skillReview?.reviewIfDue().catch((err: unknown) => log.error("the weekly skill review failed", crashDetail(err)));
    // The third directory of transient files, and the only one an agent writes itself. Swept here
    // rather than after the turn that made it, because the follow-up message is usually about the
    // file — the screenshot just sent is the thing the next question asks to crop.
    // Each agent's, removed as that agent — a command, so it is waited for apart from the rest, and a failure is its own.
    void sweepScratchpads(config.daemon.workspaceDir, config.retention.scratchpadDays)
      .then((scratched) => {
        if (scratched > 0) log.info("old scratchpad files removed", { files: scratched });
      })
      .catch((err: unknown) => log.error("a retention sweep failed, but the other stores are swept anyway", { store: "scratchpads", ...crashDetail(err) }));
    const auditRows = swept("audit log", () => audit.sweep(config.retention.auditDays));
    if (auditRows > 0) log.info("old audit entries removed", { rows: auditRows });
    /**
     * The log table, on a much shorter knob than the audit one — three days against thirty.
     *
     * They are not the same record. The audit log answers "who made this happen", one row per
     * decision, and is worth keeping. This is every line the daemon printed, and it is worth keeping
     * only as long as somebody might still be diagnosing what it printed them about.
     */
    const logRows = swept("log table", () => logs.sweep(config.retention.logDays));
    if (logRows > 0) log.info("old log entries removed", { rows: logRows });
    /**
     * Settled approvals, on the audit knob — what one records is who allowed what, which is the
     * question `audit_days` already answers for. Pending rows are never touched: an old one is not
     * stale, it is a turn parked on an answer nobody has given yet.
     */
    const approvalRows = swept("approvals", () => approvals.sweep(config.retention.auditDays));
    if (approvalRows > 0) log.info("old approval requests removed", { rows: approvalRows });
    /**
     * Skill drafts that were approved or discarded, on the audit knob — because that is what they
     * are: the record of a decision somebody made.
     *
     * **Pending drafts are never swept.** A proposal that disappeared overnight because nobody got
     * round to it is the one failure the whole approval gate exists to avoid, and it would be
     * invisible from every surface. `DraftStore.sweep` enforces that; this is where it is relied on.
     */
    const decidedDrafts = swept("skill drafts", () => drafts.sweep(config.retention.auditDays));
    if (decidedDrafts > 0) log.info("old skill-draft decisions removed", { rows: decidedDrafts });
    const memoryChanges = swept("memory changes", () => deps.memoryChanges?.sweepChanges() ?? 0);
    if (memoryChanges > 0) log.info("old memory changes removed", { rows: memoryChanges });
    swept("cron runs", () => cron.sweepRuns());
  };

  sweep();
  const timer = setInterval(contained(log, "the daily retention sweep failed", sweep), DAILY_MS);
  timer.unref?.();
  return timer;
}

/**
 * When a scheduled snapshot of one kind is taken — the database, the memory vault, the persona packs, all three alike.
 *
 * At boot, because a daemon that only snapshots after a week of uptime has no snapshot on the day anybody wants one —
 * **unless the newest is younger than `BOOT_SNAPSHOT_FRESH_MS`**. Then "weekly" means a week after the newest, not a
 * week after boot: checked hourly, so a boot that skipped its snapshot does not leave a gap of a week and more.
 *
 * The rule was the database's alone (2026-10-15). The vault and the packs snapshotted on every boot, and each
 * kind's rotation keeps the newest `backup_keep` by name — so three restarts in a crash loop (the unit allows five in
 * two minutes) left three copies of the current state and deleted every older one: of the vault, which only the
 * snapshots hold a second copy of, and of `MEMORY.md`, the one pack file that cannot be rebuilt.
 *
 * A kind looks at most once a day, whatever it found: a failed attempt is not retried within the day — on a full disk
 * each one writes, and then deletes, a whole copy — and a snapshot skipped because nothing changed since the newest
 * is looked at again tomorrow, not a week later: snapshots weekly, but looks daily once one is due (0.8.17).
 */
function onSnapshotSchedule(
  kind: string,
  daemon: GlobalConfig["daemon"],
  newest: (backupDir: string) => number | null,
  /** May hand back the promise of a snapshot still being written, so a failure in it is said like one before it. */
  take: (backupDir: string) => unknown,
  now: () => number,
): ReturnType<typeof setInterval> {
  const where = scheduledBackupDir(daemon, kind);
  // A check comes round every hour, so "a week old" is a week less one check.
  const dueAfter = SNAPSHOT_EVERY_MS - SNAPSHOT_CHECK_MS;
  // Once due, a kind looks once a day: a failure, or nothing to copy, is looked at again tomorrow.
  const lookAgainAfter = DAILY_MS - SNAPSHOT_CHECK_MS;
  let lookedAt = Number.NEGATIVE_INFINITY;

  const snapshotIfOlderThan = (ageMs: number): unknown => {
    const backupDir = where();
    if (backupDir === null) return;
    const at = newest(backupDir);
    if (at !== null && now() - at < ageMs) return;
    if (now() - lookedAt < lookAgainAfter) return;
    lookedAt = now();
    return take(backupDir);
  };

  // At boot as on the hour: a snapshot that cannot be taken — a backup directory gone unreadable — is a line in the
  // log, not a daemon that will not start, nor one that stops.
  const failed = "a scheduled snapshot could not be taken";
  contained(log, failed, () => snapshotIfOlderThan(BOOT_SNAPSHOT_FRESH_MS), { snapshot: kind })();
  const timer = setInterval(contained(log, failed, () => snapshotIfOlderThan(dueAfter), { snapshot: kind }), SNAPSHOT_CHECK_MS);
  timer.unref?.();
  return timer;
}

/**
 * The persona packs. The most likely moment to lose a pack is while somebody is editing it — and an unchanged set is
 * not copied again (`skipUnchanged`), so a week nobody edited one does not push the week before it out.
 */
export function startAgentBackups(config: GlobalConfig, now: () => number = Date.now): ReturnType<typeof setInterval> {
  prepareBackupDir(config.daemon.dataDir);
  return onSnapshotSchedule(
    "persona packs",
    config.daemon,
    (backupDir) => newestAgentBackupAt({ dataDir: config.daemon.dataDir, backupDir }),
    (backupDir) =>
      void backupAgents({ agentsDir: config.daemon.agentsDir, dataDir: config.daemon.dataDir, backupDir, keep: config.daemon.backupKeep, now, skipUnchanged: true }).catch(
        (err: unknown) => log.error("agent backup failed", { error: String(err) }),
      ),
    now,
  );
}

/**
 * The database, for a stronger reason.
 *
 * It holds the conversations, the turn records, usage, the audit log, cron and its runs, approvals, sender access,
 * grants and drafts — and the `.db.bak-*` files on the live box were made by hand, both times because somebody was
 * about to do something risky. Boot is also the moment `integrityCheck` has just run on the live file, so a snapshot
 * taken then is one taken with the original known good.
 *
 * Each snapshot writes the whole file and reads it back to verify it — 62 MB of I/O on the live box's 31 MB file — so
 * one is not taken when nothing was written since the last this process took (`writes`): another copy of the same
 * database is a day of SD-card writes that pushes an older, different copy out of the rotation. What the daemon
 * writes about itself — its log lines, one of which says the snapshot was taken — is not counted.
 *
 * Synchronous inside the callback and deliberately not awaited by the caller: `VACUUM INTO` blocks the database for as
 * long as it takes to write, which on a 26 MB file is well under a second.
 */
export function startDatabaseBackups(
  config: GlobalConfig,
  db: SqliteDb,
  now: () => number = Date.now,
  /** Rows written so far, the daemon's own log lines left out. Absent: every snapshot that is due is taken. */
  writes?: () => number,
): ReturnType<typeof setInterval> {
  /** What `writes` said when this process last took one; unknown until it has. */
  let writtenAtLast: number | null = null;
  return onSnapshotSchedule(
    "database",
    config.daemon,
    (backupDir) => newestBackupAt(config.daemon.dataDir, backupDir),
    (backupDir) => {
      const written = writes?.() ?? null;
      if (written !== null && written === writtenAtLast) {
        log.info("database snapshot skipped: nothing was written since the last one");
        return;
      }
      const taken = backupDatabase({ db, dataDir: config.daemon.dataDir, backupDir, keep: config.daemon.backupKeep, now });
      if (taken.path !== null) writtenAtLast = written;
    },
    now,
  );
}

/**
 * The memory vault. The database above is only memory's index; the vault is the truth. Unchanged files are hard-linked
 * to the previous snapshot, decided from their size and time, and a vault with nothing changed is not copied again.
 */
export function startVaultBackups(config: GlobalConfig, now: () => number = Date.now): ReturnType<typeof setInterval> {
  return onSnapshotSchedule(
    "memory vault",
    config.daemon,
    (backupDir) => newestVaultBackupAt({ dataDir: config.daemon.dataDir, backupDir }),
    (backupDir) => backupVault({ vaultDir: config.memory.dir, dataDir: config.daemon.dataDir, backupDir, keep: config.daemon.backupKeep, now, skipUnchanged: true }),
    now,
  );
}

/** The knowledge base's folder (0.8.20): the documents people kept, on the vault's schedule and in the same way. */
export function startKnowledgeBackups(config: GlobalConfig, now: () => number = Date.now): ReturnType<typeof setInterval> {
  const knowledgeDir = knowledgeDirOf(config.daemon.dataDir);
  return onSnapshotSchedule(
    "knowledge base",
    config.daemon,
    (backupDir) => newestKnowledgeBackupAt({ dataDir: config.daemon.dataDir, ...(backupDir ? { backupDir } : {}) }),
    (backupDir) => backupKnowledge({ knowledgeDir, dataDir: config.daemon.dataDir, ...(backupDir ? { backupDir } : {}), keep: config.daemon.backupKeep, now, skipUnchanged: true }),
    now,
  );
}

/**
 * The daemon's config, its people and the MCP library, and the skill pool (0.8.18): what the database, the
 * vault and the packs did not hold (`modules/config/snapshot.ts`). On the same schedule as those.
 */
export function startConfigBackups(config: GlobalConfig, configPath: string, secrets: () => string | null, now: () => number = Date.now): ReturnType<typeof setInterval>[] {
  const daemon = config.daemon;
  const keep = daemon.backupKeep;
  return [
    onSnapshotSchedule(
      "config and people",
      daemon,
      (backupDir) => newestSnapshotOf("config", { dataDir: daemon.dataDir, ...(backupDir ? { backupDir } : {}) }),
      // The seal read each time, not at boot: `nouride secret seal` changes it under a running daemon.
      (backupDir) =>
        backupConfig({ configPath, agentsDir: daemon.agentsDir, dataDir: daemon.dataDir, ...(backupDir ? { backupDir } : {}), keep, now, skipUnchanged: true, seal: daemon.backupSeal, secrets }),
      now,
    ),
    onSnapshotSchedule(
      "skill pool",
      daemon,
      (backupDir) => newestSnapshotOf("skills", { dataDir: daemon.dataDir, ...(backupDir ? { backupDir } : {}) }),
      (backupDir) => backupSkillPool({ agentsDir: daemon.agentsDir, dataDir: daemon.dataDir, ...(backupDir ? { backupDir } : {}), keep, now, skipUnchanged: true }),
      now,
    ),
  ];
}

/** Past this the launchd log is set aside — a few weeks of an ordinary daemon's lines. */
const LOG_FILE_CAP_BYTES = 16 * 1024 * 1024;

/**
 * The file launchd writes the daemon's output to, kept to one size.
 *
 * launchd has no journal: the unit points stdout at a file (`service/unit.ts`), and nothing ever rotated it, so a Mac
 * install's `nouride.log` grew for as long as the daemon ran. Checked at boot and hourly; past the cap it is copied to
 * `<file>.1` (the previous one replaced) and emptied in place — not renamed, because launchd holds it open for
 * appending, and its writes would follow the rename. A line written between the copy and the emptying is lost; the
 * database's own log (`[retention] log_days`) has it.
 */
export function startLogFileRotation(path: string, cap: number = LOG_FILE_CAP_BYTES): ReturnType<typeof setInterval> {
  const rotate = (): void => {
    const size = statFile(path)?.size ?? 0;
    if (size <= cap) return;
    try {
      copyFileAtomic(path, `${path}.1`);
      truncateFile(path);
      log.info("the daemon's log file was set aside", { file: path, kept: `${path}.1`, bytes: size });
    } catch (err) {
      log.warn("could not set the daemon's log file aside, so it keeps growing", { file: path, error: String(err) });
    }
  };
  rotate();
  const timer = setInterval(contained(log, "could not look at the daemon's log file", rotate, { file: path }), SNAPSHOT_CHECK_MS);
  timer.unref?.();
  return timer;
}

/**
 * The disk check again, on the heartbeat, and alerted rather than only logged.
 *
 * A full disk is the failure that makes every other symptom confusing, and it is entirely
 * preventable with warning. Needs the notifier, which is why it is separate from `checkDisk` — that
 * one runs long before there is a gateway to alert through.
 */
export function startDiskAlerts(
  config: GlobalConfig,
  notifier: Notifier,
  /** The threshold and the heartbeat: `DISK_WARN_MB` and `HEARTBEAT_MS`. A test's are its own. */
  limits: { warnBelowMb: number; everyMs: number } = { warnBelowMb: DISK_WARN_MB, everyMs: HEARTBEAT_MS },
): ReturnType<typeof setInterval> {
  const timer = setInterval(contained(log, "could not check the free disk space", () => {
    const free = freeDiskBytes(config.daemon.dataDir);
    if (free === null) return;
    const freeMb = Math.round(free / (1024 * 1024));
    if (freeMb < limits.warnBelowMb) {
      return notifier.alert(
        "low_disk",
        `only ${freeMb}MB free in ${config.daemon.dataDir}. SQLite writes fail when it runs out, and ` +
          `the symptoms look like everything else breaking at once.`,
      );
    }
  }), limits.everyMs);
  timer.unref?.();
  return timer;
}
