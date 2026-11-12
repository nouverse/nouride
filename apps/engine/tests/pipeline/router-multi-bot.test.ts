/**
 * Several of our own bots in one channel — one token per agent.
 *
 * The arrangement the router was never exercised against, and it fails in the least visible way:
 * everything works, and every agent answers. Discord hands each bot a copy of every channel message,
 * so each connection routes the same message independently, and "everything on my connection is
 * mine" is then true for all of them at once.
 *
 * What actually happened on a live box with six agents in `#infra-ops`: one `@Nero | Infra Agent
 * hidup?` produced replies from five agents plus a tool approval from the sixth. None of them had
 * been addressed — the tag resolved to nobody, because a Discord bot's username is the *application*
 * name and comparing it to an agent id never matched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { removePath, writeTextFile } from "@nouride/runtime";
import type { MessageEnvelope } from "@nouride/shared";
import { AgentRegistry } from "@nouride/persona";
import { routeMessage, stripAddressPrefix } from "@/modules/router/index.ts";
import { telegramMentions } from "../../../../packages/gateways/src/channels/telegram/envelope.ts";
import { envelope, tempDir, writeAgentPack } from "../helpers.ts";

const DEFAULTS = { provider: "test", model: "test-model", maxTokens: 1000, temperature: 0.5 };
const AGENTS = ["nouva", "nix", "nero", "nox", "nexa", "nestor"];

let agentsDir: string;
let registry: AgentRegistry;

beforeEach(async () => {
  agentsDir = tempDir("agents-multibot");
  for (const id of AGENTS) {
    await writeAgentPack(agentsDir, { id, configToml: '[llm]\nprovider = "test"\n' });
    await writeTextFile(
      `${agentsDir}/${id}/config.toml`,
      `[agent]\ndisplay_name = "${id[0]!.toUpperCase()}${id.slice(1)}"\n\n[llm]\nprovider = "test"\n`,
    );
  }
  registry = await AgentRegistry.create({
    agentsDir,
    llmDefaults: DEFAULTS,
    knownProviders: ["test"],
  });
});

afterEach(() => {
  removePath(agentsDir);
});

/** A channel message as Discord delivers it: the tag is an id, and the username is decorated. */
function tagged(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return envelope({
    gateway: "discord",
    chatType: "channel",
    chatId: "6666666666666666666",
    text: "<@1111111111111111111> hidup?",
    mentions: ["Nero | Infra Agent", "1111111111111111111"],
    ...overrides,
  });
}

/** How the pipeline calls the router for one connection in a six-bot channel. */
function routeOn(gatewayName: string, env: MessageEnvelope, mentionsSelf: boolean) {
  return routeMessage(
    { ...env, gatewayId: `discord:${gatewayName}`, ...(mentionsSelf ? { mentionsSelf: true } : {}) },
    registry,
    {
      gatewayOwner: gatewayName,
      // False in a channel with siblings — a DM or a single-bot platform passes true.
      answerUnaddressed: false,
      orchestrator: "nouva",
    },
  );
}

