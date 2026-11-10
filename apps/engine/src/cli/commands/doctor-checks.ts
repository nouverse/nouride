/**
 * What `nouride doctor` checks beside the daemon's own report.
 *
 * Doctor read `/status` and the memory and skills routes, and left out the signals the daemon already computes:
 * `/health`'s issues — a dead gateway, a provider failing in a row, a write-ahead log past its threshold — the
 * free disk the heartbeat logs about, the integrity check `nouride db verify` runs, and the modes of the files that
 * hold a secret. Each is a line here, and the first three answer with the daemon down, which is when they matter.
 *
 * Pure, but for reading the disk: everything is handed the facts, so a test hands it the bad ones.
 */

import { dirname, join } from "@nouride/runtime";
import { formatBytes, plural } from "@nouride/shared";
import { atOnceWords, type AtOnce } from "@/commons/machine.ts";

export interface Check {
  level: "ok" | "warn" | "bad";
  message: string;
  hint?: string;
}

/** Free space in the data directory, against the threshold the daemon's heartbeat logs at (`[health] disk_warn_threshold_mb`). */
export function diskCheck(freeBytes: number | null, thresholdMb: number): Check {
  if (freeBytes === null) return { level: "ok", message: "disk: free space not readable here" };
  const freeMb = Math.floor(freeBytes / (1024 * 1024));
  const shown = freeMb >= 10_240 ? `${(freeMb / 1024).toFixed(0)} GB` : `${freeMb} MB`;
  if (freeMb < thresholdMb) {
    return {
      level: "bad",
      message: `disk: ${shown} free in the data directory, under the ${thresholdMb} MB threshold`,
      hint: "SQLite fails its writes when the disk fills: free space, or `[retention]` shorter. `nouride db list` shows the snapshots, which are the largest files here.",
    };
  }
  return { level: "ok", message: `disk: ${shown} free in the data directory` };
}

/**
 * The package service, on a box set up for it: on, with its backend; refused — it speaks another protocol than this
 * daemon, and the refusal says what puts it in step; or silent.
 */
export async function packagesCheck(service: Pick<typeof import("nouride-system-packages"), "packageBackend" | "askPackages"> | null): Promise<Check> {
  const backend = await service?.packageBackend();
  if (backend) return { level: "ok", message: `system packages: on (${backend})` };
  const answer = await service?.askPackages({ op: "status" });
  if (answer?.status === "refused") return { level: "warn", message: `system packages: ${answer.detail}` };
  return { level: "warn", message: "system packages: the service is set up but did not answer", hint: "journalctl -t nouride-pkg -n 20 --no-pager" };
}

/** SQLite's own `quick_check` over the database, read-only — what `nouride db verify` runs. */
export function databaseCheck(dbPath: string, exists: boolean, verify: (path: string) => { ok: boolean; detail: string }): Check {
  if (!exists) return { level: "ok", message: "database: not created yet (the daemon makes it on its first start)" };
  const verdict = verify(dbPath);
  if (verdict.ok) return { level: "ok", message: "database: quick_check passed" };
  return {
    level: "bad",
    message: `database: quick_check failed: ${verdict.detail}`,
    hint: "Stop the daemon and put a snapshot back: `nouride db list`, then `nouride db restore <file>`.",
  };
}

/** A file that holds a secret, and the most its mode may allow. */
export interface Guarded {
  path: string;
  /** What the daemon gives it: anything beyond these bits is more than it should allow. */
  mode: number;
  what: string;
}

/**
 * The files whose mode decides who can read a secret. The control token is the daemon's own key, and group-readable
 * on purpose — an operator in the service group runs the CLI without sudo; the rest are the owner's alone. The
 * credentials directory is `nr-creds`'s to read too where each agent's commands run as its own user (`ownUsers`).
 */
export function guardedFiles(dataDir: string, credentialsDir: string, ownUsers = false): Guarded[] {
  return [
    { path: join(dataDir, ".control-token"), mode: 0o640, what: "the control token" },
    { path: join(dataDir, "secrets.json"), mode: 0o600, what: "the secret store" },
    { path: join(dataDir, "secrets.enc"), mode: 0o600, what: "the secret store" },
    { path: join(dirname(dataDir), "encryption.key"), mode: 0o600, what: "the secret store's key" },
    { path: join(dataDir, "nouride.db"), mode: 0o600, what: "the database" },
    { path: join(dataDir, "nouride.db-wal"), mode: 0o600, what: "the database's write-ahead log" },
    { path: credentialsDir, mode: ownUsers ? 0o750 : 0o700, what: "the credentials directory" },
  ];
}

