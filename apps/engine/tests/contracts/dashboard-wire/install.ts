/**
 * The install the dashboard's mount test looks at, as a daemon serves it — what `tests/contracts/dashboard-wire.test.ts`
 * asks the real routes over the real stores, and holds `apps/dashboard/tests/fixtures/wire.json` to.
 *
 * Signed in as an admin with a session, as the dashboard is: the control token is the host's credential, which
 * `/auth/me` reports as such, not a person. Everything is the daemon's own — the pipeline the bench wires as boot
 * does, the settings, setup and account services, an approval gate, a memory filed by its nightly pass and the pass
 * that reports on it, MCP tokens, the skills hub, a conversation's work notes. Only what lies past the box is stood in for: the model list a
 * provider gives, the skill hubs' search answers, and the host's resident memory.
 *
 * Ids, paths, the version and clocks are normalised — `ses_1`, `/srv/nouride/data`, one instant, durations 0 — so
 * the file changes when a shape does, not when the test runs or the release is bumped.
 */

import { join } from "node:path";
import { Hono } from "hono";
import { setModifiedTime, writeTextFile } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import { SecretStore } from "@nouride/secrets";
import { startMemoryPass } from "@/boot/memory-pass.ts";
import { VERSION } from "@/cli/version.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { McpTokenStore } from "@/modules/mcp-server/tokens.store.ts";
import { Missions } from "@/modules/missions/missions.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { NotesStore, STALE_AFTER_MS } from "@/modules/notes/store.ts";
import { TIDY_PAST_FACTS } from "@/modules/memory/consolidate.ts";
import { SetupService } from "@/modules/setup/service.ts";
import { SkillHub } from "@/modules/skills-hub/index.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { TurnRecorder, stepsInto } from "@/modules/turns/recorder.ts";
import { SESSION_COOKIE } from "@/modules/users/auth.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { RoomNameStore } from "@/modules/rooms/room-names.store.ts";
import { buildHealth, installFingerprint } from "@/modules/web/health.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { cheapPasswords } from "../../helpers.ts";
import { GADING_DM, SAM_DM, at, household, scripted, type Household } from "../../memory/fixture.ts";
import { pipelineBench, type Bench } from "../../pipeline-bench.ts";

/** One instant every clock reads as. */
const INSTANT = 1_760_000_000_000;

/**
 * Each fixture, by the path the dashboard asks for, and how it is asked here. A conversation's two are asked with the
 * session's own id; the search with the words a person would type.
 */
