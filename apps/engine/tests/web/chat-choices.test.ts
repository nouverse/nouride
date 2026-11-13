/**
 * A conversation's model and effort picked on its page (`web/control/routes/chat-choices.ts`): the real routes over the
 * real pipeline and the dashboard's own gateway, so a pick is seen where it counts, in the request a model is sent.
 *
 * The page's picker is `/model` and `/effort` with no message. Each case is a way the two could come apart, or a way
 * a pick could reach where it must not: a first answer from the agent's own model after another was picked, a command
 * that does not see the page's pick, a pick that outlives its conversation or lands in somebody else's, a level a
 * coding CLI does not offer kept as if it were, a list of models handed to an account that only reads.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sessionIdFor } from "@nouride/shared";
import type { ChatChoices } from "@nouride/wire";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { registerChatRoutes } from "@/modules/web/control/routes/chat.ts";
import { registerChatChoiceRoutes } from "@/modules/web/control/routes/chat-choices.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const PEOPLE = [
  { key: "gading", name: "Gading", ids: ["web:u1"] },
  { key: "rina", name: "Rina", ids: ["web:u2"] },
  { key: "sari", name: "Sari", ids: ["web:u4"] },
];
const ACCOUNTS = {
  gading: { kind: "user", actor: "gading", role: "admin", user: { id: "u1", username: "gading", displayName: "", role: "admin" } },
  rina: { kind: "user", actor: "rina", role: "operator", user: { id: "u2", username: "rina", displayName: "", role: "operator" } },
  tamu: { kind: "user", actor: "tamu", role: "viewer", user: { id: "u3", username: "tamu", displayName: "", role: "viewer" } },
  sari: { kind: "user", actor: "sari", role: "operator", user: { id: "u4", username: "sari", displayName: "", role: "operator" } },
} as const;
type Who = keyof typeof ACCOUNTS;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

interface Options {
  /** A coding CLI answers the agent: what it offers, and the model its pack names. */
  cli?: { models: { value: string; name?: string }[]; efforts: string[]; packModel?: string; runsOn?: string };
  /** What the provider's own list answers: names, or a failure. */
  listed?: string[] | "fails";
}

/** A daemon with one agent, `nouva`, on `test-model` at its own level `low`, the dashboard's chat and a Telegram bot. */
async function daemon(options: Options = {}) {
  /** The model and the level each request to the provider carried. */
  const carried: { model: string; effort?: string }[] = [];
  const local = new LocalGateway();
  const bot = new FakeGateway("telegram:nouva", "telegram");
  const bench: Bench = await pipelineBench({
    turns: Array.from({ length: 8 }, (_, n) => ({ text: `answer ${n + 1}` })),
    gateways: [local, bot],
    agentToml: '[llm]\nprovider = "test"\neffort = "low"\n',
    fetch: (scripted) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; reasoning_effort?: string };
        carried.push({ model: body.model, ...(body.reasoning_effort ? { effort: body.reasoning_effort } : {}) });
        return await scripted(url, init);
      }) as typeof fetch,
  });
  cleanup.push(bench.dispose);
  bench.pipeline.attach();
  const agent = bench.registry.get("nouva")!;
  if (options.cli) (agent.config as { external?: unknown }).external = { cli: "claude", ...(options.cli.packModel ? { model: options.cli.packModel } : {}) };

  const rooms = new RoomStore(bench.db);
  const probes: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const deps = {
    local,
    sessions: bench.sessions,
    turns: bench.turns,
    registry: bench.registry,
    pipeline: bench.pipeline,
    providers: bench.providers,
    rooms,
    audit: { record: (row: Record<string, unknown>) => void audits.push(row) },
    ctx: { config: { daemon: { orchestrator: "nouva" }, people: PEOPLE } },
    setup: {
      probe: async (endpoint: { baseUrl: string }) => {
        probes.push(endpoint.baseUrl);
        return options.listed === "fails" ? { ok: false, why: "unreachable", error: "connection refused" } : { ok: true, models: options.listed ?? ["test-model", "other-model", "text-embedding-3"] };
      },
    },
    ...(options.cli
      ? {
          externalAgents: {
            row: (id: string) => (id === "claude" ? { id, name: "Claude Code" } : undefined),
            models: { of: () => options.cli!.models, runsOn: () => options.cli!.runsOn ?? null },
            efforts: { of: () => options.cli!.efforts.map((value) => ({ value })) },
          },
        }
      : {}),
  };
  let as: Who = "rina";
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", ACCOUNTS[as]);
    await next();
  });
  registerChatRoutes(app as never, deps as never);
  registerChatChoiceRoutes(app as never, deps as never);

  const call = async <T>(who: Who, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    as = who;
    const res = await app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as T };
  };
  /** A message from the page, and its turn run to its end. */
  const send = async (who: Who, body: Record<string, unknown>) => {
    const sent = await call<{ sessionId?: string; chatId?: string; error?: string; plain?: string }>(who, "POST", "/chat/send", { agent: "nouva", ...body });
    await bench.pipeline.idle();
    return sent;
  };
  const choices = (who: Who, query: string) => call<ChatChoices & { error?: string }>(who, "GET", `/chat/choices?${query}`);
  const choose = (who: Who, body: Record<string, unknown>) => call<ChatChoices & { error?: string; plain?: string }>(who, "POST", "/chat/choices", body);
  return { bench, bot, local, rooms, carried, probes, audits, call, send, choices, choose };
}

