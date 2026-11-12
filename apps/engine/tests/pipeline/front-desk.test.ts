/**
 * The orchestrator (`[daemon] orchestrator`, 0.7.18) is the front desk of a room several of our bots share.
 *
 * The platform hands every bot in the room its own copy of a message, so a message that addresses nobody is answered
 * by nobody — any rule that names no agent would answer it once per bot (`router-multi-bot.test.ts`). With an
 * orchestrator named, it answers it, once, through its own bot; the others stay quiet. A message that addresses somebody
 * routes as it always did, and a DM is unaffected. Driven through the real pipeline, one copy per connection, because
 * "exactly one answers" is a property of every copy together and not of one routing decision.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { SqliteDb } from "@nouride/runtime";
import { TransientSecrets } from "@nouride/secrets";
import type { MessageEnvelope } from "@nouride/shared";
import { frontDeskFor, unaddressedFallback } from "@/modules/router/front-desk.ts";
import { envelope as envelopeAt, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup) dispose();
  cleanup = [];
});

const BOTS = ["nouva", "nox", "nero"] as const;

/** The conversations an agent has, by id: which connection each is kept under. */
const conversationsOf = (db: SqliteDb, agent: string): string[] =>
  db.prepare<{ id: string }>("SELECT id FROM sessions WHERE agent_id = ?").all(agent).map((row) => row.id);

