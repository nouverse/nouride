import type { ExternalClisResponse, McpResponse, SkillCatalogResponse, StatusResponse } from "@/cli/wire.ts";
import { cliVersionChecks } from "@/cli/commands/external-clis.ts";
import { formatBytes, type GlobalConfig } from "@nouride/shared";
import { MCP_SCHEMA_WARN_BYTES } from "@/modules/tools/mcp.ts";
import { lintConfig } from "@/modules/config/schema.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, emit, say } from "@/cli/ui.ts";
import { connect } from "@/cli/client.ts";
import { startHint } from "@/service/hints.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { hasFlag } from "@/cli/args.ts";
import { atOnceChecks, commandsCheck, credentialChecks, databaseCheck, diskCheck, guardedFiles, guessedWindows, healthIssues, helperChecks, memoryCheck, modeChecks, packagesCheck, packFailureCheck, passBacklogCheck, plainCopiesCheck, secretStoreChecks, sshReuseCheck } from "@/cli/commands/doctor-checks.ts";
import { EDITION } from "@/commons/build.ts";
import { installDirFor } from "@/modules/update/facts.ts";
import { localPackageSetup, resolveSystemPackages } from "@/modules/system-packages/index.ts";
import { sqliteCapabilities } from "@/db/index.ts";
import { compareInstalledUnit, INSTALLED_UNIT, systemdVersion } from "@/service/drift.ts";
import { checkDatabaseFile, dirname, fileExists, fileExistsSync, fileOwner, freeDiskBytes, join, listDir, passwdHome, readTextFileIfExists, runCommand, setFileMode, statFile } from "@nouride/runtime";
import { SYSTEM_KEY_FILE } from "@nouride/secrets";
import { toolchainChecks } from "@/cli/commands/doctor-toolchain.ts";
import { agentUserChecks, agentUsersChecks, commandProbeCheck, readAccounts, rootReachCheck } from "@/cli/commands/doctor-isolation.ts";
import { canHaveOwnUser, findHelper, helperFolders } from "@/boot/agent-users.ts";
import { keptFolders } from "@/boot/kept-folders.ts";
import { commandSecretLookup } from "@/boot/secret-store.ts";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import { DISK_WARN_MB } from "@/boot/maintenance.ts";
import { clientPrefix } from "@nouride/isolation";
import { groupAdvisories, readAdvisories } from "@/boot/advisories.ts";
import { stateInFile } from "@/commons/daemon-state.store.ts";

/**
 * `nouride doctor` — everything that commonly stops a fresh install from working, checked in one place.
 *
 * Written against the failures that actually happened while building this: a provider with no
 * credential, an agent pack that did not load, a gateway stuck reconnecting, no agent enabled at
 * all. Each check says what to do, not just that something is wrong.
 */