const ASKED: Record<string, (ids: { session: string; mission: string }) => string> = {
  "/sessions/ses_1/turns": (ids) => `/sessions/${ids.session}/turns`,
  "/sessions/ses_1/live": (ids) => `/sessions/${ids.session}/live?after=0`,
  "/sessions/ses_1/notes": (ids) => `/sessions/${ids.session}/notes`,
  "/missions": () => "/missions",
  "/missions/msn_1": (ids) => `/missions/${ids.mission}`,
  "/policy/missions": () => "/policy/missions",
  "/setup/state": () => "/setup/state",
  "/auth/me": () => "/auth/me",
  "/status": () => "/status",
  "/health": () => "/health",
  "/setup/presets": () => "/setup/presets",
  "/web-search": () => "/web-search",
  "/secrets": () => "/secrets",
  "/providers": () => "/providers",
  "/providers/ollama/models": () => "/providers/ollama/models",
  "/skills/hub/search": () => "/skills/hub/search?q=pdf",
  "/mcp-server": () => "/mcp-server",
  "/mcp/library": () => "/mcp/library",
  "/agents/nouva/mcp": () => "/agents/nouva/mcp",
  "/people": () => "/people",
  "/groups": () => "/groups",
  "/chats": () => "/chats",
  "/memory/settings": () => "/memory/settings",
  "/llm/tiers": () => "/llm/tiers",
  "/memory/status": () => "/memory/status",
  "/memory/people": () => "/memory/people",
  "/memory/documents/gading": () => "/memory/documents/gading",
  "/memory/documents/shared": () => "/memory/documents/shared",
  "/memory/episodes": () => "/memory/episodes",
  "/memory/changes": () => "/memory/changes",
  "/memory/proposals": () => "/memory/proposals",
  "/memory/failed": () => "/memory/failed",
  "/memory/agents": () => "/memory/agents",
  "/memory/graph": () => "/memory/graph",
  // The graph with the knowledge base over it, as the Knowledge layer's switch asks for it: answered by its query.
  "/memory/graph?knowledge=1": () => "/memory/graph?knowledge=1",
  "/memory/facets": () => "/memory/facets",
  "/knowledge": () => "/knowledge",
  "/knowledge/house/documents": () => "/knowledge/house/documents",
  "/knowledge/house/document": () => "/knowledge/house/document?path=router.md",
  "/knowledge/house/related": () => "/knowledge/house/related?path=router.md",
  // What waits for an admin's yes in each (0.8.20): nothing, as the route answers it; a test that wants one waiting
  // answers it itself.
  "/knowledge/house/pending": () => "/knowledge/house/pending",
  "/knowledge/health/pending": () => "/knowledge/health/pending",
  "/knowledge/health/documents": () => "/knowledge/health/documents",
  "/knowledge/health/document": () => "/knowledge/health/document?path=lab-2026-10.md",
  "/knowledge/health/related": () => "/knowledge/health/related?path=lab-2026-10.md",
  "/knowledge/search": () => "/knowledge/search?q=router",
};

/** What lies past the box: a provider's model list, and the skill hubs — one answering, one down. */
function outside(): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1:11434/v1/models")) return json({ object: "list", data: [{ id: "llama3.2", object: "model" }, { id: "qwen3:8b", object: "model" }] });
    if (url.startsWith("https://skills.sh/api/search")) return json({ skills: [{ id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 205751 }] });
    return json({ error: "unavailable" }, 503);
  }) as typeof fetch;
}

/**
 * A memory with something in each of its views, written by its nightly pass from a scripted model: a profile and the
 * shared page, summaries with tags, someone's word about somebody else, a house rule waiting for a person, a profile
 * tidied, a conversation the model never summarized and left after its attempts, and transcripts archived.
 */
async function remembered(h: Household): Promise<void> {
  // Searched by meaning, through the provider whose model list the Settings page reads.
  h.config.memory.semantic = { enabled: true, provider: "ollama", model: "bge-m3", dimensions: 4 };
  h.dm(GADING_DM, "nouva", "Aku pakai MacBook M3 sekarang, mau ke Bali bulan depan", "Oke, dicatat.", at(14, 5));
  h.clock.now = at(15);
  await h.memory.pass(
    scripted([
      { when: "Bali", answer: { summary: "Planning a trip to Bali.", tags: ["travel"], importance: 3, facts: [{ person: "gading", op: "add", section: "Work", text: "Uses a MacBook M3." }] } },
    ]).ask,
  );
  h.dm(SAM_DM, "nix", "Mas Gading udah ganti laptop, lampu teras mati jam 22", "Oke.", at(20));
  h.dm(GADING_DM, "nouva", "Router di lorong ya", "Oke.", at(21));
  h.clock.now = at(22);
  await h.memory.pass(
    scripted([
      { when: "ganti laptop", answer: { summary: "Sam says Gading has a new laptop.", tags: ["home"], facts: [{ person: "gading", op: "add", section: "Work", text: "Got a new laptop." }], shared: [{ op: "add", section: "House", text: "The porch light goes off at 22:00." }] } },
      { when: "lorong", answer: { summary: "Where the router is.", tags: ["home"], shared: [{ op: "add", section: "House", text: "The router is in the hall." }] } },
    ]).ask,
  );
  const router = (await h.memory.proposals()).find((proposal) => JSON.stringify(proposal.operation).includes("router"));
  if (router) await h.memory.approve(router.id);

  // A profile past what the pass is shown of it, tidied: two facts merged, one dropped.
  const notes = Array.from({ length: TIDY_PAST_FACTS }, (_, n) => `- Keeps note ${n + 1} about the garden. ([[2026-09-0${(n % 9) + 1}-0900-nix]]) {sam}`);
  await writeTextFile(h.vault.person("sam"), ["---", "type: person", "name: Kak Sam", "---", "", "## Hardware", "- Owns a MacBook Air M1. ([[2026-09-01-0900-nix]]) {sam}", "- Owns a MacBook Air M1 laptop. ([[2026-09-05-0900-nix]]) {sam}", ...notes, ""].join("\n"));
  await h.memory.sync();

  h.dm(GADING_DM, "nouva", "Cari memori soal board STB", "Sebentar.", at(22, 10));
  h.clock.now = at(23);
  const unsummarized = scripted([{ when: "## Group", answer: { merge: [{ n: [1, 2], text: "Owns a MacBook Air M1 laptop." }], remove: [3] } }], { tags: [] }).ask;
  for (let night = 0; night < 4; night += 1) await h.memory.pass(unsummarized);

  // Half a year on: the filed conversations' transcripts are compacted, and kept in the archive.
  h.clock.now = at(23) + (h.config.memory.transcriptDays + 1) * 86_400_000;
  await h.memory.pass(scripted([]).ask);
  await h.memory.embedCatchUp();
}