/**
 * A guarded file whose mode allows more than the daemon gives it. One the daemon has not written yet is not a
 * finding. `fix` narrows the mode — the one repair `doctor --fix` makes, because it is safe to repeat and changes
 * nothing anybody chose: the daemon would set the same bits on its next write.
 */
export function modeChecks(
  files: readonly Guarded[],
  io: { mode: (path: string) => number | null; chmod: (path: string, mode: number) => boolean },
  fix: boolean,
): Check[] {
  const checks: Check[] = [];
  for (const file of files) {
    const mode = io.mode(file.path);
    if (mode === null || (mode & ~file.mode & 0o777) === 0) continue;
    const want = file.mode.toString(8).padStart(4, "0");
    const have = mode.toString(8).padStart(4, "0");
    if (fix && io.chmod(file.path, file.mode)) {
      checks.push({ level: "ok", message: `${file.what}: mode ${have} narrowed to ${want} (${file.path})` });
      continue;
    }
    checks.push({
      level: "warn",
      message: `${file.what} is mode ${have}, more open than ${want} (${file.path})`,
      hint: fix ? `Could not change it; as its owner: chmod ${want} ${file.path}` : `\`nouride doctor --fix\` narrows it, or: chmod ${want} ${file.path}`,
    });
  }
  if (checks.length === 0) checks.push({ level: "ok", message: "file modes: the token, secrets and database are no more open than the daemon makes them" });
  return checks;
}

/**
 * A pack that failed to load: why, and that it comes back without a restart once fixed — `nouride agent reload <id>`
 * loads a failed pack by its id, which it did not, so a restart was the only way.
 */
export function packFailureCheck(failure: { id: string; error: string }): Check {
  return { level: "bad", message: `agent pack "${failure.id}" failed to load`, hint: `${failure.error} (fix it, then \`nouride agent reload ${failure.id}\`)` };
}

/**
 * The daemon's own memory, as `/health` reports it: resident, and the JavaScript heap in use. Said, not judged — no
 * figure here is a limit anyone measured, and `docs/SYSTEM_REQUIREMENTS.md` is where one is read against what was.
 * Nothing at all from a daemon too old to report it.
 */
export function memoryCheck(memory: { rssBytes?: unknown; heapUsedBytes?: unknown } | undefined): Check | null {
  const { rssBytes, heapUsedBytes } = memory ?? {};
  if (typeof rssBytes !== "number" || typeof heapUsedBytes !== "number") return null;
  return { level: "ok", message: `daemon memory: ${formatBytes(rssBytes)} resident, ${formatBytes(heapUsedBytes)} of it JavaScript heap in use` };
}

/**
 * Whether what agents run can take the daemon down with it (0.7.19): in a cgroup of their own, capped below the
 * daemon's, they cannot. Warned only under systemd, where they would be and are not — a unit from before 0.7.19, or one
 * the machine would not let split; anywhere else the line says what bounds them. Nothing from a daemon too old to say.
 */
export function commandsCheck(commands: { isolated?: unknown; systemd?: unknown; reason?: unknown; commandsMaxBytes?: unknown; daemonMinBytes?: unknown } | undefined): Check | null {
  if (typeof commands?.isolated !== "boolean") return null;
  if (commands.isolated) {
    const cap = typeof commands.commandsMaxBytes === "number" ? `, where together they may hold ${formatBytes(commands.commandsMaxBytes)} before the kernel stops one` : "";
    const kept = typeof commands.daemonMinBytes === "number" ? `, and the daemon keeps ${formatBytes(commands.daemonMinBytes)}` : "";
    return { level: "ok", message: `agents' commands: a cgroup of their own${cap}${kept}` };
  }
  const reason = typeof commands.reason === "string" ? commands.reason : "unknown";
  if (commands.systemd !== true) return { level: "ok", message: `agents' commands: beside the daemon (${reason}), the kernel's first choice when memory runs out` };
  return {
    level: "warn",
    message: `agents' commands share the daemon's memory: ${reason}`,
    hint: "One that eats it slows the daemon with it until nothing answers. Re-run install.sh once to rewrite the unit. It leaves .nouride/ alone.",
  };
}

/** What `/memory/status` says of the nightly pass's backlog (`modules/memory/backlog.ts`), as doctor reads it. */
interface Backlog {
  waiting: number;
  oldest: string | null;
  perNight: number;
  days: number;
  agents: readonly { agent: string; perDay: number }[];
  behind: readonly string[];
  enough: number | null;
}

