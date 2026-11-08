/**
 * Agents addressing each other, and the two things that stop them.
 *
 * The shape asked for reads like people talking:
 *
 *   Nouva: "@nox kerjain ini, disuruh Sam"
 *   Nox:   "udah kelar @nouva, PR di xxx"
 *   Nouva: "SIP okay Nox, nanti kita butuh review Sam dulu ya"
 *
 * The last line ends it, and nothing makes that happen — the router only routes on a mention, so a
 * reply without one reaches nobody. That is the soft brake, and it depends on a model choosing not to
 * tag. The hard brake is the hop budget, and these tests are mostly about it, because a chain that
 * does not stop is a bill that does not stop.
 */

import { describe, expect, test } from "bun:test";
import { isNarrationNotAddress } from "@/modules/pipeline/inbound.ts";
import type { MessageEnvelope } from "@nouride/shared";
import {
  agentMayAnswer,
  classifyInbound,
  exhaustedNotice,
  busConventionLines,
  mentionConventionLines,
} from "@/modules/router/agent-mentions.ts";
import { endConversation } from "@/modules/pipeline/conversation-end.ts";
import { OutboundRegistry } from "@nouride/persona";

const POLICY = { enabled: true, maxHops: 4 };

function envelope(over: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: "m1",
    timestamp: 0,
    gateway: "discord",
    gatewayId: "discord:main",
    chatId: "c1",
    chatType: "channel",
    senderId: "u1",
    senderName: "Gading",
    text: "hello",
    raw: {},
    ...over,
  } as MessageEnvelope;
}

describe("classifyInbound", () => {
  test("a human is a human", () => {
    expect(classifyInbound(envelope(), POLICY)).toEqual({ kind: "human" });
  });

  test("a bot we have no record of is ignored", () => {
    // This is what the old blanket filter did for every bot. The category was never the problem,
    // only its breadth.
    expect(classifyInbound(envelope({ senderIsBot: true }), POLICY)).toEqual({
      kind: "foreign_bot",
    });
  });

  test("one of our agents is recognised, and the hop counts", () => {
    expect(
      classifyInbound(envelope({ senderIsBot: true, fromAgent: "nouva" }), POLICY),
    ).toEqual({ kind: "agent", from: "nouva", hops: 1 });
  });

  test("the budget is a ceiling, not a suggestion", () => {
    const at = (hops: number) =>
      classifyInbound(envelope({ senderIsBot: true, fromAgent: "nouva", agentHops: hops }), POLICY);

    expect(at(3).kind).toBe("agent");
    // The fourth exchange is the last one allowed; the fifth is refused.
    expect(at(4).kind).toBe("exhausted");
    expect(at(40).kind).toBe("exhausted");
  });

  test("turning it off restores the behaviour that existed before", () => {
    // One line back to "every bot message is ignored", which is what shipped for the whole of
    // Phase 1 and 2.
    expect(
      classifyInbound(envelope({ senderIsBot: true, fromAgent: "nouva" }), {
        enabled: false,
        maxHops: 4,
      }),
    ).toEqual({ kind: "foreign_bot" });
  });

  test("a human is never subject to the budget", () => {
    // The operator joining a conversation is the reason the agents are talking. Counting their
    // messages against the limit would mute the daemon in its own chat.
    expect(classifyInbound(envelope({ agentHops: 99 }), POLICY)).toEqual({ kind: "human" });
  });
});

describe("agentMayAnswer", () => {
  test("an agent never answers itself", () => {
    // A model writing about itself mentions its own name constantly. Without this, each of those is
    // a loop of one — bounded by the budget, but only after spending it.
    expect(agentMayAnswer("nouva", "nouva")).toBe(false);
    expect(agentMayAnswer("nox", "nouva")).toBe(true);
    expect(agentMayAnswer("nouva", undefined)).toBe(true);
  });
});