/** Three agents, a Telegram bot each, all in one group. `nox` is the orchestrator, so its own bot is not the first one. */
async function room(options: { orchestrator: boolean; groupsRequireMention?: boolean; turns?: number }) {
  const connections = Object.fromEntries(BOTS.map((id) => [id, new FakeGateway(`telegram:${id}`, "telegram")]));
  const bench = await pipelineBench({
    turns: Array.from({ length: options.turns ?? 3 }, (_, i) => ({ text: `answer ${i + 1}` })),
    agents: BOTS.map((id) => ({
      id,
      identity: `# IDENTITY\n- **Name:** ${id}\n- **Headline:** The ${id} desk\n`,
      configToml: `[agent]\ndisplay_name = "${id[0]!.toUpperCase()}${id.slice(1)}"\n\n[llm]\nprovider = "test"\n`,
    })),
    config: {
      daemon: options.orchestrator ? { orchestrator: "nox" } : {},
      agents: { mentions_enabled: true, groups_require_mention: options.groupsRequireMention ?? false },
      gateways: { telegram: Object.fromEntries(BOTS.map((id) => [id, { enabled: true, token: `t-${id}`, agent: id }])) },
    },
    gateways: Object.values(connections),
    // What takes a credential out of a message and keeps it as it was written, for `/secret undo`.
    deps: { heldSecrets: new TransientSecrets() },
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();

  return {
    ...bench,
    /** One message as the platform delivers it: a copy to every bot, the same id on each. */
    async say(over: Partial<MessageEnvelope>) {
      const message = envelopeAt({ id: "m-1", timestamp: Date.now(), chatType: "group", chatId: "room-1", ...over });
      for (const id of BOTS) connections[id]!.receive({ ...message, gatewayId: `telegram:${id}` });
      await bench.pipeline.idle();
    },
    /** Which bot said what. */
    said: () => Object.fromEntries(BOTS.map((id) => [id, connections[id]!.sent.map((m) => m.text)])),
    connections,
  };
}

describe("with an orchestrator", () => {
  test("an unaddressed room message is answered once, by the orchestrator, through its own bot", async () => {
    const h = await room({ orchestrator: true });
    await h.say({ text: "ada yang bisa bantu?" });

    expect(h.requests).toHaveLength(1);
    expect(h.said()).toEqual({ nouva: [], nox: ["answer 1"], nero: [] });
    // And in the conversation its own bot keeps, the one a tag to it continues: Nouva's bot had the message first, and
    // the orchestrator's talk in the room was kept under whichever bot's copy won.
    expect(conversationsOf(h.db, "nox")).toEqual(["ses_nox:telegram:nox:room-1"]);
  });

  test("a message put back with `/secret undo` is read again in the orchestrator's own conversation, as an edit reaches every bot", async () => {
    // The first bot handed the message took the credential out and kept the message as written: Nouva's. Put back, it
    // came on Nouva's connection alone, so the orchestrator read it again in a conversation under Nouva's bot, and
    // what it then said of it came from there.
    const h = await room({ orchestrator: true });
    const token = `ghp_${"Zq9xW2vB7nM4kL8p".repeat(3).slice(0, 36)}`;
    await h.say({ id: "m-token", senderId: "operator", text: `deploy pakai ${token}` });
    // `/secret@nox_bot undo`, as Telegram's menu writes a command in a group: Nox's bot has it with its name taken off.
    const undo = envelopeAt({ id: "m-undo", timestamp: Date.now(), chatType: "group", chatId: "room-1", senderId: "operator" });
    for (const id of BOTS) {
      h.connections[id]!.receive({ ...undo, gatewayId: `telegram:${id}`, ...(id === "nox" ? { text: "/secret undo", mentionsSelf: true } : { text: "/secret@nox_bot undo", mentions: ["nox_bot"] }) });
    }
    await h.pipeline.idle();

    // Read again once, as written, and said through its own bot.
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests.at(-1))).toContain(token);
    expect(h.said().nox?.at(-1)).toBe("answer 2");
    expect(h.said().nouva).toEqual([]);
    expect(conversationsOf(h.db, "nox")).toEqual(["ses_nox:telegram:nox:room-1"]);
  });

  test("and where each bot numbers the message its own way, it is read again at all: on the orchestrator's own copy", async () => {
    // A Telegram basic group. Put back on the first bot's connection alone, the message was the orchestrator's to
    // read and left to its own bot's copy, which never came: "I'll read it again", and nobody did.
    const h = await room({ orchestrator: true });
    const token = `ghp_${"Zq9xW2vB7nM4kL8p".repeat(3).slice(0, 36)}`;
    const base = { chatType: "group" as const, chatId: "room-1", senderId: "operator", idsPerConnection: true };
    const sent = Date.now();
    BOTS.forEach((id, i) => h.connections[id]!.receive(envelopeAt({ ...base, timestamp: sent, id: String(100 + i), gatewayId: `telegram:${id}`, text: `deploy pakai ${token}` })));
    await h.pipeline.idle();
    const asked = Date.now();
    BOTS.forEach((id, i) =>
      h.connections[id]!.receive(
        envelopeAt({ ...base, timestamp: asked, id: String(200 + i), gatewayId: `telegram:${id}`, ...(id === "nox" ? { text: "/secret undo", mentionsSelf: true } : { text: "/secret@nox_bot undo", mentions: ["nox_bot"] }) }),
      ),
    );
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests.at(-1))).toContain(token);
    expect(h.said().nox?.at(-1)).toBe("answer 2");
    expect(conversationsOf(h.db, "nox")).toEqual(["ses_nox:telegram:nox:room-1"]);
  });

  test("`/secret undo` typed with no tag, where a tag is required: answered once, and the message is read again by whom it was for", async () => {
    // A room that keeps its silence without a tag. The command went to every bot and was for none of them, so nobody
    // answered it, and a message the daemon had taken something out of could not be put back from the room.
    const h = await room({ orchestrator: true, groupsRequireMention: true });
    const token = `ghp_${"Zq9xW2vB7nM4kL8p".repeat(3).slice(0, 36)}`;
    await h.say({ id: "m-token", senderId: "operator", text: `nero: deploy pakai ${token}` });
    expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(h.requests[0])).not.toContain(token);

    await h.say({ id: "m-undo", senderId: "operator", text: "/secret undo" });
    const said = h.said();
    // One answer, in the orchestrator's voice, whichever bot's copy came first; the other bots say nothing of it.
    expect(Object.values(said).flat().filter((text) => text === "Put back as you wrote it. I'll read it again.")).toHaveLength(1);
    // After the notice that something was taken out, which it said too.
    expect(said.nox).toHaveLength(2);
    expect(said.nox?.[0]).toStartWith("🔒 Taken out of your message");
    expect(said.nox?.[1]).toBe("Put back as you wrote it. I'll read it again.");
    expect(said.nouva).toEqual([]);
    // And read again once, as written, by the agent it named.
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests.at(-1))).toContain(token);
    expect(said.nero).toEqual(["answer 1", "answer 2"]);
  });

  test("and what the room holds is said once too, with no tag", async () => {
    const h = await room({ orchestrator: true, groupsRequireMention: true });
    await h.say({ id: "m-status", senderId: "operator", text: "/secret" });
    const all = Object.values(h.said()).flat();
    expect(all).toHaveLength(1);
    expect(all[0]).toStartWith("Nothing held in this chat.");
    expect(h.requests).toHaveLength(0);
  });

  test("in a one-to-one chat `/secret` is that chat's own agent's to answer, not the orchestrator's", async () => {
    const h = await room({ orchestrator: true });
    h.connections.nero!.receive(envelopeAt({ id: "dm-secret", timestamp: Date.now(), chatType: "dm", chatId: "dm-1", gatewayId: "telegram:nero", text: "/secret" }));
    await h.pipeline.idle();
    const said = h.said();
    expect(said.nero?.[0]).toStartWith("Nothing held in this chat.");
    expect(said.nox).toEqual([]);
  });

  test("where each bot numbers the message differently, still once — on the orchestrator's own copy", async () => {
    // A Telegram basic group: the claim cannot collapse copies with different ids, so only the agent's own bot takes it.
    const h = await room({ orchestrator: true });
    const base = { chatType: "group" as const, chatId: "room-1", text: "ada yang bisa bantu?", idsPerConnection: true, timestamp: Date.now() };
    BOTS.forEach((id, i) => h.connections[id]!.receive(envelopeAt({ ...base, id: String(100 + i), gatewayId: `telegram:${id}` })));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    expect(h.said()).toEqual({ nouva: [], nox: ["answer 1"], nero: [] });
  });

  test("a message that addresses someone routes as it always did", async () => {
    const h = await room({ orchestrator: true });
    await h.say({ text: "nero: cek disk dong" });

    expect(h.requests).toHaveLength(1);
    expect(h.said()).toEqual({ nouva: [], nox: [], nero: ["answer 1"] });
    // Named in the words, so every bot's copy is for Nero: its own bot's is the one that takes it, though it came last.
    expect(conversationsOf(h.db, "nero")).toEqual(["ses_nero:telegram:nero:room-1"]);
  });

  test("a DM is unaffected: the bot's own agent answers, not the front desk", async () => {
    const h = await room({ orchestrator: true });
    h.connections.nouva!.receive(envelopeAt({ id: "dm-1", timestamp: Date.now(), chatType: "dm", chatId: "dm-1", gatewayId: "telegram:nouva", text: "halo" }));
    await h.pipeline.idle();

    expect(h.said()).toEqual({ nouva: ["answer 1"], nox: [], nero: [] });
  });

  test("a room that requires a mention keeps its silence: an untagged group message is answered by nobody", async () => {
    const h = await room({ orchestrator: true, groupsRequireMention: true });
    await h.say({ text: "ada yang bisa bantu?" });

    expect(h.requests).toHaveLength(0);
  });

  test("the front desk is told who the others are, by name and what they are for", async () => {
    const h = await room({ orchestrator: true });
    await h.say({ text: "ada yang bisa bantu?" });

    const system = JSON.stringify(h.requests[0]);
    expect(system).toContain("  - nouva: Nouva. The nouva desk");
    expect(system).toContain("  - nero: Nero. The nero desk");
    // And that the untagged message is its, to answer or hand on.
    expect(system).toContain("- You are the orchestrator: where this room does not require a mention");
  });

  test("an agent that is not the orchestrator is not told it is", async () => {
    const h = await room({ orchestrator: true });
    await h.say({ text: "nero: cek disk dong" });
    expect(JSON.stringify(h.requests[0])).not.toContain("You are the orchestrator");
  });
});