/**
 * A knowledge base with something in each of its views: a collection everyone may be answered from, its documents read
 * (one linking another) and a photo kept but not read; one kept to two people and about one of them, for one agent;
 * one for a group; and one put away. Read, and embedded with the rest.
 */
async function kept(h: Household): Promise<void> {
  const put = (path: string, text: string) => writeTextFile(join(h.knowledgeRoot, path), text);
  await put("house/knowledge.toml", 'name = "House"\ndescription = "How the house runs: the router, the wifi, the bins."\nreaders = "everyone"\n');
  await put("house/router.md", "# Router\nThe router is in the hall. Its admin page is at 192.168.0.1.\n## Wifi\nThe password is in [[Wifi]].\n");
  await put("house/wifi.md", "# Wifi\nThe guest network is called Rumah-Tamu.\n");
  await put("house/porch.jpg", "a photo, not read");
  await put("health/knowledge.toml", 'name = "Kak Sam\'s check-ups"\ndescription = "Lab results and the next check-up dates"\nagents = ["nouva"]\nreaders = ["gading", "sam"]\nabout = ["sam"]\n');
  await put("health/lab-2026-10.md", "# Lab results, October\nBlood test on 12 October: all within range. The next one is in April.\n");
  await put("family/knowledge.toml", 'name = "Family"\nreaders = "group:telegram:main:-100200"\n');
  await put("family/recipes.md", "# Recipes\nRendang, the way Mum makes it.\n");
  await put("old/knowledge.toml", 'name = "Old notes"\narchived = true\n');
  await put("old/router-2019.md", "# The old router\nReplaced in 2024.\n");
  // One time for every file: written a millisecond apart or in the same one, two documents ranked equal sat in either
  // order (the graph puts the newest first), and the fixture differed from one run to the next.
  for (const path of ["house/router.md", "house/wifi.md", "house/porch.jpg", "health/lab-2026-10.md", "family/recipes.md", "old/router-2019.md"]) {
    setModifiedTime(join(h.knowledgeRoot, path), INSTANT);
  }
  await h.memory.knowledge.sync();
  await h.memory.embedCatchUp();
}