/**
 * Whether the nightly pass keeps up: nothing for a pass that is off or a daemon too old to say; a warning, with the
 * count to set, once what waits is more than a week of nights files at the count set — an agent whose conversations
 * bring more a day than that falls further behind every night, and its memory with it.
 */
export function passBacklogCheck(pass: { enabled?: unknown } | null | undefined, backlog: Backlog | undefined): Check | null {
  if (pass?.enabled !== true || !backlog) return null;
  if (backlog.enough === null) {
    return { level: "ok", message: `memory pass: keeping up, ${backlog.waiting} conversation(s) waiting, at most ${backlog.perNight} per agent a night` };
  }
  const pace = backlog.agents.filter((row) => row.perDay > 0).map((row) => `${row.agent || "no agent"} ${row.perDay} a day`).join(", ");
  const over = backlog.days === 7 ? "over the last 7 days" : `over the ${backlog.days} day(s) since the first conversation`;
  return {
    level: "warn",
    message:
      `memory pass: ${backlog.behind.length ? "falling behind" : "behind"}, ${backlog.waiting} conversation(s) waiting${backlog.oldest ? `, the oldest from ${backlog.oldest}` : ""}; ` +
      `${pace || "no conversations"} ${over}, and the pass files ${backlog.perNight} per agent a night`,
    hint: `\`nouride memory set pass_per_night ${backlog.enough}\` files what waits within a week at this pace; \`nouride memory set pass_max_tokens <n>\` caps what a night may spend.`,
  };
}

/**
 * How many helpers and missions run at once, and whether a setting or the machine decided each (`/status`). The
 * daemon's own reading: it knows the cgroup its agents' commands run in, which a command run beside it does not.
 * Nothing from a daemon too old to say.
 */
export function atOnceChecks(atOnce: AtOnce | undefined): Check[] {
  return atOnce ? [{ level: "ok", message: `work at once: ${atOnceWords(atOnce)}` }] : [];
}

/**
 * What compaction and the memory pass ran into with their models in the last day (`modules/llm/helper-trouble.ts`), as
 * `/status` reports it: how often, the last error in the provider's words, and what to change. A pass model that went
 * away failed every compaction on the box for an afternoon, and said so only in the journal. Nothing when nothing did.
 */
export function helperChecks(helpers: readonly { summary: string; last: string; at: number; fix: string }[], now: number): Check[] {
  return helpers.map((trouble) => {
    const minutes = Math.max(0, Math.round((now - trouble.at) / 60_000));
    const when = minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
    return { level: "warn", message: trouble.summary, hint: `The last, ${when}: ${trouble.last || "no error recorded"}; ${trouble.fix}.` };
  });
}

/**
 * What `/health` already counts as wrong. A dead gateway is a fault; the rest are worth a look. A helper's trouble is
 * left out: `helperChecks` says it, with the count and the last error `/health` leaves out.
 */
export function healthIssues(issues: readonly string[], helpers: readonly { issue: string }[] = []): Check[] {
  const said = new Set(helpers.map((trouble) => trouble.issue));
  return issues.filter((issue) => !said.has(issue)).map((issue) =>
    issue.endsWith(": dead")
      ? { level: "bad" as const, message: `health: ${issue}`, hint: "`nouride logs` says why; check its token, then `nouride gateway restart <id>`." }
      : { level: "warn" as const, message: `health: ${issue}` },
  );
}

/**
 * Each running agent whose model is budgeted at a guess. The failure it causes is not an error: an agent whose
 * history is cut and whose tool output is trimmed every round, re-reading the file it just read — which cost a live
 * evening before anything said why. Said where an operator looks, not only once in a log. A daemon from before 0.7.13
 * reports no window, and says nothing here.
 */
export function guessedWindows(agents: readonly { id: string; model: string; contextWindow?: { tokens: number; source: string } }[]): Check[] {
  return agents.flatMap((agent): Check[] =>
    agent.contextWindow?.source === "default"
      ? [
          {
            level: "warn",
            message: `${agent.id}: no known context window for ${agent.model}, budgeted at ${agent.contextWindow.tokens.toLocaleString("en-US")} tokens`,
            hint:
              `If the model takes more, set [llm] context_window in agents/${agent.id}/config.toml, or have its gateway ` +
              `state the window in /models (Nougate does where it knows it).`,
          },
        ]
      : [],
  );
}