describe("what a conversation is answered with", () => {
  test("one not begun: the agent's own model and level, every level to choose from, nothing chosen", async () => {
    const h = await daemon();
    const { status, body } = await h.choices("rina", "agent=nouva");
    expect(status).toBe(200);
    expect(body).toEqual({ model: { own: "test-model" }, effort: { own: "low" }, efforts: ["low", "medium", "high", "xhigh", "max"] });
  });

  test("an agent that is not there is said as that, and so is a conversation nobody has", async () => {
    const h = await daemon();
    expect((await h.choices("rina", "agent=ghost")).status).toBe(404);
    expect((await h.choices("rina", "session=ses_nothing")).status).toBe(404);
    expect((await h.choices("rina", "")).status).toBe(404);
  });
});

describe("a model and a level picked before a conversation's first message", () => {
  test("come with that message: its answer is the picked model's, at the picked level, and the page reads the pick back", async () => {
    const h = await daemon();
    const sent = await h.send("rina", { text: "halo", model: "other-model", effort: "high" });
    expect(sent.status).toBe(200);
    expect(h.carried).toEqual([{ model: "other-model", effort: "high" }]);
    const { body } = await h.choices("rina", `session=${encodeURIComponent(sent.body.sessionId!)}`);
    expect(body.model).toEqual({ own: "test-model", chosen: "other-model" });
    expect(body.effort).toEqual({ own: "low", chosen: "high" });
    // The next message of the same conversation stays on it, with nothing said again.
    await h.send("rina", { sessionId: sent.body.sessionId, text: "lagi" });
    expect(h.carried.at(-1)).toEqual({ model: "other-model", effort: "high" });
  });

  test("the conversation is the picker's own from its first moment: its pick wrote the row before anybody had spoken", async () => {
    const h = await daemon();
    // Held open: the first turn is still running when the page asks.
    const sent = await h.call<{ sessionId: string }>("rina", "POST", "/chat/send", { agent: "nouva", text: "halo", model: "other-model" });
    const session = `session=${encodeURIComponent(sent.body.sessionId)}`;
    expect(h.bench.sessions.find(sent.body.sessionId)?.openedBy).toBeUndefined();
    expect((await h.choices("rina", session)).status).toBe(200);
    // And nobody else's, as before: another operator finds nothing there.
    expect((await h.choices("sari", session)).status).toBe(404);
    await h.bench.pipeline.idle();
    expect(h.bench.sessions.find(sent.body.sessionId)?.openedBy).toBe("web:u2");
  });

  test("a pick that is no pick refuses the message whole: nothing is sent, nothing kept", async () => {
    const h = await daemon();
    for (const bad of [{ effort: "turbo" }, { model: "two words" }, { model: 7 }, { effort: ["high"] }, { model: "x".repeat(201) }]) {
      const sent = await h.send("rina", { text: "halo", ...bad });
      expect({ bad, status: sent.status }).toEqual({ bad, status: 400 });
    }
    expect(h.carried).toEqual([]);
    expect(h.bench.sessions.list({}).length).toBe(0);
  });

  test("a message with no pick is the agent's own, and writes nothing before its turn", async () => {
    const h = await daemon();
    await h.send("rina", { text: "halo" });
    expect(h.carried).toEqual([{ model: "test-model", effort: "low" }]);
  });
});

