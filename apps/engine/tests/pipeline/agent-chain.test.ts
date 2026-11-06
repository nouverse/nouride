/**
 * Two agents in one channel, talking to each other for real.
 *
 * `agent-mentions.test.ts` covers the rules in isolation. This drives the whole pipeline —
 * router, outbound registry, hop budget, prompt — because every part of this feature is a
 * *connection* between those, and connections are what unit tests miss. The specific thing being
 * proved is that the exchange **stops**, in all three ways it can: a closing line with no tag, the
 * hop budget running out, and an agent declining to answer itself.
 *
 * The platform is simulated by handing each outbound message straight back to the gateway as
 * inbound, which is what Discord actually does — the bot sees its own messages.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

async function twoAgents(options: {
  turns: { text?: string }[];
  maxHops?: number;
  mentionsEnabled?: boolean;
  /** `[gateways.telegram.main] agent` — the one-bot-per-agent shape. */
  owner?: string;
}) {
  // Access is open, the bench's default: these are about agents handing work to each other, not about who may talk.
  bench = await pipelineBench({
    turns: options.turns,
    agents: ["nouva", "nox"],
    config: {
      // No `agent = ...` on the gateway: an owner would route every unaddressed message to it, and
      // then a chain "ending" would prove nothing about mentions.
      gateways: {
        telegram: {
          main: {
            enabled: false,
            token: "telegram-main",
            ...(options.owner ? { agent: options.owner } : {}),
          },
        },
      },
      agents: {
        mentions_enabled: options.mentionsEnabled ?? true,
        mention_max_hops: options.maxHops ?? 4,
      },
    },
  });
  const { gateway, pipeline, requests } = bench;
  pipeline.setTools(new Map());
  pipeline.attach();

  let echoed = 0;
  return {
    gateway,
    pipeline,
    requests,
    /** A human speaks. */
    async human(text: string, replyTo?: string) {
      gateway.receive(
        // A room, said explicitly rather than left to the envelope default. This whole file is about
        // two agents in one channel, and the default is a DM — where a tag reaches nobody, because
        // each bot has its own private conversation and the handover goes over `ask_agent` instead.
        // The fixture read as a channel and behaved as a DM for as long as the two were the same.
        envelope({ id: `h${++echoed}`, chatType: "group", text, timestamp: Date.now(), ...(replyTo ? { replyTo } : {}) }),
      );
      await pipeline.idle();
    },
    /**
     * Hand the newest outbound message back as inbound, the way a platform does.
     *
     * `<instance>#N` matches the id `FakeGateway.send` returned for it, which is how the pipeline
     * recognises the message as one of ours rather than some other bot's.
     */
    async echoLast() {
      const last = gateway.sent.at(-1);
      if (!last) throw new Error("nothing was sent to echo back");
      gateway.receive(
        envelope({
          id: `${gateway.id}#${gateway.sent.length}`,
          chatType: "group",
          text: last.text ?? "",
          senderId: "bot",
          senderName: "bot",
          senderIsBot: true,
          timestamp: Date.now(),
        }),
      );
      await pipeline.idle();
    },
  };
}

