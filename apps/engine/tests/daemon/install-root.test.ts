/**
 * An install moved, or copied, to another folder and started there (`boot/install-root.ts`, 0.8.18, the review's B2):
 * every path its database names under the old folder is renamed under the new one, the grants bound to a directory
 * there are keyed again so they still match, and the new folder is recorded. What records what happened, and what was
 * never under the install, stays as it was.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { execGrantKey, toolGrantKey } from "@nouride/policy";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { settleInstallRoot } from "@/boot/install-root.ts";
import { GrantStore } from "@/modules/tools/grants.store.ts";
import { ToolGrantStore } from "@/modules/tools/tool-grants.store.ts";
import { tempDir } from "../helpers.ts";

const lines: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "daemon" && lines.push(entry)));
beforeEach(() => void lines.splice(0));

/** An install's three places, each under `root` as `[daemon]`'s defaults put them. */
const placesOf = (root: string) => ({ dataDir: join(root, "data"), workspaceDir: join(root, "workspace"), agentsDir: join(root, "agents") });
const recordOf = (root: string) => ({ path: root, workspace: join(root, "workspace"), agents: join(root, "agents") });

function open(root: string): { db: SqliteDb; rows: DaemonStateStore } {
  mkdirSync(join(root, "data"), { recursive: true });
  const db = openDatabase(join(root, "data", "nouride.db"));
  void migrate(db);
  return { db, rows: new DaemonStateStore(db) };
}

/**
 * An install at `root`, started there once (its folder recorded), whose database names a path under it in every column
 * that holds one — and, beside them, what must not change: a record of what happened, a path outside the install, a
 * grant whose key cannot be made again.
 */
function madeAt(root: string): SqliteDb {
  const { db, rows } = open(root);
  settleInstallRoot(placesOf(root), db, rows);
  const at = (path: string) => join(root, path);
  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);

  run("INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, log_path, started_at) VALUES ('j1', 'nix', 'telegram:nouva', '555', 'bun test', ?, 'succeeded', ?, 1)", at("workspace/shared/app"), at("jobs/nix/j1.log"));
  run("INSERT INTO chat_attachments (ref, gateway, chat_id, gateway_id, name, mime_type, kind, local_path, at) VALUES ('a1', 'telegram', '555', 'telegram:nouva', 'photo.jpg', 'image/jpeg', 'image', ?, 1)", at("attachments/nouva/555/photo.jpg"));
  run("INSERT INTO chat_messages (id, gateway_id, chat_id, sender_id, text, attachments, at) VALUES ('m1', 'telegram:nouva', '555', 'gading', 'look', ?, 1)", JSON.stringify([{ type: "image", url: at("attachments/nouva/555/photo.jpg") }]));
  run("INSERT INTO sessions (id, agent_id, chat_id, gateway, created_at, updated_at) VALUES ('s1', 'nouva', '555', 'telegram:nouva', 1, 1)");
  run("INSERT INTO session_messages (session_id, seq, hash, message) VALUES ('s1', 0, 'h0', ?)", JSON.stringify({ role: "tool", content: `Full output: ${at("tool-output/nouva/s1/call.txt")}` }));
  run("INSERT INTO turn_records (id, session_id, agent_id, gateway_id, chat_id, status, prompt, started_at, attachments) VALUES ('t1', 's1', 'nouva', 'telegram:nouva', '555', 'done', 'look', 1, ?)", JSON.stringify([at("attachments/nouva/555/photo.jpg")]));
  run("INSERT INTO turn_journal (turn_id, seq, at, entry) VALUES ('t1', 0, 1, ?)", JSON.stringify({ message: { role: "tool", content: at("tool-output/nouva/s1/call.txt") } }));
  run(
    "INSERT INTO missions (id, agent_id, started_by, gateway_id, chat_id, goal, checks, status, files, workdir, limit_hours, limit_turns, limit_tokens, created_at, updated_at) VALUES ('msn_1', 'nix', 'gading', 'telegram:nouva', '555', 'fix it', ?, 'running', ?, ?, 4, 50, 1000000, 1, 1)",
    JSON.stringify([`bun test ${at("workspace/private/nix/missions/msn_1/test")}`]),
    JSON.stringify([at("workspace/private/nix/missions/msn_1/report.md")]),
    at("workspace/private/nix/missions/msn_1"),
  );
  // A mission in a repository of the person's own, outside the install: it did not move.
  run("INSERT INTO missions (id, agent_id, started_by, gateway_id, chat_id, goal, status, workdir, limit_hours, limit_turns, limit_tokens, created_at, updated_at) VALUES ('msn_2', 'nix', 'gading', 'telegram:nouva', '555', 'ship it', 'running', '/srv/repos/app', 4, 50, 1000000, 1, 1)");
  run("INSERT INTO cron_jobs (id, agent_id, name, schedule, payload, created_at) VALUES ('c1', 'nix', 'nightly', '{}', ?, 1)", JSON.stringify({ kind: "command", argv: ["sh", at("workspace/shared/nightly.sh")], cwd: at("workspace/shared"), then: "deliver" }));
  run("INSERT INTO inbox (id, gateway_id, chat_id, received_at, sent_at, status, envelope) VALUES ('web:dashboard:c:1', 'web:dashboard', 'c', 1, 1, 'queued', ?)", JSON.stringify({ attachments: [{ type: "file", url: at("data/uploads/report.pdf") }] }));
  run("INSERT INTO skill_reads (path, watched_since, read_at) VALUES (?, 1, 5)", at("agents/skills/deploy/SKILL.md"));
  run("INSERT INTO skill_drafts (id, created_at, agent_id, trigger_kind, trigger_reason, name, description, body, status, published_path) VALUES ('d1', 1, 'nix', 'user_request', 'asked', 'deploy', 'd', 'b', 'approved', ?)", at("agents/skills/deploy/SKILL.md"));
  // What happened, and where it happened then: a record, never rewritten.
  run("INSERT INTO audit_log (id, timestamp, action, details) VALUES ('au1', 1, 'tool_exec', ?)", JSON.stringify({ cwd: at("workspace/shared/app") }));

  const grant = (id: string, cwd: string, argv: string[], extra: { secrets?: string[]; revoked?: boolean } = {}) => {
    const key = execGrantKey({ agentId: "nix", cwd, argv, fileSha256: "ab12", ...(extra.secrets ? { secrets: extra.secrets } : {}) });
    run(
      "INSERT INTO exec_grants (grant_key, id, agent_id, command_text, argv, cwd, file_sha256, created_at, created_by, policy_snapshot, revoked_at) VALUES (?, ?, 'nix', ?, ?, ?, 'ab12', 1, 'gading', '{}', ?)",
      key, id, argv.join(" "), JSON.stringify(argv), cwd, extra.revoked ? 2 : null,
    );
  };
  grant("g1", at("workspace/shared/app"), ["bash", at("workspace/shared/app/deploy.sh")]);
  // Keyed with the secrets its command is handed, whose names the row does not keep.
  grant("g2", at("workspace/shared/app"), ["gh", "release", "create"], { secrets: ["github_token"] });
  grant("g3", at("workspace/shared/app"), ["make"], { revoked: true });
  run(
    "INSERT INTO tool_grants (id, grant_key, agent_id, tool, scope_dir, created_at, created_by) VALUES ('tg1', ?, 'nix', 'write', ?, 1, 'gading')",
    toolGrantKey({ agentId: "nix", tool: "write", scopeDir: at("workspace/private/nix") }),
    at("workspace/private/nix"),
  );
  return db;
}