describe("a pick made in a conversation that has begun", () => {
  async function begun() {
    const h = await daemon();
    const sent = await h.send("rina", { text: "halo" });
    const sessionId = sent.body.sessionId!;
    return { ...h, sessionId, session: `session=${encodeURIComponent(sessionId)}` };
  }

  test("is in force from the next message, and the answer to the pick is the conversation as it now stands", async () => {
    const h = await begun();
    const picked = await h.choose("rina", { sessionId: h.sessionId, model: "other-model" });
    expect(picked.status).toBe(200);
    expect(picked.body).toEqual({ model: { own: "test-model", chosen: "other-model" }, effort: { own: "low" }, efforts: ["low", "medium", "high", "xhigh", "max"] });
    await h.send("rina", { sessionId: h.sessionId, text: "lagi" });
    expect(h.carried.at(-1)).toEqual({ model: "other-model", effort: "low" });
    // One at a time: a level picked leaves the model where it was.
    expect((await h.choose("rina", { sessionId: h.sessionId, effort: "max" })).body.model.chosen).toBe("other-model");
    await h.send("rina", { sessionId: h.sessionId, text: "dan lagi" });
    expect(h.carried.at(-1)).toEqual({ model: "other-model", effort: "max" });
  });

  test("the agent's own back, by null, by nothing, or by the command's word: each one alone", async () => {
    for (const back of [null, "", "default", "reset"]) {
      const h = await begun();
      await h.choose("rina", { sessionId: h.sessionId, model: "other-model", effort: "high" });
      expect((await h.choose("rina", { sessionId: h.sessionId, model: back })).body).toMatchObject({ model: { own: "test-model" }, effort: { own: "low", chosen: "high" } });
      expect((await h.choose("rina", { sessionId: h.sessionId, effort: back })).body.effort).toEqual({ own: "low" });
      await h.send("rina", { sessionId: h.sessionId, text: "lagi" });
      expect({ back, carried: h.carried.at(-1) }).toEqual({ back, carried: { model: "test-model", effort: "low" } });
    }
  });

  test("the commands and the page are one choice: each reads what the other set", async () => {
    const h = await begun();
    await h.choose("rina", { sessionId: h.sessionId, model: "other-model", effort: "high" });
    /** What the daemon answered a command with: its own turn's reply, by the words asked. */
    const said = async (text: string) => {
      await h.send("rina", { sessionId: h.sessionId, text });
      return h.bench.db.prepare<{ reply: string }>("SELECT reply FROM turn_records WHERE session_id = ? AND prompt = ? ORDER BY rowid DESC LIMIT 1").get(h.sessionId, text)?.reply;
    };
    expect(await said("/model")).toBe("Current model: `other-model`");
    expect(await said("/effort")).toBe("Effort for this chat: `high`, set in this chat.");
    expect(await said("/model third-model")).toBe("Model for this chat is now `third-model`.");
    expect(await said("/effort default")).toBe("Back to the agent's effort, `low`.");
    const { body } = await h.choices("rina", h.session);
    expect(body.model).toEqual({ own: "test-model", chosen: "third-model" });
    expect(body.effort).toEqual({ own: "low" });
  });

  test("it ends with the conversation: /reset leaves the agent's own, and the page says so", async () => {
    const h = await begun();
    await h.choose("rina", { sessionId: h.sessionId, model: "other-model", effort: "high" });
    await h.send("rina", { sessionId: h.sessionId, text: "/reset" });
    const { body } = await h.choices("rina", h.session);
    expect(body.model).toEqual({ own: "test-model" });
    expect(body.effort).toEqual({ own: "low" });
    await h.send("rina", { sessionId: h.sessionId, text: "baru" });
    expect(h.carried.at(-1)).toEqual({ model: "test-model", effort: "low" });
  });

  test("a level that is none, and a model's name that is not one word, are refused and change nothing", async () => {
    const h = await begun();
    await h.choose("rina", { sessionId: h.sessionId, model: "other-model", effort: "high" });
    const level = await h.choose("rina", { sessionId: h.sessionId, effort: "turbo" });
    expect(level.status).toBe(400);
    expect(level.body.error).toBe("`turbo` is not a level: low, medium, high, xhigh, max, or default");
    const name = await h.choose("rina", { sessionId: h.sessionId, model: "gpt 5" });
    expect(name).toMatchObject({ status: 400, body: { plain: "A model's name is one word, with no spaces." } });
    // Both refused before either was kept: a request with one good half and one bad keeps neither.
    expect((await h.choose("rina", { sessionId: h.sessionId, model: "fourth-model", effort: "turbo" })).status).toBe(400);
    const { body } = await h.choices("rina", h.session);
    expect(body.model.chosen).toBe("other-model");
    expect(body.effort.chosen).toBe("high");
  });

  test("it is written down: who picked what, for which conversation", async () => {
    const h = await begun();
    await h.choose("rina", { sessionId: h.sessionId, model: "other-model" });
    await h.choose("rina", { sessionId: h.sessionId, effort: null });
    expect(h.audits.filter((row) => row.action === "chat_choice")).toEqual([
      { action: "chat_choice", actor: "rina", agentId: "nouva", chatId: expect.stringMatching(/^web-/), details: { model: "other-model" } },
      { action: "chat_choice", actor: "rina", agentId: "nouva", chatId: expect.stringMatching(/^web-/), details: { effort: null } },
    ]);
  });
});