describe("a tag meant for one of six", () => {
  test("only the tagged agent's connection answers", () => {
    const answered = AGENTS.filter(
      (name) => routeOn(name, tagged(), name === "nero").agent !== null,
    );
    expect(answered).toEqual(["nero"]);
  });

  test("and it answers as itself, through its own connection", () => {
    const decision = routeOn("nero", tagged(), true);
    expect(decision.agent?.config.id).toBe("nero");
    expect(decision.reason).toBe("mention");
  });

  test("the other connections say why they stayed quiet", () => {
    // Not `no_match`: somebody *was* addressed. The distinction is what makes a quiet bot readable in
    // a log rather than looking like a router that gave up.
    expect(routeOn("nouva", tagged(), false).reason).toBe("addressed_elsewhere");
    expect(routeOn("nox", tagged(), false).reason).toBe("addressed_elsewhere");
  });

  test("a decorated platform username is not what resolves it", () => {
    // `matchesName` compares against the agent id and display name, and "Nero | Infra Agent" is
    // neither. Relying on it is what produced six replies; the platform's own answer is `mentionsSelf`.
    const decision = routeOn("nero", tagged(), false);
    expect(decision.agent).toBeNull();
  });

  test("addressing by name in the text still works, from any connection", () => {
    // No platform mention at all — a human typing "nero: ..." in the channel.
    const byName = envelope({
      gateway: "discord",
      chatType: "channel",
      text: "nero: masih hidup?",
      mentions: [],
    });
    expect(routeOn("nouva", byName, false).agent?.config.id).toBe("nero");
    expect(routeOn("nero", byName, false).agent?.config.id).toBe("nero");
  });

  test("a human tagged, no bot tagged — nobody answers", () => {
    const humanTag = tagged({
      text: "<@214700000000000001> tolong cek ini",
      mentions: ["gadingnstn", "214700000000000001"],
    });
    const answered = AGENTS.filter((name) => routeOn(name, humanTag, false).agent !== null);
    expect(answered).toEqual([]);
  });

  test("an untagged channel message is answered by nobody", () => {
    // In a room shared by several of our bots, an agent speaks when it is addressed and not otherwise.
    // Two earlier versions of this got it wrong in different ways: the first let the connection owner
    // answer, which is true for all six at once; the second fell through to the default agent, which
    // is *also* true for all six at once and shipped six identical replies to a thread containing the
    // word "tes".
    const chatter = envelope({
      gateway: "discord",
      chatType: "channel",
      text: "btw build-nya udah hijau",
      mentions: [],
    });

    const answered = AGENTS.map((name) => routeOn(name, chatter, false).agent?.config.id).filter(
      Boolean,
    );
    expect(answered).toEqual([]);
    expect(routeOn("nouva", chatter, false).reason).toBe("no_match");
  });

  test("a reply to what an agent said reaches that agent, without a tag", () => {
    // Still addressing: hitting reply on Nero's message names Nero as plainly as typing his name, and
    // it names exactly one agent, so it cannot fan out.
    const followUp = envelope({
      gateway: "discord",
      gatewayId: "discord:nouva",
      chatType: "channel",
      text: "dan yang satunya juga",
      mentions: [],
    });
    const decision = routeMessage(followUp, registry, {
      gatewayOwner: "nouva",
      answerUnaddressed: false,
      orchestrator: "nouva",
      repliedToAgent: "nero",
    });
    expect(decision.agent?.config.id).toBe("nero");
    expect(decision.reason).toBe("reply");
  });
});

describe("a front desk (`[daemon] orchestrator_mode`)", () => {
  /** As the pipeline calls it with the mode on: the desk is passed only where nothing else may answer. */
  const deskOn = (gatewayName: string, env: MessageEnvelope, mentionsSelf: boolean) =>
    routeMessage(
      { ...env, gatewayId: `discord:${gatewayName}`, ...(mentionsSelf ? { mentionsSelf: true } : {}) },
      registry,
      { gatewayOwner: gatewayName, answerUnaddressed: false, orchestrator: "nox", frontDesk: "nox" },
    );

  test("every connection hands untagged chatter to the same agent — the one the claim then lets through once", () => {
    const chatter = envelope({ gateway: "discord", chatType: "channel", text: "ada yang bisa bantu?", mentions: [] });
    const decisions = AGENTS.map((name) => deskOn(name, chatter, false));
    expect(decisions.map((d) => d.agent?.config.id)).toEqual(AGENTS.map(() => "nox"));
    expect(new Set(decisions.map((d) => d.reason))).toEqual(new Set(["front_desk"]));
  });

  test("a tag still reaches only the tagged agent, and the rest stay quiet", () => {
    const answered = AGENTS.filter((name) => deskOn(name, tagged(), name === "nero").agent !== null);
    expect(answered).toEqual(["nero"]);
    expect(deskOn("nox", tagged(), false).reason).toBe("addressed_elsewhere");
  });

  test("a name in the text and a reply still win over the desk", () => {
    const byName = envelope({ gateway: "discord", chatType: "channel", text: "nero: masih hidup?", mentions: [] });
    expect(deskOn("nox", byName, false).agent?.config.id).toBe("nero");
    const reply = routeMessage(envelope({ gateway: "discord", gatewayId: "discord:nox", chatType: "channel", text: "lanjut", mentions: [] }), registry, {
      gatewayOwner: "nox",
      answerUnaddressed: false,
      frontDesk: "nox",
      repliedToAgent: "nexa",
    });
    expect(reply.agent?.config.id).toBe("nexa");
  });

  test("a desk that is not an enabled agent answers nothing rather than somebody else", () => {
    const chatter = envelope({ gateway: "discord", chatType: "channel", text: "halo", mentions: [] });
    const decision = routeMessage({ ...chatter, gatewayId: "discord:nouva" }, registry, { gatewayOwner: "nouva", answerUnaddressed: false, frontDesk: "ghost" });
    expect(decision).toEqual({ agent: null, reason: "no_match" });
  });
});