describe("handing work over", () => {
  test("a tag delegates, and a reply without one ends it", async () => {
    // The exact exchange the feature was asked for. Three provider turns are scripted; a fourth
    // call would mean the closing line woke somebody up.
    const h = await twoAgents({
      turns: [
        { text: "@nox kerjain ini, disuruh Gading" },
        { text: "udah kelar @nouva, PR di xxx" },
        { text: "SIP okay Nox, nanti kita butuh review Gading dulu ya" },
      ],
    });

    await h.human("@nouva tolong minta nox benerin build");
    await h.echoLast(); // nouva's tag reaches nox
    await h.echoLast(); // nox's answer reaches nouva
    await h.echoLast(); // nouva's closing line reaches nobody

    expect(h.gateway.sent.map((m) => m.text)).toEqual([
      "@nox kerjain ini, disuruh Gading",
      "udah kelar @nouva, PR di xxx",
      "SIP okay Nox, nanti kita butuh review Gading dulu ya",
    ]);
    // "Nox" appears in that last line as a name, not a tag. Matching it would make every polite
    // sign-off restart the exchange, which is the failure mode this whole design is arranged
    // around.
    expect(h.requests).toHaveLength(3);
  });

  test("the second agent is told the work came from the first", async () => {
    const h = await twoAgents({ turns: [{ text: "@nox check the build" }, { text: "on it" }] });

    await h.human("@nouva ask nox to check the build");
    await h.echoLast();

    // Without this the receiving agent sees an unattributed instruction and answers as if a human
    // sent it — which is how an agent ends up asking a bot to clarify.
    const system = h.requests[1]?.messages?.[0]?.content ?? "";
    expect(system).toContain("nouva");
  });

  test("a background job does not end the chain — the closing hop still lands", async () => {
    /**
     * The shape the operator asked about, and the one the screenshots show: Nero starts something in
     * the background, Nox is standing by, and the exchange has to close *after* the job reports in.
     *
     * Two things could stop it, and both are checked here. The wake-up used to claim it was a DM, so
     * the agent it woke was told a tag reaches nobody — in the one room where the tag is the whole
     * mechanism. And a hop budget already half spent before the job started would have to survive the
     * wait: it does not have to, because a job reporting in resets it. The wake-up is a system event,
     * not one of our bots talking, so `classifyInbound` reads it as a human speaking and the count
     * goes back to zero. An overnight chain is still bounded; an interrupted one is not punished for
     * having been interrupted.
     */
    const h = await twoAgents({
      turns: [
        // Nouva hands the first half over; Nox says it is standing by, without a tag, which ends the
        // exchange. Both hops of the budget are now spent.
        { text: "@nox gw build dulu ya, abis itu lu audit" },
        { text: "siap Nouva, gw standby nunggu build" },
        // The job finishes. Nouva reports and hands over the closing half.
        { text: "build kelar, 0 error. @nox giliran lu audit" },
        // Nox closes it — no tag, so nothing wakes after this.
        { text: "udah gw audit, aman. lanjut merge aja" },
      ],
      maxHops: 2,
    });

    await h.human("@nouva build terus minta nox audit");
    await h.echoLast(); // nouva's tag reaches nox
    await h.echoLast(); // nox's untagged reply reaches nobody — and spends the last hop

    h.pipeline.wakeForJob({
      job: {
        id: "job_9",
        agentId: "nouva",
        gatewayId: h.gateway.id,
        chatId: "chat-1",
        command: "npm run build",
        status: "succeeded",
        exitCode: 0,
        startedAt: Date.now() - 3000,
        endedAt: Date.now(),
        logPath: "/tmp/job_9.log",
      },
      tail: "built in 12s",
    } as never);
    await h.pipeline.idle();
    await h.echoLast(); // nouva's post-job tag reaches nox
    await h.echoLast(); // nox's sign-off has no tag, so it reaches nobody

    expect(h.gateway.sent.map((m) => m.text)).toEqual([
      "@nox gw build dulu ya, abis itu lu audit",
      "siap Nouva, gw standby nunggu build",
      "build kelar, 0 error. @nox giliran lu audit",
      "udah gw audit, aman. lanjut merge aja",
    ]);
    // No exhausted notice anywhere. Without the reset the post-job tag would be the third hop of a
    // two-hop budget, and what the room would have seen instead of Nox's audit is the daemon saying
    // the two of them had been talking for long enough.
    expect(h.gateway.sent.some((m) => m.text?.includes("back and forth"))).toBe(false);
    // Four turns, and specifically not three: the fourth is the closing hop, which is the one that
    // used to be lost. A fifth would mean the sign-off woke somebody.
    expect(h.requests).toHaveLength(4);
  });

  test("each agent is told who else is in the room, and what a tag means", async () => {
    const h = await twoAgents({ turns: [{ text: "ok" }] });
    await h.human("@nouva hi");

    const system = h.requests[0]?.messages?.[0]?.content ?? "";
    expect(system).toContain("@nox");
    expect(system).toContain("hands the work over");
  });
});