describe("whose conversation, and which", () => {
  test("another person's is not there to pick for or to read: nothing is kept, and an admin opens it", async () => {
    const h = await daemon();
    const sent = await h.send("rina", { text: "halo" });
    const sessionId = sent.body.sessionId!;
    const session = `session=${encodeURIComponent(sessionId)}`;
    expect((await h.choose("sari", { sessionId, model: "other-model" })).status).toBe(404);
    expect((await h.choices("sari", session)).status).toBe(404);
    expect(h.bench.pipeline.chatChoice(sessionId)).toEqual({});
    expect((await h.choose("gading", { sessionId, model: "other-model" })).status).toBe(200);
    expect(h.bench.pipeline.chatChoice(sessionId)).toEqual({ model: "other-model" });
  });

  test("an account that only reads may see what a conversation is on, and pick nothing", async () => {
    const h = await daemon();
    expect((await h.choose("tamu", { sessionId: "ses_any", model: "other-model" })).status).toBe(403);
    expect((await h.choices("tamu", "agent=nouva")).status).toBe(200);
  });

  test("a room and a chat app's conversation keep the commands: a pick from the page is refused, and nothing kept", async () => {
    const h = await daemon();
    // A room of the dashboard's own, with a turn of the agent's in it.
    const room = h.rooms.create({ gatewayId: h.local.id, chatId: "room-1", title: "Riset", agentIds: ["nouva"], createdBy: "rina" });
    const inRoom = { agentId: "nouva", gatewayId: h.local.id, chatId: room.chatId };
    h.bench.turns.begin({ sessionId: sessionIdFor(inRoom), ...inRoom, senderId: "u2", prompt: "@nouva halo" });
    // The agent's own bot on Telegram, written to by the admin.
    h.bot.receive(envelope({ gatewayId: h.bot.id, chatId: "814", senderId: "814", text: "halo", timestamp: Date.now() }));
    await h.bench.pipeline.idle();
    const onTelegram = sessionIdFor({ agentId: "nouva", gatewayId: h.bot.id, chatId: "814" });
    for (const sessionId of [sessionIdFor(inRoom), onTelegram]) {
      const picked = await h.choose("gading", { sessionId, model: "other-model" });
      expect({ sessionId, status: picked.status, plain: picked.body.plain }).toEqual({ sessionId, status: 409, plain: "This is set in the chat itself, with /model and /effort." });
      expect(h.bench.pipeline.chatChoice(sessionId)).toEqual({});
    }
    // What it is on is still there to read: `/model` typed on Telegram shows on the dashboard's copy.
    h.bot.receive(envelope({ id: "m2", gatewayId: h.bot.id, chatId: "814", senderId: "814", text: "/model other-model", timestamp: Date.now() }));
    await h.bench.pipeline.idle();
    expect((await h.choices("gading", `session=${encodeURIComponent(onTelegram)}`)).body.model).toEqual({ own: "test-model", chosen: "other-model" });
  });
});

