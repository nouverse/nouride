/**
 * Opening the stores: the database and everything the daemon keeps in it or beside it, in the order boot needs them.
 *
 * The first of the three steps `runDaemon` is made of (`index.ts`), before the agents load. What opens here has an
 * order of its own — the vault's format before the schema, the turns a dead process left closed before anything reads
 * them, the database checked before anything writes — and that order is this file. The stores at its end only build
 * what they are handed, and are here so that every store the daemon keeps is opened in one place.
 */

import { ensureDir, join, setFileMode } from "@nouride/runtime";
import { TransientSecrets } from "@nouride/secrets";
import { addLogSink, type GlobalConfig, type LoadedAgent } from "@nouride/shared";
import { VERSION } from "@/cli/version.ts";
import { databaseEpoch } from "@/db/epoch.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { LogBuffer } from "@/commons/log-buffer.ts";
import { LogStore } from "@/commons/logs.store.ts";
import { AccessStore } from "@/modules/access/access.store.ts";
import { ChatAttachmentIndex } from "@/modules/attachments/chat-attachments.store.ts";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { ChatEventStore } from "@/modules/chat-events/chat-events.store.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { JobWakeStore } from "@/modules/jobs/wakes.store.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { NotesStore } from "@/modules/notes/store.ts";
import { DraftStore } from "@/modules/reflection/index.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { AutoApprove } from "@/modules/tools/auto-approve.store.ts";
import { ownSecretValues, setDataDir } from "@/modules/tools/credential-files.ts";
import { setSecretFields } from "@/modules/tools/exec-secrets.ts";
import { GrantStore } from "@/modules/tools/grants.store.ts";
import { ToolGrantStore } from "@/modules/tools/tool-grants.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { UploadStore } from "@/modules/web/control/uploads.ts";
import type { BootProgress } from "@/modules/web/server.ts";
import { settleAgentUsers } from "./agent-users.ts";
import { childEnvFor } from "./child-env.ts";
import { durableStores, recoverTurns } from "./durable.ts";
import { settleInstallRoot } from "./install-root.ts";
import { checkAtBoot } from "./integrity.ts";
import { keptFolders, settleKeptFolders } from "./kept-folders.ts";
import { openRecorded } from "./last-run.ts";
import { checkDisk } from "./maintenance.ts";
import { checkMemoryVault } from "./memory.ts";
import { openSecretStore } from "./secret-store.ts";
import { moveStateFiles } from "./state-files.ts";

/** What the daemon keeps, opened — read by the steps after this one. */
export type Stores = Awaited<ReturnType<typeof openStores>>;