/**
 * The agents' ssh config names hosts and keeps no connection open between them (0.7.17,
 * v0.8.x_RFC_FEWER_ROUND_TRIPS §5.2). A hint, never a failure: each `ssh` in a row pays a handshake three lines save.
 * Nothing to say with no config, no host in it, or reuse already on.
 */
export function sshReuseCheck(config: string | null): Check | null {
  if (config === null) return null;
  const hosts = config.split("\n").filter((line) => /^\s*Host\s+\S/i.test(line)).length;
  if (hosts === 0 || /^\s*ControlMaster\s+(auto|autoask|yes)\b/im.test(config)) return null;
  return {
    level: "warn",
    message: `agents' ssh: ${hosts} host(s), and each ssh opens a new connection`,
    hint: "Several ssh in a row each pay a handshake. In the agents' ~/.ssh/config add `Host *` with `ControlMaster auto`, `ControlPath ${HOME}/.ssh/cm-%C` and `ControlPersist 10m`. DEPLOY.md has the block.",
  };
}

/**
 * Whether any provider profile can answer, and each that cannot. A fresh install has no profile at all until its setup
 * is finished, and "set one of:" over an empty list said nothing a person could act on — seen on 0.8.0's Docker run.
 */
export function credentialChecks(providers: readonly { name: string; hasCredential: boolean }[]): Check[] {
  const credentialed = providers.filter((p) => p.hasCredential);
  const checks: Check[] = [];
  if (providers.length === 0) {
    checks.push({ level: "bad", message: "no provider profile yet, so no agent can answer", hint: "Finish setting it up: open the dashboard, or run `nouride setup`." });
  } else if (credentialed.length === 0) {
    checks.push({ level: "bad", message: "no provider profile has a credential, so no agent can answer", hint: `Set one of: ${providers.map((p) => p.name).join(", ")}. See .env.example.` });
  } else {
    checks.push({ level: "ok", message: `providers with credentials: ${credentialed.map((p) => p.name).join(", ")}` });
  }
  for (const provider of providers) {
    if (!provider.hasCredential) checks.push({ level: "warn", message: `provider "${provider.name}" has no credential`, hint: "Unusable until it does." });
  }
  return checks;
}

/**
 * The secret store at rest (0.8.19): encrypted or not yet, and how far its key is from the data, which is what the
 * encryption is worth; then the backup passphrase, the one way back from a lost key. Never the key.
 */
export function secretStoreChecks(lock: { encrypted: boolean; key?: { where: string; level: string } } | undefined, sealed: boolean | undefined): Check[] {
  if (!lock) return [];
  const checks: Check[] = [];
  const where = lock.key?.where ?? "this install";
  if (!lock.encrypted) {
    checks.push({ level: "warn", message: "secret store: not encrypted yet", hint: "It is once this update is confirmed. If it stays so, the journal says why." });
  } else if (lock.key?.level === "install") {
    checks.push({
      level: "warn",
      message: `secret store: encrypted, its key in ${where}, beside the data`,
      hint: "Run install.sh again: it moves the key to /etc/nouride/nouride.env, which only root reads, and a copy of the install folder then carries no key.",
    });
  } else if (lock.key?.level === "data") {
    checks.push({
      level: "warn",
      message: `secret store: encrypted, but its key is kept with the data (${where}): a copy of the data folder opens it`,
      hint: "Give the key from outside the data: NOURIDE_ENCRYPTION_KEY, or NOURIDE_ENCRYPTION_KEY_FILE naming a file (a Docker secret). Nouride moves to it at its next start.",
    });
  } else {
    checks.push({ level: "ok", message: `secret store: encrypted, its key in ${where}` });
  }
  if (sealed === false) {
    checks.push({ level: "warn", message: "backup passphrase: not set, so a lost key means setting every secret again", hint: "nouride secret seal --stdin, the passphrase on stdin: kept nowhere on this machine." });
  }
  return checks;
}

/** Plain copies of the store left beside it once it is encrypted, and stores set aside unopened: named, never removed. */
export function plainCopiesCheck(names: readonly string[]): Check | null {
  if (!names.includes("secrets.enc")) return null;
  const plain = names.filter((name) => /^secrets\.json(\..+)?$/.test(name) || /^secrets\.enc\.unopened-/.test(name)).sort();
  if (!plain.length) return null;
  return {
    level: "warn",
    message: `secret store: ${plain.length} other ${plural(plain.length, "copy", "copies")} beside it (${plain.join(", ")})`,
    hint: "A secrets.json beside the encrypted store holds every value in plain text: remove it once you no longer need it, by hand. An .unopened file is a store whose key was not here.",
  };
}