describe("whose a conversation is when a choice was its first word (`conversationNamed`)", () => {
  const KEY = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-9" };
  const ID = sessionIdFor(KEY);

  test("`/model` typed as a conversation's first message leaves it its sender's: the row it wrote names nobody yet", async () => {
    // The command is answered without an agent's turn, so nothing saves the row with who spoke: an operator who began
    // a conversation with `/model` could not open it again until an agent had answered in it.
    const h = await daemon();
    const sent = await h.send("rina", { text: "/model other-model" });
    const session = `session=${encodeURIComponent(sent.body.sessionId!)}`;
    expect(h.bench.sessions.find(sent.body.sessionId!)).toMatchObject({ startedAt: 0 });
    expect(h.bench.sessions.find(sent.body.sessionId!)?.openedBy).toBeUndefined();
    expect((await h.choices("rina", session)).body.model).toEqual({ own: "test-model", chosen: "other-model" });
    expect((await h.choices("sari", session)).status).toBe(404);
    // And the next message goes into it, on the model chosen.
    const next = await h.send("rina", { sessionId: sent.body.sessionId, text: "halo" });
    expect(next.body.sessionId).toBe(sent.body.sessionId!);
    expect(h.carried).toEqual([{ model: "other-model", effort: "low" }]);
  });

  test("a row that has not started and has no turn is nobody's, and one that has started says all there is", async () => {
    const h = await daemon();
    const { conversationNamed } = await import("@/modules/web/control/conversation.ts");
    const deps = { sessions: h.bench.sessions, turns: h.bench.turns };
    h.bench.sessions.keepModel(KEY, "other-model");
    // There, and nobody's: a choice with no message after it is still a conversation an admin can open and delete.
    expect(conversationNamed(deps, ID)).toMatchObject(KEY);
    expect(conversationNamed(deps, ID)?.openedBy).toBeUndefined();
    // Its first turn, by the operator: theirs from now.
    h.bench.turns.begin({ sessionId: ID, ...KEY, senderId: "u2", prompt: "halo" });
    expect(conversationNamed(deps, ID)).toMatchObject({ ...KEY, openedBy: "web:u2" });
    // A conversation from before anybody was recorded as its opener has started, and stays nobody's whoever spoke last.
    h.bench.db.prepare("UPDATE sessions SET started_at = 5 WHERE id = ?").run(ID);
    expect(conversationNamed(deps, ID)?.openedBy).toBeUndefined();
    expect(conversationNamed(deps, "ses_nothing")).toBeNull();
  });
});

describe("an agent a coding CLI answers", () => {
  const CLI = { models: [{ value: "default", name: "Opus 5.5" }, { value: "sonnet" }], efforts: ["low", "high"], runsOn: "Opus 5.5" };

  test("is on its CLI's model, never its pack's, with the CLI's own models and levels to choose from", async () => {
    const h = await daemon({ cli: CLI });
    const { body } = await h.choices("rina", "agent=nouva");
    expect(body).toEqual({
      model: { own: "Opus 5.5" },
      effort: { own: "low" },
      efforts: ["low", "high"],
      cli: { id: "claude", name: "Claude Code", models: [{ value: "default", name: "Opus 5.5" }, { value: "sonnet" }] },
    });
    // The model its pack names for the CLI, where it names one.
    expect((await (await daemon({ cli: { ...CLI, packModel: "sonnet" } })).choices("rina", "agent=nouva")).body.model).toEqual({ own: "sonnet" });
  });

  test("before its first session it has listed nothing: no models, every level, and no model of its own to name", async () => {
    const h = await daemon({ cli: { models: [], efforts: [] } });
    const { body } = await h.choices("rina", "agent=nouva");
    expect(body.model).toEqual({ own: "" });
    expect(body.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(body.cli).toEqual({ id: "claude", name: "Claude Code", models: [] });
  });

  test("a level its CLI does not offer for the model it is on is refused in the page's words, and one it offers is kept", async () => {
    const h = await daemon({ cli: CLI });
    const sessionId = sessionIdFor({ agentId: "nouva", gatewayId: h.local.id, chatId: "web-1" });
    h.bench.turns.begin({ sessionId, agentId: "nouva", gatewayId: h.local.id, chatId: "web-1", senderId: "u2", prompt: "halo" });
    const refused = await h.choose("rina", { sessionId, effort: "max" });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: "its CLI does not offer `max` for the model it is on (it offers: low, high)", plain: "That level is not offered for the model it is on. Pick another." } as never);
    expect((await h.choose("rina", { sessionId, effort: "high", model: "sonnet" })).body).toMatchObject({ model: { chosen: "sonnet" }, effort: { chosen: "high" } });
  });

  test("a level its CLI calls by a name of its own is not offered: picked, it would be refused as no level at all", async () => {
    // Seen on a real Codex session: it offered `ultra` for one of its models.
    const h = await daemon({ cli: { ...CLI, efforts: ["low", "high", "ultra"] } });
    const { body } = await h.call<ChatChoices>("rina", "GET", "/chat/choices?agent=nouva");
    expect(body.efforts).toEqual(["low", "high"]);
    const sessionId = sessionIdFor({ agentId: "nouva", gatewayId: h.local.id, chatId: "web-1" });
    h.bench.turns.begin({ sessionId, agentId: "nouva", gatewayId: h.local.id, chatId: "web-1", senderId: "u2", prompt: "halo" });
    expect((await h.choose("rina", { sessionId, effort: "ultra" })).status).toBe(400);
  });
});