export async function openStores(input: {
  config: GlobalConfig;
  /** The config file this daemon reads and writes. */
  configPath: string;
  progress: BootProgress;
  /** An agent as the registry has it. The registry loads after the stores, so this is read only once a command runs. */
  agent: (id: string) => LoadedAgent | undefined;
}) {
  const { config, progress } = input;
  const dbPath = join(config.daemon.dataDir, "nouride.db");
  progress.phase = "opening the database";
  // The vault's format before the schema: data this build refuses leaves both as they were, so the release that
  // brings it forward still starts on the database (`boot/memory.ts`).
  const vaultFormat = await checkMemoryVault(config);
  // Which version last ran here — for install.sh and the upgrade floor — recorded with the migration (`boot/last-run.ts`).
  const db = await openRecorded(config.daemon.dataDir, VERSION);
  // The daemon's own small state, in the database since 0.8.18: its files at the root of `data/` moved in by the first
  // start that has the table, before anything reads one; then where the install is, and every path the database names
  // renamed when it was moved from another folder (`boot/state-files.ts`, `boot/install-root.ts`).
  const state = new DaemonStateStore(db);
  moveStateFiles(config.daemon.dataDir, state);
  settleInstallRoot(config.daemon, db, state);
  // What agents' commands read, beside `data/` rather than in it, moved once with the rows that name it; then whether
  // each agent's commands run as its own user — before anything is handed a path in them (`boot/kept-folders.ts`,
  // `boot/agent-users.ts`).
  const kept = settleKeptFolders(config, db);
  for (const dir of [kept.jobs, kept.attachments, kept.toolOutput]) ensureDir(dir);
  const agentUsers = await settleAgentUsers({ config, kept: keptFolders(config), agent: input.agent });
  // Encrypted at rest, its key from where the install keeps it; `secrets.json` moved once no update is pending (0.8.19).
  const secrets = await openSecretStore({ dataDir: config.daemon.dataDir, configPath: input.configPath, ...(process.env.HOME ? { home: process.env.HOME } : {}) });
  // Where the store and the control token are, so a command that names either is refused (`tools/credential-files.ts`).
  setDataDir(config.daemon.dataDir);
  // What is said about each secret, told with its name where an agent is told its credentials (0.8.19).
  setSecretFields((name) => secrets.describe(name)?.fields);
  // What people send in chat as secrets, held in memory under handles for an hour — `pipeline/chat-secrets.ts`. One, for
  // the pipeline that takes them, the tools that use them, and what leaves the daemon, which is masked of them.
  const heldSecrets = new TransientSecrets();
  // Every credential the daemon holds itself — the store's values, what the control token and the credentials
  // directory's files hold — which every tool's result is masked of; and with what was sent in chat, every credential it
  // knows: what each request a model is sent and each line a chat is sent is masked of (`commons/egress.ts`).
  const ownSecrets = () => ({ ...secrets.knownValues(), ...ownSecretValues() });
  const knownSecrets = () => ({ ...ownSecrets(), ...heldSecrets.values() });
  const providers = new ProviderRegistry(config.providers, secrets, undefined, knownSecrets);
  const sessions = new SessionStore(db);
  /**
   * What each turn did — steps, timings, and the answer as it is written.
   *
   * Beside the session store because it is the same history from the other side, and `interruptOrphaned`
   * runs here for the same reason the job store's does: rows left `running` by a daemon that died are a
   * client polling forever, and "still working" is the one lie a progress indicator must not tell.
   */
  // What turns do, as one stream a watcher subscribes to — and where their steps are kept (`turn-events.store.ts`).
  const events = new EventStore(db, Date.now, { epoch: databaseEpoch(dbPath) });
  const turns = new EventedTurnStore(db, events);
  // Turns committed as they run, messages written down on arrival, replies marked once they land — `boot/durable.ts`.
  const durable = durableStores(db, events);
  const chatEvents = new ChatEventStore(db);
  const rooms = new RoomStore(db);
  const roomMessages = new RoomMessageStore(db);
  // The conversation's list of files, which is what lets one agent open a file another one received
  // — see `ChatAttachmentIndex`. An index, not a second copy of the bytes.
  const attachmentIndex = new ChatAttachmentIndex(db);
  /**
   * First, the turns a dead process left with a journal: each is closed into its conversation with
   * everything it did, so the next message has it — `boot/durable.ts`. What is left `running` after this
   * has no journal (a build from before one existed) and is swept as before.
   */
  const recoveredTurns = recoverTurns({ ...durable, sessions, turns, maxTurns: config.security.maxConversationTurns });
  /**
   * Swept here, reported much later.
   *
   * The rows have to be marked before anything else boots — a dashboard polling one of them must not
   * be told "still working" for a second longer than necessary. But the people who were waiting on
   * those turns are on platforms this daemon has not connected to yet, so the addresses are held
   * until the gateways are up. See `boot/interrupted.ts`.
   */
  const orphanedTurns = turns.interruptOrphaned();
  // Recorded per provider call, each through `llm/metered.ts`. `llm_usage` had indexes and zero rows for the whole
  // of Phase 1, so `max_daily_cost_usd` described a budget nothing could enforce. Opened here rather than beside the
  // pipeline because the retention sweep starts before that point. Billing is read from the live profiles.
  const usage = new UsageStore(db, Date.now, events, (provider) => config.providers[provider]?.billing ?? "metered");

  // Checked at boot, before anything writes — unless the last run stopped cleanly and a check ran this week (E10).
  //
  // A corrupt page is silent until something reads it, so on a conversation store the failure
  // surfaces weeks later as turns that die for no visible reason — long after the backup that would
  // have fixed it was rotated away. Advisory, not fatal: refusing to start would take a daemon that
  // is mostly working entirely offline, and the operator can still read the alert and act.
  progress.phase = "checking the database";
  const integrity = checkAtBoot(db, config.daemon.dataDir);

  // Disk space, at boot and on the heartbeat — the check itself lives in `boot/maintenance.ts`.
  checkDisk(config);

  const audit = new AuditLog(db, Date.now);
  audit.start();

  const credentialsDir = kept.credentials;
  ensureDir(credentialsDir);
  // 0700: the daemon's own, and nobody else's. A world-readable credentials directory on a shared
  // box is the whole exercise undone. Where each agent is its own user, the helper keeps it `2750`, group `nr-creds`:
  // read by the agents allowed it, and by nobody else either.
  if (!agentUsers.finding.users) setFileMode(credentialsDir, 0o700);

  // What a command an agent runs may see of its credentials — see `boot/child-env.ts`.
  const childEnv = childEnvFor({
    credentialsDir,
    execSecrets: (agentId) => input.agent(agentId)?.config.execSecrets ?? [],
    sshAgent: (agentId) => input.agent(agentId)?.config.sshAgent === true,
    resolve: (name) => secrets.resolve(name),
  });

  // The scheduler's jobs. Opened here with the other stores, and started much later: reading
  // and validating the table costs nothing, while *firing* a job needs the gateways up — a reminder
  // that fires into a Discord instance still connecting is delivered nowhere.
  const cron = new CronStore({ db, config: config.cron, timezone: config.daemon.timezone, audit });

  // Error-level logs also land in the audit table (§15.3 SPEC).
  addLogSink(audit.logSink);

  // Recent lines kept in memory so `nouride logs` works where there is no journal — Docker, macOS, an
  // LXC without systemd — and works remotely, which `journalctl` never does. A second reader, not a
  // replacement: everything still goes to stdout, so the platform keeps the full history.
  const logs = new LogBuffer();
  logs.attach();

  /**
   * …and the same lines on disk, so the window survives a restart.
   *
   * The ring above covers the last 2000 entries, which a reconnect storm can burn through in
   * minutes and a restart empties entirely — and both of those describe the moments somebody
   * actually needs the log. `[retention] log_days` bounds the table; the daily sweep enforces it.
   */
  const logStore = new LogStore(db);
  logStore.start();
  addLogSink(logStore.sink);

  // The stores below only build what they are handed: nothing in them reads or writes until they are used.
  const attachments = new AttachmentStore({
    rootDir: kept.attachments,
    maxBytes: config.attachments.maxSizeMb * 1024 * 1024,
  });

  const { codeTtlMs, notifyCooldownMs, denyCooldownMs } = config.security.access;
  const access = new AccessStore({ db, audit, codeTtlMs, notifyCooldownMs, denyCooldownMs });

  // Constructed before the pipeline, and given its wake-up callback afterwards: the job store needs to
  // reach the pipeline, and the pipeline needs the job store for `exec background: true`.
  const jobWakes = new JobWakeStore(db);
  const jobs = new JobStore({ db, logDir: kept.jobs, audit, maxConcurrentPerAgent: 4, secrets: childEnv, limits: () => config.security.exec, maxMs: () => config.security.jobMaxMs });

  /**
   * Where the dashboard's files land on the way to becoming attachments.
   *
   * In `data/`, unlike the jobs' logs and the tools' long output: what is here is the daemon's to read, copied into the
   * agent's attachments before any command is handed a path. Swept by the same daily pass.
   */
  const uploads = new UploadStore(join(config.daemon.dataDir, "uploads"));

  // Where a tool result too big for the context goes. Beside the jobs' logs because it is the same kind of
  // thing — a file the daemon wrote and handed the agent a path to — and swept by the same pass.
  const spill = new ToolOutputSpill(kept.toolOutput);
  // Each conversation's work notes (0.7.26): read at every step of a turn, written by `notes` and `plan`, shown on the
  // dashboard, cleared by `/reset` — one store for all of them, so every write meets the same checks.
  const notes = new NotesStore(join(config.daemon.dataDir, "notes"));
  // The dashboard's accounts, read for a role and for who holds one.
  const accounts = new UserStore({ db });

  /**
   * Where a proposed skill waits for a human — see `modules/reflection/`.
   *
   * Opened with the stores rather than beside the engine it belongs to, because the retention sweep prunes *decided*
   * drafts and the sweep starts before the notifier the engine needs. The table outlives the loop in any case: switch
   * `[skills.learning]` off and the queue still has to be readable.
   */
  const drafts = new DraftStore(db);

  // Standing "stop asking me", per person. Opened here beside the other stores so the pipeline
  // is handed one rather than reaching for a database handle it otherwise has no use for.
  const autoApprove = new AutoApprove({ db, audit });

  const grants = new GrantStore(db, audit);
  // Directory-scoped grants for tools that are not `exec`, so `always` on a `write` prompt means
  // something bounded rather than a policy change.
  const toolGrants = new ToolGrantStore({ db, audit });

  return {
    dbPath, vaultFormat, db, state, agentUsers, secrets, heldSecrets, ownSecrets, knownSecrets, providers, sessions,
    events, turns, durable, chatEvents, rooms, roomMessages, attachmentIndex, recoveredTurns, orphanedTurns, usage,
    integrity, audit, credentialsDir, childEnv, cron, logs, logStore, attachments, access, jobWakes, jobs, uploads, spill,
    notes, accounts, drafts, autoApprove, grants, toolGrants,
  };
}