/** A conversation with one finished turn and one at work: a call, a helper's call, a wait on an approval. */
function conversation(bench: Bench): { session: string; done: string; working: string } {
  const session = bench.sessions.load({ agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" });
  const where = { sessionId: session.id, agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
  const done = TurnRecorder.begin(bench.turns, { ...where, prompt: "is the disk full?" })!;
  done.step("tool", "exec df -h", { callId: "c1", name: "exec" });
  done.step("tool_done", "exec ok · 12ms", { callId: "c1", name: "exec", error: false, outcome: "ok" });
  done.finish({ status: "done", reply: "No — 40% used.", model: "test-model", toolCalls: 1, inputTokens: 120, outputTokens: 8 });
  const working = TurnRecorder.begin(bench.turns, { ...where, prompt: "clean the build" })!;
  working.step("reasoning", "The build directory is large; a helper can check the cache.");
  working.step("tool", "delegate 1 task", { callId: "c2", name: "delegate" });
  stepsInto(bench.turns, working.id, { via: "delegate", by: "nouva" })!("tool", "du -sh cache", { callId: "c3", name: "exec" });
  working.step("waiting", "waiting for approval: exec", { callId: "c4", name: "exec", approvalId: "apr_1" });
  // Written as a finished turn writes it — the conversation is known by its id, as its work notes are looked up.
  bench.sessions.save(where, [{ role: "user", content: "is the disk full?", timestamp: Date.now() }, { role: "assistant", content: "No — 40% used." }], 12);
  return { session: session.id, done: done.id, working: working.id };
}

/**
 * The conversation's work notes, as the agent's tools leave them: a task with its sub-headings and the plan kept with
 * it — a step of each state, the skipped one with why — and a task untouched for two weeks, set aside by the sweep.
 */
async function workNotes(dataDir: string): Promise<NotesStore> {
  let now = INSTANT - STALE_AFTER_MS - 86_400_000;
  const notes = new NotesStore(join(dataDir, "notes"), () => now);
  const key = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
  await notes.write(key, "Try the remote cache", "Parked: the remote cache needs a token nobody has.");
  now = INSTANT;
  await notes.write(key, "Clean the build", "### Goal\nFree space on the build disk.\n\n### Done\n- Measured the cache: 41 GB.\n\n### Next\n- Ask before deleting anything.");
  await notes.keepPlan(key, "Clean the build", [
    { text: "Measure the cache", state: "done" },
    { text: "Ask before deleting", state: "active" },
    { text: "Delete artifacts older than a week", state: "pending" },
    { text: "Prune Docker images", state: "skipped", reason: "no Docker on this box" },
  ]);
  await notes.sweep(now);
  return notes;
}

/**
 * Two missions of nouva's, as a person starts them from the dashboard: one at work, its checklist part done with a note
 * on the finished step, and one stopped. Each has a folder of its own, so no mission id is in a path.
 */
async function missions(bench: Bench, notes: NotesStore): Promise<{ missions: Missions; working: string; stopped: string }> {
  const service = new Missions({
    store: new MissionStore(bench.db),
    settings: () => ({ perAgent: 2, maxRunning: 2, limitHours: 8, limitTurns: 50, limitTokens: 50_000_000 }),
    agents: { exists: () => true, asleep: () => false, privateDir: () => "/srv/nouride/workspace/private/nouva" },
    notes,
    parked: () => [],
    tell: async () => {},
    queueTurn: () => true,
    stopTurn: () => {},
    branchRefusal: async () => null,
    prepare: async () => {},
    check: async () => ({ passed: true, failed: null }),
    now: () => INSTANT,
  });
  const start = (goal: string, workdir: string) => {
    const started = service.start({ agentId: "nouva", goal, checks: ["test -s report.md"], workdir, startedBy: "usr_1", gatewayId: "web:dashboard", chatId: "missions" });
    if ("refused" in started) throw new Error(started.refused);
    return started.mission.id;
  };
  const working = start("Write a report on the disk usage of the build box", "/srv/nouride/workspace/shared/report");
  await notes.keepPlan({ agentId: "nouva", gatewayId: "web:mission", chatId: working }, "Mission", [
    { text: "Measure each directory", state: "done", note: "du in sizes.txt — build/ is 41 GB" },
    { text: "Write report.md", state: "active" },
    { text: "Check it reads well", state: "pending" },
  ]);
  const stopped = start("Tidy the old logs", "/srv/nouride/workspace/shared/logs");
  service.stop(stopped, "tester");
  return { missions: service, working, stopped };
}

/** A Telegram group nouva talks in, named by Telegram and renamed by the operator, where Gading and a stranger spoke. */
function aGroup(bench: Bench): void {
  const where = { agentId: "nouva", gatewayId: "telegram:main", chatId: "-100200" };
  bench.sessions.save(where, [{ role: "user", content: "Gading: lampu teras mati", timestamp: INSTANT }, { role: "assistant", content: "Kucek." }], 10);
  const log = new RoomMessageStore(bench.db);
  log.record({ id: "g1", gatewayId: where.gatewayId, chatId: where.chatId, senderId: "999", senderName: "Tetangga", text: "halo", at: INSTANT });
  log.record({ id: "g2", gatewayId: where.gatewayId, chatId: where.chatId, senderId: "814", senderName: "gading_n", text: "lampu teras mati", at: INSTANT + 1 });
  const names = new RoomNameStore(bench.db);
  names.setPlatformTitle("telegram", where.chatId, "Keluarga Besar");
  names.choose("telegram", where.chatId, "Rumah");
}

/** Ids and paths by the names the fixture gives them, clocks to one instant, durations (`ms`, `…Ms`) to 0. */
function normalised(value: unknown, names: Map<string, string>): unknown {
  if (typeof value === "string") {
    let out = names.get(value) ?? value;
    for (const [from, to] of names) if (from.startsWith("/") && out.includes(from)) out = out.split(from).join(to);
    // A clock written as text (a secret's `addedAt`, 0.8.19) is the same one instant as one written as a number.
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(out) ? new Date(INSTANT).toISOString() : out;
  }
  if (typeof value === "number") return value >= 1_000_000_000 ? INSTANT : value;
  if (Array.isArray(value)) return value.map((item) => normalised(item, names));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "ms" || (key.endsWith("Ms") && typeof item === "number") ? 0 : normalised(item, names)]));
  }
  return value;
}