export async function doctor(args: string[] = []): Promise<void> {
  const results: { level: "ok" | "warn" | "bad"; message: string; hint?: string }[] = [];
  const add = (level: "ok" | "warn" | "bad", message: string, hint?: string) =>
    results.push({ level, message, ...(hint ? { hint } : {}) });

  // Its own read, first: every check below works from what the config names, so a config this user may not read is one
  // line and exit 1, as for every other command — there is nothing to report before it.
  const { config, source, notes } = await loadConfig();
  add("ok", `config: ${source ?? "built-in defaults"}`);
  add("ok", `data dir: ${config.daemon.dataDir}`);
  // What the loader says about the file — an unknown key, a setting worth a second look — as lines of this report. Every
  // other command keeps them off its terminal (`loadGlobalConfig`'s `quiet`).
  for (const note of notes) add("warn", `config: ${note.message}${note.detail ? ` (${note.detail})` : ""}`, note.hint);

  // Before the daemon check, because this is the half that works when nothing is running — and a
  // config broken enough to matter is usually why nothing is running. The daemon check below returns
  // early on failure, so anything placed after it is invisible in exactly that case.
  const secretSet = await commandSecretLookup({ dataDir: config.daemon.dataDir, configPath: source ?? defaultConfigPath() });
  const lints = lintConfig(config, secretSet ? { secretSet } : {});
  for (const lint of lints) {
    add(lint.level === "bad" ? "bad" : "warn", lint.message, lint.hint);
  }
  // What the last boot said about how this install is set up — at warn once, at info since, so otherwise only in the
  // journal. Read off the database file without writing to it, daemon or not; the config's own lints are above already.
  const linted = new Set(lints.map((lint) => lint.message));
  for (const line of groupAdvisories(readAdvisories(stateInFile(join(config.daemon.dataDir, "nouride.db"), "advisories")))) {
    if (linted.has(line.message)) continue;
    add("warn", line.agents.length > 0 ? `${line.message} (${line.agents.join(", ")})` : line.message, line.hint);
  }

  // This binary's own SQLite, which is the daemon's — the one check that explains a daemon refusing to
  // start over its database, so it runs whether or not one is up.
  const sqlite = sqliteCapabilities();
  if (sqlite.missing.length === 0) add("ok", `sqlite: ${sqlite.version}, with FTS5`);
  else add("bad", `sqlite: ${sqlite.missing.join("; ")}`, "This is the build, not the data. Use a release binary: they bundle a SQLite that has both.");

  // Also before the daemon check: the package service is root's, and answers whether the daemon is up.
  // Off is a choice (`install.sh --allow-packages` turns it on), so it is stated, not warned about.
  const packagesProvider = await resolveSystemPackages();
  const packages = localPackageSetup({ edition: EDITION, installDir: installDirFor(config.daemon.dataDir) });
  if (packages.state === "ready") {
    const check = await packagesCheck(packagesProvider);
    add(check.level, check.message, check.hint);
  } else if (packages.state === "off") {
    add("ok", "system packages: off, so agents install into their own bin directory (install.sh --allow-packages turns it on)");
  } else {
    add("ok", `system packages: not used here (${packages.why})`);
  }

  // What agents have installed, and what about it needs attention — read from disk, daemon or not.
  for (const check of await toolchainChecks(config.daemon.dataDir)) add(check.level, check.message, check.hint);

  // Whether each agent's commands run as its own user, and why not — asked as boot asks it, of the daemon's situation:
  // root is whether the daemon is, which an operator's sudo does not change.
  const isolation = await isolationOf(config);
  const isolationLines = agentUsersChecks(isolation.finding, { expected: isolation.expected, landlock: config.security.exec.landlock ?? "auto" });
  // Where they are, so a daemon that turns out to run its agents' commands through a socket that is gone can replace them.
  const isolationAt = results.length;
  for (const check of isolationLines) add(check.level, check.message, check.hint);

  // The installed unit against the one this version writes. Updates replace the binary and never the unit, so it keeps
  // what it was installed with — a guard that restores less than an update swaps, a restart that kills the command a
  // turn is running — and this used to check one directive of it, `KillMode`.
  const drift = compareInstalledUnit(await readTextFileIfExists(INSTALLED_UNIT).catch(() => null), (await systemdVersion()) ?? undefined, statFile(SYSTEM_KEY_FILE) ? SYSTEM_KEY_FILE : undefined);
  if (drift && drift.added.length + drift.removed.length > 0) {
    const named = [...drift.added, ...drift.removed].map((line) => line.split("=")[0]).filter((key, i, all) => all.indexOf(key) === i);
    add(
      "warn",
      `service unit: written by an older version (${named.slice(0, 4).join(", ")}${named.length > 4 ? ` and ${named.length - 4} more` : ""} differ from this one's)`,
      drift.privileged
        ? "It is rewritten after the next confirmed update; re-run install.sh to do it now. `nouride service diff` shows each line."
        : "Re-run install.sh once to rewrite it. It leaves .nouride/ alone. `nouride service diff` shows each line.",
    );
  }

  // Disk, the database's own check, and who can read the secrets — all of it answered with the daemon down.
  const dataDir = config.daemon.dataDir;
  const dbPath = join(dataDir, "nouride.db");
  for (const check of [
    diskCheck(freeDiskBytes(dataDir), DISK_WARN_MB),
    databaseCheck(dbPath, fileExistsSync(dbPath), checkDatabaseFile),
    ...modeChecks(
      guardedFiles(dataDir, keptFolders(config).credentials, isolation.finding.users !== null),
      { mode: (path) => statFile(path)?.mode ?? null, chmod: setFileMode },
      hasFlag(args, "--fix"),
    ),
  ]) {
    add(check.level, check.message, check.hint);
  }
  // A plain copy of the store left beside the encrypted one (0.8.19): read from the folder, the daemon up or not.
  const copies = plainCopiesCheck(listDir(dataDir).map((entry) => entry.name));
  if (copies) add(copies.level, copies.message, copies.hint);
  // What the agents' ssh reads: `.nouride/home/.ssh/config` — the `ssh` in `.nouride/bin` names it — and, included at
  // its end, the one in the service user's passwd home, which is where ssh looked before 0.7.17. The service user is
  // whoever owns the data. A config this user cannot read says nothing.
  const owner = fileOwner(dataDir);
  const accountHome = owner === null ? null : passwdHome(owner);
  const sshConfigs = [join(dirname(dataDir), "home"), accountHome].filter((home): home is string => home !== null);
  const sshTexts = await Promise.all(sshConfigs.map((home) => readTextFileIfExists(join(home, ".ssh", "config")).catch(() => null)));
  const sshText = sshTexts.filter((text): text is string => text !== null);
  const sshReuse = sshReuseCheck(sshText.length ? sshText.join("\n") : null);
  if (sshReuse) add(sshReuse.level, sshReuse.message, sshReuse.hint);

  // Reaching the daemon is checked first, because every other remote check depends on it and a
  // wall of failures is less useful than one accurate line.
  let status: StatusResponse;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    client = await connect({ soft: true });
    // Soft, so a rejection is reported with the config and data dir already on screen. Using the hard
    // helper here exited inside the try — `report()` never ran, and the two lines above, which are
    // exactly what you need to see that you are in the wrong directory, were discarded.
    status = await client.softGet<StatusResponse>("/status");
    add("ok", `daemon reachable at ${client.baseUrl} (up ${status.uptime}s)`);
    // The store encrypted, how far its key is from the data, and the backup passphrase (0.8.19). The daemon says: it
    // is what has the key, and a command run by an operator may not be able to read it.
    const store = await client.softGet<{ lock?: { encrypted: boolean; key?: { where: string; level: string } }; sealedInSnapshots?: boolean }>("/secrets").catch(() => null);
    for (const check of secretStoreChecks(store?.lock, store?.sealedInSnapshots)) add(check.level, check.message, check.hint);
  } catch (err) {
    const isPermission =
      (err as { code?: string })?.code === "EACCES" ||
      String(err).includes("EACCES") ||
      String(err).includes("permission denied");

    const defaultHint = isPermission
      ? "The control token is restricted to the service user and group. Run with sudo (`sudo nouride doctor`), or add your user to the group: `sudo usermod -aG nouride $USER`."
      : startHint();

    const hint = (err as { hint?: string }).hint ?? defaultHint;
    add(
      "bad",
      err instanceof Error ? err.message : "daemon is not reachable",
      hint,
    );
    report(results);
    return;
  }

  // What the daemon itself counts as wrong (`/health`), which doctor never read: unauthenticated, so asked plainly.
  const health = await fetch(`${client.baseUrl}/health`).then((res) => res.json() as Promise<{ issues?: string[]; memory?: { rssBytes?: unknown; heapUsedBytes?: unknown }; commands?: Record<string, unknown>; agentUsers?: { through?: "socket" | "local" | null } }>).catch(() => null);
  const through = health?.agentUsers?.through;
  if (through === "socket" && !isolation.finding.users) {
    const checks = agentUsersChecks(isolation.finding, { expected: isolation.expected, landlock: config.security.exec.landlock ?? "auto", running: through });
    results.splice(isolationAt, isolationLines.length, ...checks);
  }
  const footprint = memoryCheck(health?.memory);
  if (footprint) add(footprint.level, footprint.message);
  const commands = commandsCheck(health?.commands);
  if (commands) add(commands.level, commands.message, commands.hint);
  // The helper models' trouble from `/status`, with the count and the provider's words; `/health` says the same lines
  // without them, so each is said once.
  const helpers = status.helpers ?? [];
  for (const check of [...atOnceChecks(status.atOnce), ...healthIssues(health?.issues ?? [], helpers), ...helperChecks(helpers, Date.now())]) add(check.level, check.message, check.hint);

  // The keyword index's own check (FTS5 `integrity-check`). It is a cache of the vault, so the fix is a
  // rebuild, not a restore. Skipped quietly by a daemon too old to report it.
  const memory = await client.softGet<{ index?: { ok: boolean; detail: string }; pass?: { enabled?: unknown } | null; backlog?: Parameters<typeof passBacklogCheck>[1] }>("/memory/status").catch(() => null);
  if (memory?.index?.ok) add("ok", "memory index: FTS5 integrity check passed");
  else if (memory?.index) add("bad", `memory index: ${memory.index.detail}`, "It is a cache of the vault: `nouride memory reindex` rebuilds it.");
  // Whether the nightly pass keeps up with the conversations it files — skipped by a daemon too old to say.
  const backlog = passBacklogCheck(memory?.pass, memory?.backlog);
  if (backlog) add(backlog.level, backlog.message, backlog.hint);

  // Durable turns: every turn in flight is journaled, every message waiting is in the inbox, so a crash
  // loses neither. Absent from a daemon too old to have them.
  const durable = (status as { durable?: { inFlight: number; waiting: number } | null }).durable;
  if (durable) add("ok", `durable turns: on, ${durable.inFlight} turn(s) in flight, ${durable.waiting} message(s) waiting`);

  for (const check of credentialChecks(status.providers)) add(check.level, check.message, check.hint);

  for (const failure of status.failures) {
    const check = packFailureCheck(failure);
    add(check.level, check.message, check.hint);
  }

  const running = status.agents.filter((a) => a.enabled && a.state === "running");
  if (running.length === 0) {
    add(
      "bad",
      "no agent is running",
      status.agents.length === 0
        ? "Create one under agents/. IDENTITY.md is the only required file."
        : `Loaded but not running: ${status.agents.map((a) => `${a.id} (${a.enabled ? a.state : "disabled"})`).join(", ")}`,
    );
  } else {
    add("ok", `agents running: ${running.map((a) => a.id).join(", ")}`);
  }

  // The check that was missing when this whole class of confusion happened: a declared workspace root
  // that is not there. Everything else reported green — agent running, gateway connected, provider
  // credentialed — while every path inside that root was refused, which reads as the agent being broken.
  for (const agent of running) {
    for (const root of agent.workspaceRoots ?? []) {
      if (!root.exists) {
        add(
          "warn",
          `${agent.id}: workspace root ${root.path} does not exist`,
          `Nothing in it can be read. Check [workspace] roots in agents/${agent.id}/config.toml. ` +
            `A leading ~ expands to your home directory, and a relative path resolves against the ` +
            `agent's own folder.`,
        );
      }
    }
  }

  // Each agent's own user, and each declared root it has to reach as that user — asked through the helper, as the agent.
  const users = isolation.finding.users;
  if (users) {
    const [passwd, group] = await Promise.all(["/etc/passwd", "/etc/group"].map((path) => readTextFileIfExists(path).catch(() => null)));
    for (const check of agentUserChecks(running, readAccounts(passwd ?? "", group ?? ""))) add(check.level, check.message, check.hint);
    const shared = join(config.daemon.workspaceDir, "shared");
    const probeOptions = { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutMs: 15_000, maxOutputBytes: 4096 };
    for (const agent of running.filter((agent) => canHaveOwnUser(agent.id))) {
      const roots = (agent.workspaceRoots ?? []).filter((root) => root.exists).map((root) => root.path);
      const line = clientPrefix(users, agent.id, { cwd: shared, landlock: config.security.exec.landlock ?? "auto", writable: roots });
      const probe = await runCommand([...line, "id", "-un"], probeOptions).catch(() => null);
      const check = commandProbeCheck(agent.id, probe);
      if (check) add(check.level, check.message, check.hint);
    }
    for (const agent of running) {
      for (const root of (agent.workspaceRoots ?? []).filter((root) => root.exists)) {
        const probe = await runCommand([...clientPrefix(users, agent.id, { cwd: "/", landlock: "off", writable: [] }), "sh", "-c", 'test -r "$0" && test -w "$0" && test -x "$0"', root.path], probeOptions).catch(() => null);
        const check = rootReachCheck(agent.id, root.path, probe?.exitCode === 0);
        if (check) add(check.level, check.message, check.hint);
      }
    }
  }

  // An agent pointing at a profile with no key is the failure that looks like a model outage.
  for (const agent of running) {
    const provider = status.providers.find((p) => p.name === agent.provider);
    if (!provider) {
      add("bad", `agent "${agent.id}" names provider "${agent.provider}", which is not configured`);
    } else if (!provider.hasCredential) {
      add("bad", `agent "${agent.id}" uses "${agent.provider}", which has no credential`);
    }
  }

  for (const check of guessedWindows(running)) add(check.level, check.message, check.hint);

  if (status.gateways.length === 0) {
    add(
      "warn",
      "no gateways are connected",
      "Nothing can reach an agent except `nouride chat`. Configure one under [gateways.<platform>.<name>].",
    );
  }
  for (const gateway of status.gateways) {
    if (gateway.status === "connected") add("ok", `gateway ${gateway.id}: connected`);
    else if (gateway.status === "dead") {
      add("bad", `gateway ${gateway.id} is dead`, "Check its token, then `nouride gateway restart <id>`.");
    } else add("warn", `gateway ${gateway.id}: ${gateway.status}`);
  }

  // The coding CLIs installed here against the versions this Nouride was tested with, and the newest out (0.8.24): what
  // `nouride agents scan` says of each. Nothing on a box with none.
  const clis = await client.softGet<ExternalClisResponse>("/external-clis").catch(() => null);
  for (const check of cliVersionChecks(clis?.clis ?? [])) add(check.level, check.message);

  if (status.pendingApprovals > 0) {
    add(
      "warn",
      `${status.pendingApprovals} approval(s) waiting`,
      "A tool call is blocked until answered: `nouride approvals`.",
    );
  }

  if (status.queue.waiting > 0) {
    add("warn", `${status.queue.waiting} message(s) queued`, "Turns may be backing up.");
  }

  /**
   * A skill that names host software this box does not have.
   *
   * Worth a line here because the failure is otherwise invisible until it is expensive: the skill
   * loads, the agent reads it, follows the procedure, and the fourth step dies on `dot: command not
   * found` — halfway through a task, with an approval already spent. `requires:` in the frontmatter
   * is what makes it checkable at all.
   *
   * Soft: a daemon too old to have the route answers 404, and that is not a fault worth reporting.
   */
  const catalog = await client
    ?.softGet<SkillCatalogResponse>("/skills/catalog")
    .catch(() => null);
  for (const skill of catalog?.skills ?? []) {
    if ((skill.missing ?? []).length === 0) continue;
    const holders = (skill.agents ?? []).filter((a) => a.enabled).map((a) => a.id);
    add(
      holders.length > 0 ? "warn" : "ok",
      `skill "${skill.name}" needs ${skill.missing.join(", ")}, not installed here`,
      holders.length > 0
        ? `On for: ${holders.join(", ")}. Install it, or switch the skill off: \`nouride skills off ${skill.name} <agent>\`.`
        : "Nobody has this skill on, so nothing will trip over it.",
    );
  }

  /**
   * A skill an agent carries but cannot actually run.
   *
   * The tool axis, and it is per agent rather than per host: two agents on one daemon can disagree
   * about this while agreeing about every binary. `warn` and not `ok`, unlike the unread advisory —
   * this one is a task that *will* fail partway through, not a cost.
   */
  for (const skill of catalog?.skills ?? []) {
    const short = (skill.agents ?? []).filter((a) => a.enabled && (a.missingTools ?? []).length > 0);
    if (short.length === 0) continue;
    // Only what is actually missing, per agent. Listing every tool the skill names would say "nox
    // does not have exec, web_search" about an agent that has exec — a sentence that sends somebody
    // to check the wrong thing.
    const gaps = [...new Set(short.flatMap((a) => a.missingTools as string[]))].sort();
    add(
      "warn",
      `skill "${skill.name}" needs ${gaps.join(", ")}, which ${short.map((a) => a.id).join(", ")} do not have`,
      `Add the tool to that agent's \`[tools] enabled\`, or switch the skill off for it: \`nouride skills off ${skill.name} <agent>\`.`,
    );
  }

  /**
   * What each MCP server's tools cost every request of the agent that holds it.
   *
   * The built-ins' schemas are held to a budget by a test; a server's are somebody else's and arrive when it connects,
   * so they can only be said. Past `MCP_SCHEMA_WARN_BYTES` a server costs its agent more of the window than most of its
   * built-ins, on every request of every tool iteration. Soft: a daemon too old to measure them answers without.
   */
  const mcp = await client?.softGet<McpResponse>("/mcp").catch(() => null);
  const measured = (mcp?.servers ?? []).filter((server) => server.schemaBytes !== undefined);
  if (measured.length > 0) {
    const total = measured.reduce((sum, server) => sum + (server.schemaBytes ?? 0), 0);
    add("ok", `MCP: ${measured.length} server(s), ${formatBytes(total)} of tool schemas in all`, "`nouride mcp` lists each server's.");
  }
  for (const server of measured) {
    if ((server.schemaBytes ?? 0) <= MCP_SCHEMA_WARN_BYTES) continue;
    add(
      "warn",
      `MCP server "${server.server}" (${server.agentId}): its ${server.tools} tools' schemas are ${formatBytes(server.schemaBytes ?? 0)}, sent with every request that agent makes`,
      `Give ${server.agentId} only the tools it needs: \`nouride mcp tools ${server.server} --agent ${server.agentId}\` lists them, \`--only <tool,…>\` keeps those (or Tools on the agent's MCP tab), or give the server only to the agent that does.`,
    );
  }
  // A name the agent's `tools` list gives that its server does not offer: renamed upstream, or mistyped. The rest work.
  for (const server of mcp?.servers ?? []) {
    if (!server.unknownTools?.length) continue;
    add(
      "warn",
      `MCP server "${server.server}" (${server.agentId}) does not offer ${server.unknownTools.map((name) => `"${name}"`).join(", ")}, which that agent's tools list names`,
      `\`nouride mcp tools ${server.server} --agent ${server.agentId}\` lists the tools it has; choose again with \`--only\`, or \`--all\`.`,
    );
  }

  /**
   * Skills nobody has opened in as long as this daemon can remember.
   *
   * Every skill costs a line of *every* agent's system prompt on *every* turn, whether or not it is
   * ever read — measured at ~3.4KB for eighteen of them on a live box. So one that has never been
   * opened is a bill nobody chose to pay, and this is the only place that says so out loud.
   *
   * **"No read on record", not "not read in N days".** Last-read is `skill_reads`, which keeps every read
   * since 0.7.27 but only what the audit log still held before that — 30 days by default — so before
   * that there is no evidence either way. What can honestly be said is that nothing on record shows a
   * read, which is what this says.
   *
   * Reported as `ok` and not `warn`: an unread skill is a cost worth knowing about, not a fault. A
   * fresh install would otherwise open with a wall of warnings about skills nobody has had time to
   * use yet.
   */
  const unread = (catalog?.skills ?? []).filter((skill) => !skill.lastUsedAt);
  if (unread.length > 0 && (catalog?.skills ?? []).length > 0) {
    add(
      "ok",
      `${unread.length} of ${catalog?.skills.length ?? 0} skills have no read on record`,
      `${unread.map((s) => s.name).slice(0, 6).join(", ")}${unread.length > 6 ? ", …" : ""}. ` +
        "Each costs a line of every agent's prompt on every turn. Delete one from the Skills " +
        "Workshop, or switch it off per agent. The record keeps every read since 0.7.27, and what the audit log held before.",
    );
  }

  report(results);
}