describe("the models a picker suggests", () => {
  test("are the provider's own list, for whoever may write in a chat: names, and nothing of the profile", async () => {
    const h = await daemon();
    for (const who of ["gading", "rina"] as const) {
      const { status, body } = await h.call<{ models: string[] }>(who, "GET", "/chat/models?agent=nouva");
      expect({ who, status, body }).toEqual({ who, status: 200, body: { models: ["test-model", "other-model", "text-embedding-3"] } });
    }
    expect(h.probes.length).toBe(2);
  });

  test("not for an account that only reads, and the provider is not asked", async () => {
    const h = await daemon();
    expect((await h.call("tamu", "GET", "/chat/models?agent=nouva")).status).toBe(403);
    expect(h.probes).toEqual([]);
  });

  test("a list that cannot be had is no list, said without the reason: the field still takes a name typed", async () => {
    const h = await daemon({ listed: "fails" });
    expect(await h.call("rina", "GET", "/chat/models?agent=nouva")).toEqual({ status: 200, body: { models: [] } });
    expect((await h.call("rina", "GET", "/chat/models?agent=ghost")).status).toBe(404);
  });

  test("a coding CLI's agent has its models from the CLI: its pack's provider is never asked", async () => {
    const h = await daemon({ cli: { models: [{ value: "sonnet" }], efforts: [] } });
    expect(await h.call("rina", "GET", "/chat/models?agent=nouva")).toEqual({ status: 200, body: { models: [] } });
    expect(h.probes).toEqual([]);
  });
});

describe("a level a model refused", () => {
  test("is said with the model that refused it, for as long as that level is the conversation's", async () => {
    const h = await daemon();
    const sent = await h.send("rina", { text: "halo", effort: "max" });
    const sessionId = sent.body.sessionId!;
    const session = `session=${encodeURIComponent(sessionId)}`;
    expect((await h.choices("rina", session)).body.effort).toEqual({ own: "low", chosen: "max" });
    // As a turn that met the refusal records it.
    (h.bench.pipeline as unknown as { modelOverrides: { refused(id: string, refusal: { effort: string; model: string }): boolean } }).modelOverrides.refused(sessionId, { effort: "max", model: "test-model" });
    expect((await h.choices("rina", session)).body.effort).toEqual({ own: "low", chosen: "max", refusedBy: "test-model" });
    await h.choose("rina", { sessionId, effort: "high" });
    expect((await h.choices("rina", session)).body.effort).toEqual({ own: "low", chosen: "high" });
  });

  test("a refusal that outlived its level is not said of another, nor of none", async () => {
    const h = await daemon();
    const sent = await h.send("rina", { text: "halo", effort: "max" });
    const sessionId = sent.body.sessionId!;
    const session = `session=${encodeURIComponent(sessionId)}`;
    const key = { agentId: "nouva", gatewayId: h.local.id, chatId: sent.body.chatId! };
    (h.bench.pipeline as unknown as { modelOverrides: { refused(id: string, refusal: { effort: string; model: string }): boolean } }).modelOverrides.refused(sessionId, { effort: "max", model: "test-model" });
    // The level changed on the row itself, as an ending or another process changes it: what was refused was `max`.
    h.bench.sessions.keepEffort(key, "high");
    expect((await h.choices("rina", session)).body.effort).toEqual({ own: "low", chosen: "high" });
    h.bench.sessions.dropEffort(sessionId);
    expect((await h.choices("rina", session)).body.effort).toEqual({ own: "low" });
  });
});