describe("with no orchestrator named — as before", () => {
  test("`/secret undo` with no tag is still answered, once, by the bot whose copy came first", async () => {
    const h = await room({ orchestrator: false });
    const token = `ghp_${"Zq9xW2vB7nM4kL8p".repeat(3).slice(0, 36)}`;
    await h.say({ id: "m-token", senderId: "operator", text: `nero: deploy pakai ${token}` });
    await h.say({ id: "m-undo", senderId: "operator", text: "/secret undo" });
    const said = h.said();
    expect(Object.values(said).flat().filter((text) => text === "Put back as you wrote it. I'll read it again.")).toHaveLength(1);
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests.at(-1))).toContain(token);
  });

  test("an unaddressed room message is answered by nobody", async () => {
    const h = await room({ orchestrator: false });
    await h.say({ text: "ada yang bisa bantu?" });

    expect(h.requests).toHaveLength(0);
    expect(h.said()).toEqual({ nouva: [], nox: [], nero: [] });
  });

  test("an addressed one is answered by whoever it named", async () => {
    const h = await room({ orchestrator: false });
    await h.say({ text: "nero: cek disk dong" });

    expect(h.said()).toEqual({ nouva: [], nox: [], nero: ["answer 1"] });
  });
});

describe("who sits at the desk", () => {
  const base = {
    orchestrator: "nox",
    chatType: "group" as const,
    answerUnaddressed: false,
    groupsRequireMention: false,
    members: null,
  };

  test("the orchestrator, in a room nothing else may answer", () => {
    expect(frontDeskFor(base)).toBe("nox");
  });

  test("nobody when none is named, in a DM, where the ordinary fallbacks answer, or where a tag is required", () => {
    expect(frontDeskFor({ ...base, orchestrator: undefined })).toBeUndefined();
    expect(frontDeskFor({ ...base, chatType: "dm" })).toBeUndefined();
    expect(frontDeskFor({ ...base, answerUnaddressed: true })).toBeUndefined();
    expect(frontDeskFor({ ...base, groupsRequireMention: true })).toBeUndefined();
  });

  test("nobody in a room whose members do not include the orchestrator", () => {
    expect(frontDeskFor({ ...base, members: ["nouva", "nero"] })).toBeUndefined();
    expect(frontDeskFor({ ...base, members: ["nouva", "nox"] })).toBe("nox");
  });
});

describe("the last fallback, where an unaddressed message may be answered", () => {
  test("a chat with no member list — every platform chat — keeps the orchestrator, or nobody without one", () => {
    expect(unaddressedFallback("nox", null)).toBe("nox");
    expect(unaddressedFallback(undefined, null)).toBeUndefined();
  });

  test("in a room, the orchestrator only as a member; a room of one, its member; otherwise nobody", () => {
    expect(unaddressedFallback("nox", ["nox", "nero"])).toBe("nox");
    expect(unaddressedFallback("nox", ["nero"])).toBe("nero");
    expect(unaddressedFallback(undefined, ["nero"])).toBe("nero");
    expect(unaddressedFallback("nox", ["nouva", "nero"])).toBeUndefined();
    expect(unaddressedFallback("nox", [])).toBeUndefined();
  });
});