/** Every fixture the mount test answers from, as the routes answer it now. */
export async function wireAnswers(): Promise<Record<string, unknown>> {
  const home = await household({ embed: (texts) => texts.map(() => [1, 0, 0, 0]) });
  const bench = await pipelineBench({
    config: {
      providers: {
        test: { kind: "openai", base_url: "https://fake.test/v1", api_key: "testkey" },
        ollama: { kind: "openai", base_url: "http://127.0.0.1:11434/v1", api_key: "testkey" },
      },
      people: home.config.people.map((person) => ({ key: person.key, name: person.name, ids: person.ids })),
      mcp_server: { enabled: true },
    },
    deps: ({ db }) => ({ roomMessages: new RoomMessageStore(db) }),
  });
  const { config, db, dataDir, agentsDir, registry, providers } = bench;
  const audit = new AuditLog(db);
  const approvals = new SqliteApprovalGate({ db, timeoutMs: 300_000 });
  // The household's memory settings, one object, so the Settings page describes the memory it shows.
  config.memory = home.config.memory;
  config.daemon.timezone = home.config.daemon.timezone;
  const pass = startMemoryPass({ config, registry, providers, memory: home.memory, now: () => home.clock.now });
  try {
    await remembered(home);
    await kept(home);
    const configPath = join(dataDir, "config.toml");
    await writeTextFile(configPath, "");
    const secrets = await SecretStore.open(dataDir, { TESTKEY: "sk-test" });
    await secrets.set("team_brave", "EXAMPLE-not-a-real-key");
    // The MCP library: a remote server waiting for its login, and a stdio one nouva uses with the library's variable.
    await writeTextFile(
      join(agentsDir, "mcp.toml"),
      ['[[servers]]', 'name = "notion"', 'transport = "streamable-http"', 'url = "https://mcp.notion.com/mcp"', "",
        '[[servers]]', 'name = "github"', 'transport = "stdio"', 'command = "npx"', 'args = ["-y", "@acme/github-mcp"]', 'env_secrets = { GITHUB_TOKEN = "mcp-lib-github-github_token" }', ""].join("\n"),
    );
    await secrets.set("mcp-lib-github-github_token", "EXAMPLE-not-a-real-token");
    await writeTextFile(join(agentsDir, "nouva", "mcp.toml"), "[servers.github]\non = true\n");
    await registry.reload("nouva");
    const users = new UserStore({ db, passwords: cheapPasswords, audit });
    const tester = await users.create({ username: "tester", password: "tester-password-1", role: "admin", createdBy: "test" });
    const cookie = `${SESSION_COOKIE}=${users.startSession(tester.id).token}`;
    const mcpTokens = new McpTokenStore(db);
    const token = mcpTokens.create({ person: "gading", agents: ["nouva"], scopes: ["memory", "personas"], label: "zed", now: INSTANT, expiresAt: null }).token;

    const notes = await workNotes(dataDir);
    const work = await missions(bench, notes);
    const ctx = { config, db, gateways: bench.gateways, startedAt: Date.now(), configSource: configPath, status: "ready", agentCount: 1, providerErrors: new Map() } as unknown as DaemonContext;
    const app = new Hono();
    mountControlRoutes(app, {
      ctx,
      token: "control-token-for-tests-0000000000",
      secrets,
      settings: new SettingsService({ config, configPath, secrets, providers, gatewayStatus: () => ctx.gateways, keyHeld: () => null, audit }),
      setup: new SetupService({ config, configPath, dataDir, agentsDir, secrets, providers, registry, audit, userCount: () => users.count(), fetchImpl: outside() }),
      skillHub: new SkillHub({ scratchDir: dataDir, agentsDir, reflection: {} as never, fetchImpl: outside(), checkUrlImpl: async () => ({ allowed: true }) as never }),
      users,
      audit,
      approvals,
      pipeline: bench.pipeline,
      registry,
      providers,
      access: bench.access,
      sessions: bench.sessions,
      turns: bench.turns,
      events: bench.events,
      memory: home.memory,
      memoryPass: pass,
      mcpTokens,
      notes,
      missions: work.missions,
      local: { id: "web:dashboard" },
    } as unknown as ControlDeps);

    const ids = conversation(bench);
    aGroup(bench);
    const names = new Map<string, string>([
      [ids.session, "ses_1"],
      [ids.done, "turn_1"],
      [ids.working, "turn_2"],
      [work.working, "msn_1"],
      [work.stopped, "msn_2"],
      [sessionIdFor({ agentId: "nouva", gatewayId: "web:mission", chatId: work.working }), "ses_msn_1"],
      [tester.id, "usr_1"],
      [token.id, "tok_1"],
      [installFingerprint(dataDir), "install_1"],
      [VERSION, "0.7.10"],
      ...(await home.memory.proposals()).map((proposal, n): [string, string] => [proposal.id, `prp_${n + 1}`]),
      [dataDir, "/srv/nouride/data"],
      [agentsDir, "/srv/nouride/agents"],
      [home.config.memory.dir, "/srv/nouride/memory"],
    ]);
    const answered: Record<string, unknown> = {};
    for (const [fixture, asked] of Object.entries(ASKED)) {
      const path = asked({ session: ids.session, mission: work.working });
      const answer =
        path === "/health"
          ? buildHealth(ctx, () => ({ rssMb: 64, heapUsedMb: 32 }) as never).payload
          : await (await app.request(`/api/control${path}`, { headers: { cookie } }, { clientAddress: "203.0.113.10" })).json();
      answered[fixture] = normalised(answer, names);
    }
    return answered;
  } finally {
    clearInterval(pass.timer);
    approvals.shutDown();
    audit.stop();
    bench.dispose();
    home.close();
  }
}