describe("a room that named its answerer (`/mention <agent>`)", () => {
  const chatter = (over: Partial<MessageEnvelope> = {}) => envelope({ gateway: "telegram", chatType: "group", chatId: "-100:7", text: "halo semua", mentions: [], ...over });
  /** As the pipeline calls it on one bot's copy, in a room that named Nix: with the desk beside it, as it would be. */
  const inRoom = (bot: string, env: MessageEnvelope, more: Parameters<typeof routeMessage>[2] = {}) =>
    routeMessage({ ...env, gatewayId: `telegram:${bot}` }, registry, { gatewayOwner: bot, answerUnaddressed: false, orchestrator: "nouva", frontDesk: "nouva", roomAnswerer: "nix", ...more });

  test("every bot's copy of a message that names nobody goes to the agent the room named, not to the desk or its own owner", () => {
    for (const bot of AGENTS) {
      const decision = inRoom(bot, chatter());
      expect(decision.agent?.config.id, bot).toBe("nix");
      expect(decision.reason, bot).toBe("room_answerer");
    }
  });

  test("above the connection's owner where one bot is alone, and above a channel binding", async () => {
    // One bot of ours on the platform: everything it gets is its agent's, until the room says otherwise.
    const alone = routeMessage({ ...chatter(), gatewayId: "telegram:nouva" }, registry, { gatewayOwner: "nouva", answerUnaddressed: true, orchestrator: "nouva", roomAnswerer: "nix" });
    expect(alone.agent?.config.id).toBe("nix");
    // An operator bound Nero to this chat in its pack: the room's own word is nearer than the file's.
    await writeTextFile(`${agentsDir}/nero/config.toml`, '[agent]\ndisplay_name = "Nero"\n\n[llm]\nprovider = "test"\n\n[channels]\n"telegram:nouva" = ["-100:7"]\n');
    const bound = await AgentRegistry.create({ agentsDir, llmDefaults: DEFAULTS, knownProviders: ["test"] });
    const options = { gatewayOwner: "nouva", answerUnaddressed: false, orchestrator: "nouva" };
    expect(routeMessage({ ...chatter(), gatewayId: "telegram:nouva" }, bound, options).reason).toBe("channel_binding");
    expect(routeMessage({ ...chatter(), gatewayId: "telegram:nouva" }, bound, { ...options, roomAnswerer: "nix" }).agent?.config.id).toBe("nix");
  });

  test("below a tag, a name in the words, a reply, and somebody else's tag", () => {
    // The platform resolved a tag to this bot: its agent, whoever the room named.
    expect(inRoom("nero", chatter({ mentionsSelf: true })).agent?.config.id).toBe("nero");
    expect(inRoom("nero", chatter({ mentionsSelf: true })).reason).toBe("mention");
    // A name in the words.
    expect(inRoom("nouva", chatter({ text: "nero: masih hidup?" })).agent?.config.id).toBe("nero");
    // A reply to what Nexa said.
    expect(inRoom("nouva", chatter(), { repliedToAgent: "nexa" })).toMatchObject({ reason: "reply" });
    expect(inRoom("nouva", chatter(), { repliedToAgent: "nexa" }).agent?.config.id).toBe("nexa");
    // Somebody else was tagged, on a platform that says so: nobody's here, the room's agent included.
    expect(inRoom("nouva", chatter({ mentions: ["SomeoneElsesBot"] }))).toEqual({ agent: null, reason: "addressed_elsewhere" });
  });

  test("an agent that is not there is nobody's name: the copy is routed as the room without one would be", () => {
    const decision = inRoom("nouva", chatter(), { roomAnswerer: "ghost" });
    expect(decision.agent?.config.id).toBe("nouva");
    expect(decision.reason).toBe("front_desk");
  });
});