describe("the notice when a chain runs out", () => {
  test("names the other agent and says what to do", () => {
    // Said out loud rather than stopping silently: a chain that ends without explanation looks like
    // an agent that crashed, and the operator goes looking for a failure that never happened.
    const notice = exhaustedNotice("nox", 4);
    expect(notice).toContain("nox");
    expect(notice).toContain("4");
    expect(notice.toLowerCase()).toContain("say something");
  });
});

describe("the token an agent is told to write", () => {
  test("the platform's own handle, when its connection knows one", () => {
    // An id, not a name. A Discord bot is tagged by id and the name the platform shows is the
    // application's — "Nero | Infra Agent" — which matched nothing, so a handover reached nobody.
    const lines = mentionConventionLines({
      others: ["nero", "nexa"],
      mentions: { nero: "<@1111111111111111111>", nexa: "<@2222222222222222222>" },
      maxHops: 4,
    }).join("\n");

    expect(lines).toContain("nero (write <@1111111111111111111>)");
    expect(lines).toContain("nexa (write <@2222222222222222222>)");
    expect(lines).toContain("that exact token");
  });

  test("falls back to the agent id where the platform has no handle for it", () => {
    // What the text matcher understands, and all that ever worked before — so an agent with no
    // connection of its own is still addressable.
    const lines = mentionConventionLines({ others: ["nox"], maxHops: 4 }).join("\n");
    expect(lines).toContain("nox (write @nox)");
  });

  test("a mix: one agent with a handle, one without", () => {
    const lines = mentionConventionLines({
      others: ["nero", "nox"],
      mentions: { nero: "<@123>" },
      maxHops: 4,
    }).join("\n");
    expect(lines).toContain("nero (write <@123>)");
    expect(lines).toContain("nox (write @nox)");
  });

  test("nothing at all when there is nobody else here", () => {
    expect(mentionConventionLines({ others: [], mentions: {}, maxHops: 4 })).toEqual([]);
  });
});

describe("the convention in the prompt", () => {
  test("says what a mention means rather than forbidding one", () => {
    // A model told "do not tag" will tag. A model told "tagging is how you hand work over" has a
    // reason not to when it is finishing.
    const lines = mentionConventionLines({ others: ["nox"], maxHops: 4 }).join("\n");

    // The exact token the router matches, not a description of one — a model shown a bare name
    // writes whatever reads best in a sentence, and none of those spellings route.
    expect(lines).toContain("@nox");
    expect(lines).toContain("hands the work over");
    expect(lines).toContain("WITHOUT a mention");
    expect(lines).toContain("4");
  });

  test("an agent alone in a chat is told nothing about mentions", () => {
    // Describing a mechanism for addressing agents that are not there is prompt budget spent on
    // teaching a model to talk to nobody.
    expect(mentionConventionLines({ others: [], maxHops: 4 })).toEqual([]);
  });
});

describe("the convention in a one-to-one chat", () => {
  test("says the tag reaches nobody, and names the tool that does", () => {
    const lines = busConventionLines({ others: ["nox", "nera"], hasTool: true }).join("\n");

    expect(lines).toContain("nox, nera");
    // The failure this exists to prevent is silent: the model writes the tag, the message goes out,
    // and nothing anywhere reports that it went nowhere.
    expect(lines).toContain("does nothing");
    expect(lines).toContain("ask_agent");
    // The half the operator asked for: one voice in the conversation.
    expect(lines).toContain("report the result");
  });

  test("never names the tool when the agent does not have it", () => {
    // The live bug. The section named `ask_agent`, the pack enumerated its tools and did not list it,
    // and the model reasoned its way around a promise the harness could not keep — ending on
    // `delegate`, which runs a helper as itself and answers as though the other agent had done it.
    const lines = busConventionLines({ others: ["nox"], hasTool: false }).join("\n");

    expect(lines).not.toContain("ask_agent");
    expect(lines).toContain("no way to reach them");
    // And the dead end is closed by name, because that is the door the model actually tried.
    expect(lines).toContain("delegate");
  });

  test("an agent alone on the daemon is told nothing at all", () => {
    expect(busConventionLines({ others: [], hasTool: true })).toEqual([]);
  });
});