/** The helper as boot finds it, for the daemon's situation — and whether it is expected here: Linux, not a container. */
async function isolationOf(config: GlobalConfig) {
  const finding = await findHelper(helperFolders(config, keptFolders(config)), fileOwner(config.daemon.dataDir) === 0);
  const container = (await fileExists("/.dockerenv")) || (await fileExists("/run/.containerenv"));
  return { finding, expected: process.platform === "linux" && !container };
}

function report(results: { level: "ok" | "warn" | "bad"; message: string; hint?: string }[]): void {
  const line = (result: { level: "ok" | "warn" | "bad"; message: string; hint?: string }) => {
    const mark = { ok: `${GREEN}✓${RESET}`, warn: `${YELLOW}!${RESET}`, bad: `${RED}✗${RESET}` }[result.level];
    say(`  ${mark} ${result.message}`);
    if (result.hint) say(`    ${DIM}${result.hint}${RESET}`);
  };
  say(`${BOLD}nouride doctor${RESET}`);
  say();
  for (const result of results) line(result);
  say();

  const bad = results.filter((r) => r.level === "bad").length;
  const warn = results.filter((r) => r.level === "warn").length;
  say(bad > 0 ? `${RED}${bad} problem(s)${RESET}, ${warn} warning(s)` : warn > 0 ? `${YELLOW}${warn} warning(s)${RESET}` : `${GREEN}all good${RESET}`);
  emit({ results, problems: bad, warnings: warn, ...(bad > 0 ? { error: `${bad} problem(s)` } : {}) });

  // Non-zero on a real problem so this is usable in a healthcheck or CI step. Set rather than exited with, so
  // `--json` still prints the results it found.
  if (bad > 0) process.exitCode = 1;
}