/** The rows a move rewrites, and those it must leave, read whole. */
function dump(db: SqliteDb): Record<string, unknown[]> {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    jobs: all("SELECT cwd, log_path FROM jobs"),
    attachments: all("SELECT local_path FROM chat_attachments"),
    messages: all("SELECT attachments FROM chat_messages"),
    session: all("SELECT hash, message FROM session_messages"),
    turns: all("SELECT attachments FROM turn_records"),
    journal: all("SELECT entry FROM turn_journal"),
    missions: all("SELECT id, workdir, files, checks FROM missions ORDER BY id"),
    cron: all("SELECT payload FROM cron_jobs"),
    inbox: all("SELECT envelope FROM inbox"),
    reads: all("SELECT path, watched_since, read_at FROM skill_reads"),
    drafts: all("SELECT published_path FROM skill_drafts"),
    audit: all("SELECT details FROM audit_log WHERE id = 'au1'"),
    exec: all("SELECT id, grant_key, cwd, argv, command_text FROM exec_grants ORDER BY id"),
    tool: all("SELECT grant_key, scope_dir FROM tool_grants"),
  };
}

describe("an install started from another folder than the one it was made in", () => {
  test("has every path under the old folder renamed under the new, its grants keyed again, and the new folder recorded", () => {
    const base = tempDir("install-root");
    const [a, b] = [join(base, "a", ".nouride"), join(base, "b", ".nouride")];
    const before = madeAt(a);
    const made = dump(before);
    before.close();
    cpSync(a, b, { recursive: true });

    const { db, rows } = open(b);
    settleInstallRoot(placesOf(b), db, rows);

    const swap = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(`${a}/`, `${b}/`)) as unknown[];
    const now = dump(db);
    for (const table of ["jobs", "attachments", "messages", "turns", "journal", "missions", "cron", "inbox", "reads", "drafts"] as const) {
      expect({ table, rows: now[table] }).toEqual({ table, rows: swap(made[table]) });
    }
    // The second mission's repository was never in the install.
    expect((now.missions as { workdir: string }[]).map((mission) => mission.workdir)).toEqual([join(b, "workspace/private/nix/missions/msn_1"), "/srv/repos/app"]);
    // A message's hash was of its old text: cleared, so the session store writes it once more with its own.
    expect(now.session).toEqual([{ hash: null, message: JSON.stringify({ role: "tool", content: `Full output: ${join(b, "tool-output/nouva/s1/call.txt")}` }) }]);
    // A record of what happened says where it happened then.
    expect(now.audit).toEqual(made.audit);

    // The grant the gate matches by its key: made of the new folder now, so `bash …/deploy.sh` there is still allowed.
    const g1 = { agentId: "nix", cwd: join(b, "workspace/shared/app"), argv: ["bash", join(b, "workspace/shared/app/deploy.sh")], fileSha256: "ab12" };
    expect(new GrantStore(db).liveKeys("nix")).toEqual(new Set([execGrantKey(g1), (made.exec as { grant_key: string }[])[1]!.grant_key]));
    expect((now.exec as Record<string, unknown>[])[0]).toEqual({ id: "g1", grant_key: execGrantKey(g1), cwd: g1.cwd, argv: JSON.stringify(g1.argv), command_text: g1.argv.join(" ") });
    // One keyed with its command's secrets, and a revoked one, stay as they were.
    expect((now.exec as unknown[]).slice(1)).toEqual((made.exec as unknown[]).slice(1));
    expect(new ToolGrantStore({ db }).liveKeys("nix")).toEqual(new Set([toolGrantKey({ agentId: "nix", tool: "write", scopeDir: join(b, "workspace/private/nix") })]));

    expect(JSON.parse(rows.get("install-root")!)).toEqual(recordOf(b));
    // Each place followed on its own, the most specific first: fourteen columns' rows and the two grants keyed again.
    const said = lines.filter((line) => line.message.startsWith("the install was moved")).map((line) => line.data as { from: string; to: string; rows: number });
    expect(said.map(({ from, to }) => [from, to])).toEqual([[a, b], [join(a, "workspace"), join(b, "workspace")], [join(a, "agents"), join(b, "agents")]]);
    expect(said.reduce((sum, line) => sum + line.rows, 0)).toBe(16);
  });

  test("a data_dir moved to another disk alone: what is under its folder follows it, the workspace and the packs that stayed keep their paths", () => {
    const base = tempDir("install-root-data");
    const a = join(base, "a", ".nouride");
    const ssd = join(base, "ssd", "nouride");
    const db = madeAt(a);
    const made = dump(db);
    const rows = new DaemonStateStore(db);

    // `[daemon] data_dir` set to the other disk; `workspace_dir` and `agents_dir` written as they were.
    settleInstallRoot({ dataDir: join(ssd, "data"), workspaceDir: join(a, "workspace"), agentsDir: join(a, "agents") }, db, rows);

    const now = dump(db);
    expect(now.jobs).toEqual([{ cwd: join(a, "workspace/shared/app"), log_path: join(ssd, "jobs/nix/j1.log") }]);
    expect(now.attachments).toEqual([{ local_path: join(ssd, "attachments/nouva/555/photo.jpg") }]);
    expect(now.inbox).toEqual([{ envelope: JSON.stringify({ attachments: [{ type: "file", url: join(ssd, "data/uploads/report.pdf") }] }) }]);
    expect((now.session as { message: string }[])[0]!.message).toContain(join(ssd, "tool-output/nouva/s1/call.txt"));
    // The workspace and the packs did not move: a mission's folder, a scheduled command, a skill, a grant stay.
    expect(now.missions).toEqual(made.missions);
    expect(now.cron).toEqual(made.cron);
    expect(now.reads).toEqual(made.reads);
    expect(now.drafts).toEqual(made.drafts);
    expect(now.exec).toEqual(made.exec);
    expect(now.tool).toEqual(made.tool);
    expect(JSON.stringify(now)).not.toContain(".nouride-set-aside-");
    expect(JSON.parse(rows.get("install-root")!)).toEqual({ path: ssd, workspace: join(a, "workspace"), agents: join(a, "agents") });
  });

  test("a workspace moved alone to another disk: its paths follow it, its grants keyed again, and nothing else changes", () => {
    const base = tempDir("install-root-workspace");
    const a = join(base, "a", ".nouride");
    const disk = join(base, "big-disk", "workspace");
    const db = madeAt(a);
    const made = dump(db);
    const rows = new DaemonStateStore(db);

    settleInstallRoot({ dataDir: join(a, "data"), workspaceDir: disk, agentsDir: join(a, "agents") }, db, rows);

    const now = dump(db);
    expect(now.jobs).toEqual([{ cwd: join(disk, "shared/app"), log_path: join(a, "jobs/nix/j1.log") }]);
    expect((now.missions as { workdir: string }[]).map((mission) => mission.workdir)).toEqual([join(disk, "private/nix/missions/msn_1"), "/srv/repos/app"]);
    expect(now.attachments).toEqual(made.attachments);
    expect(now.reads).toEqual(made.reads);
    const g1 = { agentId: "nix", cwd: join(disk, "shared/app"), argv: ["bash", join(disk, "shared/app/deploy.sh")], fileSha256: "ab12" };
    expect(new GrantStore(db).liveKeys("nix").has(execGrantKey(g1))).toBe(true);
    expect(new ToolGrantStore({ db }).liveKeys("nix")).toEqual(new Set([toolGrantKey({ agentId: "nix", tool: "write", scopeDir: join(disk, "private/nix") })]));
  });

  test("the install moved, and its workspace to another disk at the same time: each path follows where its own folder went", () => {
    const base = tempDir("install-root-both");
    const a = join(base, "a", ".nouride");
    const b = join(base, "b", ".nouride");
    const disk = join(base, "big-disk", "workspace");
    const db = madeAt(a);
    const rows = new DaemonStateStore(db);

    settleInstallRoot({ dataDir: join(b, "data"), workspaceDir: disk, agentsDir: join(b, "agents") }, db, rows);

    const now = dump(db);
    // The workspace's own rename first: the folder's, done first, would have put these under b/workspace.
    expect(now.jobs).toEqual([{ cwd: join(disk, "shared/app"), log_path: join(b, "jobs/nix/j1.log") }]);
    expect(now.reads).toEqual([{ path: join(b, "agents/skills/deploy/SKILL.md"), watched_since: 1, read_at: 5 }]);
  });

  test("started again where it is, renames nothing and says nothing", () => {
    const base = tempDir("install-root-same");
    const a = join(base, "a", ".nouride");
    const db = madeAt(a);
    const made = dump(db);
    const rows = new DaemonStateStore(db);
    const recorded = db.prepare("SELECT value, updated_at FROM daemon_state WHERE name = 'install-root'").get();

    settleInstallRoot(placesOf(a), db, rows);

    expect(dump(db)).toEqual(made);
    // Not even the hash a rename clears.
    expect((dump(db).session as { hash: string }[])[0]!.hash).toBe("h0");
    expect(db.prepare("SELECT value, updated_at FROM daemon_state WHERE name = 'install-root'").get()).toEqual(recorded);
    expect(lines).toEqual([]);
  });

  test("the first start that records it renames nothing: there is no record of where it was before", () => {
    const a = join(tempDir("install-root-first"), ".nouride");
    const { db, rows } = open(a);
    db.prepare("INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, log_path, started_at) VALUES ('j1', 'nix', 'g', 'c', 'x', '/elsewhere/.nouride/workspace', 'succeeded', '/elsewhere/.nouride/jobs/nix/j1.log', 1)").run();

    settleInstallRoot(placesOf(a), db, rows);

    expect(db.prepare("SELECT cwd, log_path FROM jobs").get()).toEqual({ cwd: "/elsewhere/.nouride/workspace", log_path: "/elsewhere/.nouride/jobs/nix/j1.log" });
    expect(JSON.parse(rows.get("install-root")!)).toEqual(recordOf(a));
    expect(lines).toEqual([]);
  });

  test("moved from a folder too near the filesystem's root to rename by, renames nothing, says so, and records the new one", () => {
    const b = join(tempDir("install-root-near"), ".nouride");
    const { db, rows } = open(b);
    // A data directory set to `/srv/data`: its folder is `/srv`, and `/srv/` is in `/home/me/srv/` too.
    rows.set("install-root", JSON.stringify({ path: "/srv" }));
    db.prepare("INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, log_path, started_at) VALUES ('j1', 'nix', 'g', 'c', 'x', '/home/me/srv/app', 'succeeded', '/srv/jobs/nix/j1.log', 1)").run();

    settleInstallRoot(placesOf(b), db, rows);

    expect(db.prepare("SELECT cwd, log_path FROM jobs").get()).toEqual({ cwd: "/home/me/srv/app", log_path: "/srv/jobs/nix/j1.log" });
    expect(lines.map((line) => [line.level, line.message.split(":")[0]])).toEqual([["warn", "the install was moved, from a folder too near the filesystem's root to rename by"]]);
    expect(JSON.parse(rows.get("install-root")!)).toEqual(recordOf(b));
  });
});
