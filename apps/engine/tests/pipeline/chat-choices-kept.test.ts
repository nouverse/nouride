/**
 * A chat's `/model` and `/effort` across a restart (0.8.18). They were held in memory, so every restart dropped them,
 * and the daemon restarts at every update; now they are on the conversation's row (076). A restart here is the next
 * process over the same install (`reboot`): its own pipeline, stores and connection, over the same database.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { ModelOverrides } from "@/modules/hooks/model-overrides.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const KEY = { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" };
const ID = sessionIdFor(KEY);
/** Ids unique across the processes of a test: the inbox takes one it has settled for a redelivery, and drops it. */
let sent = 0;

/** One process over the install: a new one, or the next over `previous`'s. The agent's own level is `low`. */
async function boot(previous: Bench | null) {
  /** The model and the level each request carried. */
  const carried: { model: string; effort?: string }[] = [];
  const fetch = (scripted: typeof globalThis.fetch) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; reasoning_effort?: string };
      carried.push({ model: body.model, ...(body.reasoning_effort ? { effort: body.reasoning_effort } : {}) });
      return await scripted(url, init);
    }) as typeof globalThis.fetch;
  const turns = [{ text: "one" }, { text: "two" }, { text: "three" }];
  const bench = previous ? await previous.reboot({ turns, fetch }) : await pipelineBench({ turns, fetch, agentToml: '[llm]\nprovider = "test"\neffort = "low"\n' });
  if (!previous) cleanup.push(bench.dispose);
  bench.pipeline.attach();
  const say = async (text: string, options: { chatId?: string; at?: number } = {}) => {
    sent += 1;
    bench.gateway.receive(envelope({ id: `m${sent}`, chatId: options.chatId ?? "chat-1", timestamp: options.at ?? Date.now(), text }));
    await bench.pipeline.idle();
    return bench.gateway.lastText();
  };
  return { bench, carried, say };
}

describe("a chat's /model and /effort, across a restart", () => {
  test("are still in force after it: the next message goes on the chat's model, at its level, and another chat on the agent's", async () => {
    const first = await boot(null);
    expect(await first.say("/model other-model")).toBe("Model for this chat is now `other-model`.");
    expect(await first.say("/effort high")).toBe("Effort for this chat is now `high`, from the next message.");

    const second = await boot(first.bench);
    expect(await second.say("hello")).toBe("one");
    expect(second.carried).toEqual([{ model: "other-model", effort: "high" }]);
    expect(await second.say("/status")).toContain("Model: other-model (overridden for this chat)");
    expect(await second.say("/effort")).toBe("Effort for this chat: `high`, set in this chat.");
    await second.say("hello", { chatId: "chat-2" });
    expect(second.carried.at(-1)).toEqual({ model: "test-model", effort: "low" });
  });

  test("dropped by their reset forms, they stay dropped: a restart does not bring them back", async () => {
    const first = await boot(null);
    await first.say("/model other-model");
    await first.say("/effort high");
    expect(await first.say("/model default")).toBe("Back to `test-model`.");
    expect(await first.say("/effort reset")).toBe("Back to the agent's effort, `low`.");

    const second = await boot(first.bench);
    await second.say("hello");
    expect(second.carried).toEqual([{ model: "test-model", effort: "low" }]);
  });

  test("/reset drops them and /new keeps them, each as the next process reads them", async () => {
    const first = await boot(null);
    await first.say("hello");
    await first.say("/model other-model");
    await first.say("/effort high");
    expect(await first.say("/new")).toStartWith("New conversation started.");

    const second = await boot(first.bench);
    await second.say("again");
    expect(second.carried).toEqual([{ model: "other-model", effort: "high" }]);
    expect(await second.say("/reset")).toStartWith("Reset.");

    const third = await boot(second.bench);
    await third.say("and again");
    expect(third.carried).toEqual([{ model: "test-model", effort: "low" }]);
  });

  test("a level that is no level any more is read as none: the turn is answered, at the agent's own", async () => {
    const first = await boot(null);
    await first.say("/effort high");
    // As a later release, or a hand in the database, might leave it.
    first.bench.db.prepare("UPDATE sessions SET effort_override = 'turbo' WHERE id = ?").run(ID);

    const second = await boot(first.bench);
    expect(await second.say("hello")).toBe("one");
    expect(second.carried).toEqual([{ model: "test-model", effort: "low" }]);
    expect(await second.say("/effort")).toBe("Effort for this chat: `low`, the agent's.");
  });

  test("chosen before the chat's first message, it is kept, and the conversation still starts at that message", async () => {
    const first = await boot(null);
    // No conversation yet: the choice writes its row, as one not started.
    await first.say("/model other-model");
    expect(first.bench.sessions.load(KEY).startedAt).toBe(0);

    const second = await boot(first.bench);
    const at = Date.now() - 1_000;
    await second.say("hello", { at });
    expect(second.carried).toEqual([{ model: "other-model", effort: "low" }]);
    // From its first message, not from the choice: a room's look-back and a daily rollover count from there.
    expect(second.bench.sessions.load(KEY).startedAt).toBe(at);
  });
});

describe("a database of 0.8.17", () => {
  test("takes the two columns: its conversations intact and with no choice of their own; one made after is kept", async () => {
    const db = openDatabase(":memory:");
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 75));
    // A conversation as 0.8.17 wrote it.
    db.prepare(
      `INSERT INTO sessions (id, agent_id, chat_id, gateway, context_token_count, session_type, status, created_at, started_at, updated_at)
       VALUES (?, 'nouva', 'chat-1', 'telegram:main', 3, 'main', 'active', 1000, 1000, 2000)`,
    ).run(ID);
    db.prepare("INSERT INTO session_messages (session_id, seq, hash, message) VALUES (?, 0, NULL, ?)").run(ID, JSON.stringify({ role: "user", content: "hi" }));

    await migrate(db);
    const overrides = new ModelOverrides(new SessionStore(db));
    expect([overrides.get(ID), overrides.effortOf(ID)]).toEqual([undefined, undefined]);
    overrides.set(KEY, "other-model");
    overrides.setEffort(KEY, "high");

    const next = new SessionStore(db);
    expect([new ModelOverrides(next).get(ID), new ModelOverrides(next).effortOf(ID)]).toEqual(["other-model", "high"]);
    expect(next.load(KEY)).toMatchObject({ startedAt: 1000, contextTokenCount: 3, messages: [{ role: "user", content: "hi" }] });
    db.close();
  });
});