describe("one bot per platform, or a DM", () => {
  test("the owner still answers anything on its own connection", () => {
    // The arrangement the fallback exists for: withholding it here would make a single-bot install
    // stop answering plain messages, which is most installs.
    const decision = routeMessage(
      envelope({ gateway: "telegram", gatewayId: "telegram:bot", chatType: "group", mentions: [] }),
      registry,
      { gatewayOwner: "nouva", answerUnaddressed: true },
    );
    expect(decision.agent?.config.id).toBe("nouva");
    expect(decision.reason).toBe("gateway_owner");
  });

  test("a DM to one bot among many is unambiguously that agent's", () => {
    const decision = routeMessage(
      envelope({ gateway: "discord", gatewayId: "discord:nero", chatType: "dm", mentions: [] }),
      registry,
      { gatewayOwner: "nero", answerUnaddressed: true, orchestrator: "nouva" },
    );
    expect(decision.agent?.config.id).toBe("nero");
  });

  test("@agent in a DM to another bot routes to the mentioned agent, not the owner", () => {
    // Bug 3: user types "@nox do something" in a Telegram DM with Nouva's bot.
    // Telegram does not produce a mention entity for @nox (it's not a real Telegram username),
    // so `mentions` is []. The text-based matcher in findMentioned should still pick it up.
    const decision = routeMessage(
      envelope({
        gateway: "telegram",
        gatewayId: "telegram:nouva",
        chatType: "dm",
        text: "@nox tolong lakukan security review di repo utama",
        mentions: [],
      }),
      registry,
      { gatewayOwner: "nouva", answerUnaddressed: true, orchestrator: "nouva" },
    );
    expect(decision.agent?.config.id).toBe("nox");
    expect(decision.reason).toBe("mention");
  });

  test("a reply to another agent's line in a DM stays with the bot's owner; in a room it reaches that agent (nouride-releases#10)", () => {
    // Nox's line was in Nouva's DM because Nouva asked it something; replying to it handed the person to Nox.
    const reply = (chatType: "dm" | "group") =>
      routeMessage(
        envelope({ gateway: "telegram", gatewayId: "telegram:nouva", chatType, text: "terus gimana?", mentions: [] }),
        registry,
        { gatewayOwner: "nouva", answerUnaddressed: true, repliedToAgent: "nox" },
      );
    expect(reply("dm").agent?.config.id).toBe("nouva");
    expect(reply("dm").reason).toBe("gateway_owner");
    expect(reply("group").agent?.config.id).toBe("nox");
    expect(reply("group").reason).toBe("reply");
  });

  test("a leading address beats an @name mentioned in passing", () => {
    // Found live. `nouride chat nouva` addresses by prefixing "nouva: ", and the message asked Nouva
    // to say something containing "@nox" — so the whole-text scan ran first, Nox took the message,
    // read it as somebody impersonating Nouva, and answered with a prompt-injection warning. Nox was
    // right about everything except being the recipient.
    //
    // Who I am talking *to* is the opening address; who I am talking *about* is the tag inside.
    const decision = routeMessage(
      envelope({
        gateway: "telegram",
        gatewayId: "telegram:nouva",
        chatType: "dm",
        text: "nouva: tolong minta @nox benerin build",
        mentions: [],
      }),
      registry,
      { gatewayOwner: "nouva", answerUnaddressed: true, orchestrator: "nouva" },
    );
    expect(decision.agent?.config.id).toBe("nouva");
    expect(decision.reason).toBe("mention");
  });

  test("a resolved mention still outranks both", () => {
    // The gateway said who this is for. Nothing in the text overrides that — which is what makes the
    // CLI's `--agent` mean something a sender cannot type their way around.
    const decision = routeMessage(
      envelope({
        gateway: "web",
        gatewayId: "web:dashboard",
        chatType: "dm",
        text: "nero: tolong minta @nox benerin build",
        mentions: ["nouva"],
      }),
      registry,
      { answerUnaddressed: true, orchestrator: "nouva" },
    );
    expect(decision.agent?.config.id).toBe("nouva");
  });
});