describe("OutboundRegistry", () => {
  test("remembers who wrote a message", () => {
    const registry = new OutboundRegistry();
    registry.record({ platform: "g", chatId: "c", messageId: "m1", agentId: "nouva" });

    expect(registry.authorOf("g", "c", "m1")).toBe("nouva");
  });

  test("a message from another chat is not ours by accident", () => {
    const registry = new OutboundRegistry();
    registry.record({ platform: "g", chatId: "c", messageId: "m1", agentId: "nouva" });

    expect(registry.authorOf("g", "other", "m1")).toBeNull();
    expect(registry.authorOf("other", "c", "m1")).toBeNull();
  });

  test("an unknown message belongs to nobody", () => {
    const registry = new OutboundRegistry();
    expect(registry.authorOf("g", "c", "nope")).toBeNull();
    expect(registry.authorOf("g", "c", undefined)).toBeNull();
  });

  test("a platform that gives no id is not recorded", () => {
    // The CLI is the case: its replies are collected by a waiting request and cannot be replied to,
    // so there is nothing to remember.
    const registry = new OutboundRegistry();
    registry.record({ platform: "g", chatId: "c", messageId: undefined, agentId: "nouva" });
    expect(registry.stats().messages).toBe(0);
  });

  test("it is bounded per conversation", () => {
    // A routing hint for a conversation in progress, not a record. Unbounded growth in a long-lived
    // daemon is the failure this avoids.
    const registry = new OutboundRegistry();
    for (let i = 0; i < 200; i += 1) {
      registry.record({ platform: "g", chatId: "c", messageId: `m${i}`, agentId: "nouva" });
    }

    expect(registry.stats().messages).toBeLessThanOrEqual(60);
    // The newest survive, which are the ones a reply could plausibly point at.
    expect(registry.authorOf("g", "c", "m199")).toBe("nouva");
    expect(registry.authorOf("g", "c", "m0")).toBeNull();
  });

  test("ending a conversation resets the hop count and keeps who wrote what", async () => {
    /**
     * It used to forget the agent's messages too — first the whole room's, then one agent's. Either way a person's reply
     * to an answer from before a `/new`, `/reset` or the nightly rollover resolved to nobody, and in a room that needs a
     * mention that is silence (live, 2026-10-21, a WhatsApp group). Who wrote a message does not end with a conversation.
     */
    const registry = new OutboundRegistry();
    registry.record({ platform: "telegram", chatId: "c", messageId: "m1", agentId: "nouva" });
    registry.record({ platform: "telegram", chatId: "c", messageId: "m2", agentId: "nox" });
    registry.setHops("telegram", "c", 3);
    const quiet = { clear() {}, delete: () => true };
    await endConversation(
      {
        sessions: quiet,
        approvals: { expireAll: () => 0 },
        authorship: registry,
        modelOverrides: { clear() {}, clearEffort() {} },
        stopTurns: () => 0,
        platformOf: () => "telegram",
      },
      { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "c" },
      "reset",
    );

    expect(registry.authorOf("telegram", "c", "m1")).toBe("nouva");
    expect(registry.authorOf("telegram", "c", "m2")).toBe("nox");
    // `/new` resets the conversation, and a budget carried across that reset would silence agents in a chat the
    // operator just deliberately cleared.
    expect(registry.hops("telegram", "c")).toBe(0);
  });

  test("the hop count lives beside the messages, and is evicted with them", () => {
    // Two maps over the same conversation were two lifetimes to keep in step: eviction dropped the
    // ids and left the count, so a chat that came back mid-exchange arrived with its budget already
    // spent and its agents mute for no visible reason.
    const registry = new OutboundRegistry();
    registry.setHops("g", "old", 4);
    for (let i = 0; i < 250; i += 1) {
      registry.record({ platform: "g", chatId: `c${i}`, messageId: "m", agentId: "nouva" });
    }

    expect(registry.size()).toBeLessThanOrEqual(200);
    expect(registry.hops("g", "old")).toBe(0);
  });

  test("conversations created by the hop count alone are bounded too", () => {
    // An agent can be addressed in a chat this daemon has never sent to, so the count creates the
    // record. Enforcing the bound only on the message path would leave a second, unbounded way in.
    const registry = new OutboundRegistry();
    for (let i = 0; i < 250; i += 1) registry.setHops("g", `c${i}`, 1);

    expect(registry.size()).toBeLessThanOrEqual(200);
  });

  test("a reset on an unknown conversation does not take a slot", () => {
    // Every human message resets the count. Allocating a record for each would make the bound depend
    // on how many people have ever spoken to the daemon.
    const registry = new OutboundRegistry();
    registry.setHops("g", "never-seen", 0);
    expect(registry.size()).toBe(0);
  });
});