describe("the brakes", () => {
  test("the hop budget stops a pair that will not stop themselves", async () => {
    // Two agents scripted to tag each other forever — the runaway the budget exists for. With
    // max_hops = 2 the third handover is refused.
    const h = await twoAgents({
      maxHops: 2,
      // Numbered, because two identical messages inside the dedup window are dropped as a repeat —
      // which would end the chain for a reason that has nothing to do with the budget under test.
      turns: Array.from({ length: 10 }, (_, i) => ({
        text: i % 2 === 0 ? `@nox round ${i}` : `@nouva round ${i}`,
      })),
    });

    await h.human("@nouva start");
    for (let i = 0; i < 6; i += 1) await h.echoLast();

    const texts = h.gateway.sent.map((m) => m.text ?? "");
    const notice = texts.find((t) => t.includes("back and forth"));
    expect(notice).toBeDefined();
    expect(notice).toContain("2");
    // Said out loud in the chat rather than dropped, so the silence has a reason attached to it.
    expect(notice!.toLowerCase()).toContain("say something");
    // The budget held: turns are bounded, not merely slowed.
    expect(h.requests.length).toBeLessThanOrEqual(3);
  });

  test("a human speaking resets the budget", async () => {
    const h = await twoAgents({
      maxHops: 1,
      turns: [{ text: "@nox one" }, { text: "@nouva two" }, { text: "@nox three" }],
    });

    await h.human("@nouva start");
    await h.echoLast(); // hop 1 — allowed, nox answers
    await h.echoLast(); // hop 2 — over budget, notice
    const beforeReset = h.requests.length;

    await h.human("@nouva carry on"); // the operator returns; the count goes back to zero
    await h.echoLast();

    // The operator's presence is the whole point of the budget: it bounds unattended chatter, not
    // supervised work. A limit that survived a human joining would mute the daemon in its own chat.
    expect(h.requests.length).toBeGreaterThan(beforeReset + 1);
  });

  test("a fallback route never continues a chain", async () => {
    // The shape most installations actually have: one bot, one owning agent. Every message that
    // names nobody belongs to that agent — which is right for a human, and wrong for an agent,
    // because it means a closing line with no tag gets answered anyway and the exchange never ends.
    // Only a mention may route a message from an agent.
    const h = await twoAgents({
      owner: "nouva",
      turns: [
        { text: "@nox kerjain ini" },
        { text: "udah kelar, gw tunggu review Gading" }, // no tag: this is the end
        { text: "unreachable" },
      ],
    });

    await h.human("@nouva minta nox benerin build");
    await h.echoLast(); // reaches nox
    await h.echoLast(); // nox's untagged reply — the owner rule must NOT pick it up

    expect(h.requests).toHaveLength(2);
    expect(h.gateway.lastText()).toBe("udah kelar, gw tunggu review Gading");
  });

  test("a human who names nobody still reaches the owning agent", async () => {
    // The other half of the rule above: the fallbacks are still there, and still do their job for
    // the person the daemon exists to serve. Disabling them for everyone would be a much simpler
    // patch and a much worse daemon.
    const h = await twoAgents({ owner: "nouva", turns: [{ text: "Jakarta." }] });

    await h.human("what is the capital of Indonesia?");

    expect(h.gateway.lastText()).toBe("Jakarta.");
  });

  test("switching it off restores the old blanket ban on bot messages", async () => {
    const h = await twoAgents({
      mentionsEnabled: false,
      turns: [{ text: "@nox kerjain ini" }, { text: "should never be reached" }],
    });

    await h.human("@nouva delegate to nox");
    await h.echoLast();

    // One escape hatch, one line of config, and the behaviour is exactly what shipped before this
    // feature existed.
    expect(h.requests).toHaveLength(1);
  });

  test("an agent does not answer its own message", async () => {
    const h = await twoAgents({
      turns: [{ text: "thinking out loud about @nouva herself" }, { text: "unreachable" }],
    });

    await h.human("@nouva say your own name");
    await h.echoLast();

    // A model discussing itself writes its own name constantly. Each one would otherwise be a
    // self-directed turn, and the budget would only stop it after paying for four.
    expect(h.requests).toHaveLength(1);
  });
});

describe("replying to an agent", () => {
  test("/new keeps who wrote what: a reply to an answer from before it still reaches its author", async () => {
    const h = await twoAgents({ turns: [{ text: "Jakarta." }, { text: "About 10 million." }] });

    await h.human("@nouva what is the capital of Indonesia?");
    // Addressed, because in a channel with two agents an unaddressed message reaches nobody — a
    // command included.
    await h.human("@nouva /new");
    // Hitting reply on her answer addresses her as plainly as a tag, and the platform brings the quoted words along —
    // the history the reply needs. This test once said the opposite, and a reply after a `/reset` in a WhatsApp group
    // went unanswered until she was tagged (2026-10-21).
    await h.human("and how many people live there?", "telegram:main#1");

    expect(h.gateway.lastText()).toBe("About 10 million.");
  });

  test("a human reply reaches the agent that wrote it, with no tag", async () => {
    const h = await twoAgents({ turns: [{ text: "Jakarta." }, { text: "About 10 million." }] });

    await h.human("@nouva what is the capital of Indonesia?");
    // Hitting reply on "Jakarta." and typing a follow-up. Requiring a tag as well would be asking
    // people to talk like a router.
    await h.human("and how many people live there?", "telegram:main#1");

    expect(h.gateway.lastText()).toBe("About 10 million.");
  });

  test("a reply to somebody else's message is not routed", async () => {
    const h = await twoAgents({ turns: [{ text: "Jakarta." }, { text: "unreachable" }] });

    await h.human("@nouva what is the capital of Indonesia?");
    await h.human("and how many people live there?", "some-humans-message");

    // Two agents share this channel, so a message addressed to nobody has no obvious owner.
    // Guessing here is how two bots end up answering the same question.
    expect(h.requests).toHaveLength(1);
  });
});