/**
 * The same room on Telegram, through the adapter as well as the router — the bug was in the seam.
 *
 * Telegram tags a bot by `@username`. The adapter passed that username on as a mention of somebody
 * and never said it was *this* bot, so the router matched it against agent names, found none, and
 * every connection — the tagged bot's own included — concluded the message was for someone else.
 * Seen in a forum topic with two bots: `@infrasecaxl_bot woi` got no answer from anyone, while typing
 * the agent id did.
 */
describe("a tag meant for one of two, on Telegram", () => {
  const BOTS = { nero: { id: 11, username: "nero_infra_bot" }, nouva: { id: 12, username: "nouva_asisten_bot" } };

  /** One connection's copy of a group message, built by the adapter exactly as it builds it live. */
  function onConnection(owner: keyof typeof BOTS, text: string, entities: { type: string; offset: number; length: number }[]) {
    const { mentions, mentionsSelf, text: body } = telegramMentions({ text, entities } as never, BOTS[owner]);
    return routeMessage(
      envelope({
        gateway: "telegram",
        gatewayId: `telegram:${owner}`,
        chatType: "group",
        chatId: "-1001234:7",
        text: body,
        mentions,
        ...(mentionsSelf ? { mentionsSelf: true } : {}),
      }),
      registry,
      { gatewayOwner: owner, answerUnaddressed: false, orchestrator: "nouva" },
    );
  }

  test("tagging a bot's username is answered by that bot's agent, and only it", () => {
    const text = "@nero_infra_bot cek log";
    const tag = [{ type: "mention", offset: 0, length: 15 }];
    const nero = onConnection("nero", text, tag);
    expect(nero.agent?.config.id).toBe("nero");
    expect(nero.reason).toBe("mention");
    expect(onConnection("nouva", text, tag)).toMatchObject({ agent: null, reason: "addressed_elsewhere" });
  });

  test("the case of the username does not matter", () => {
    expect(onConnection("nero", "@Nero_Infra_Bot hi", [{ type: "mention", offset: 0, length: 15 }]).agent?.config.id).toBe("nero");
  });

  test("tagging both: each bot answers as itself", () => {
    const text = "@nero_infra_bot @nouva_asisten_bot sync";
    const tags = [
      { type: "mention", offset: 0, length: 15 },
      { type: "mention", offset: 16, length: 18 },
    ];
    expect(onConnection("nero", text, tags).agent?.config.id).toBe("nero");
    expect(onConnection("nouva", text, tags).agent?.config.id).toBe("nouva");
  });

  test("the agent id in the text still works, where the bot receives it", () => {
    // Every connection that sees it names nero; which connection speaks is the claim's business,
    // after routing — the same as on Discord.
    expect(onConnection("nero", "@nero cek", []).agent?.config.id).toBe("nero");
    expect(onConnection("nouva", "@nero cek", []).agent?.config.id).toBe("nero");
  });
});

describe("an agent's own tag, taken off what it is handed", () => {
  test("a bot's handle that starts with the agent's name is left whole", () => {
    // Live, 2026-11-01: Nouva's "@NexaNourideBot Sam udah approve…" reached Nexa as "NourideBot Sam udah approve…" —
    // "@Nexa" matched the front of the handle and was cut off it.
    const nexa = registry.get("nexa")!;
    expect(stripAddressPrefix("@NexaNourideBot Gading udah approve tuh", nexa)).toBe("@NexaNourideBot Gading udah approve tuh");
    expect(stripAddressPrefix("nexa_bot: cek", nexa)).toBe("nexa_bot: cek");
  });

  test("the agent's own name is still taken off, with or without @ and a colon", () => {
    const nexa = registry.get("nexa")!;
    expect(stripAddressPrefix("@nexa gas bikin", nexa)).toBe("gas bikin");
    expect(stripAddressPrefix("Nexa: /new", nexa)).toBe("/new");
    expect(stripAddressPrefix("@Nexa, render ulang", nexa)).toBe("render ulang");
  });
});