/**
 * An agent naming another agent in a DM.
 *
 * Reported live: Nouva finished a peer turn with Nox and reported it in a person's Telegram DM —
 * "Nox says the PR is up". Telegram echoed that back through the inbound handler, the router found
 * "nox" in the text, and Nox took a regular turn in a DM it has no presence in, speaking through
 * Nouva's bot under Nouva's name.
 *
 * The mention gate did not stop it because the reason genuinely *was* a mention, and the voice
 * filter did not either: an agent with no gateway on a platform falls back to the inbound one, so
 * the comparison it makes says "same connection" and lets it through.
 */
describe("isNarrationNotAddress", () => {
  const telegram = [
    { enabled: true, platform: "telegram", agent: "nouva" },
    { enabled: true, platform: "discord", agent: "nox" },
  ];

  test("a DM naming an agent with no presence on this platform is narration", () => {
    expect(
      isNarrationNotAddress({
        chatType: "dm",
        named: "nox",
        inboundOwner: "nouva",
        platform: "telegram",
        gateways: telegram,
      }),
    ).toBe(true);
  });

  test("a group is where a mention can genuinely hand work over", () => {
    // The other agent may not be in the room either, but a room is somewhere it *can* be, and the
    // platform will say so by failing the send. A DM has nobody else in it by definition.
    expect(
      isNarrationNotAddress({
        chatType: "channel",
        named: "nox",
        inboundOwner: "nouva",
        platform: "telegram",
        gateways: telegram,
      }),
    ).toBe(false);
  });

  test("the agent that owns the connection is always addressable", () => {
    expect(
      isNarrationNotAddress({
        chatType: "dm",
        named: "nouva",
        inboundOwner: "nouva",
        platform: "telegram",
        gateways: telegram,
      }),
    ).toBe(false);
  });

  test("an agent with its own bot here is addressable even when that bot is down", () => {
    /**
     * The flaw in the first version of this guard, which asked `voiceGatewayId`. That returns the
     * inbound connection in three cases, and the third is "its own gateway exists but is not
     * connected" — so a momentary disconnect looked exactly like having no presence, and a
     * legitimate hand-off was dropped with a debug line.
     *
     * Presence is a fact about configuration. There is deliberately no connection status in this
     * function's input.
     */
    expect(
      isNarrationNotAddress({
        chatType: "dm",
        named: "nero",
        inboundOwner: "nouva",
        platform: "telegram",
        // Configured on this platform. Whether the process can reach it right now is another
        // question, answered elsewhere, and it must not change this answer.
        gateways: [...telegram, { enabled: true, platform: "telegram", agent: "nero" }],
      }),
    ).toBe(false);
  });

  test("a disabled gateway is not a presence", () => {
    expect(
      isNarrationNotAddress({
        chatType: "dm",
        named: "nero",
        inboundOwner: "nouva",
        platform: "telegram",
        gateways: [...telegram, { enabled: false, platform: "telegram", agent: "nero" }],
      }),
    ).toBe(true);
  });
});
