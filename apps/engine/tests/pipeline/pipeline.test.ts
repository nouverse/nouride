/**
 * End-to-end through the real pipeline: envelope in, reply out.
 *
 * Everything is real except the network and the chat platform — the router, queue, hook
 * registry, prompt builder, tool loop, tool sandbox, SQLite session store and provider wire
 * mapping all run. That combination is where Phase 1's bugs actually live; unit tests around
 * each part would not have caught a mis-wired stage.
 */

import { holdLines, messageText, sessionIdFor } from "@nouride/shared";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Job, Tool, ToolContext } from "@nouride/shared";
import { readTextFileIfExists, statFile, type SqliteDb } from "@nouride/runtime";
import { Pipeline } from "@/modules/pipeline/index.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { TurnStore } from "@/modules/turns/turns.store.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { toTurnPayload } from "@/modules/turns/transcript.ts";
import { withoutReminders } from "@/modules/llm/executor/reminders.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import type { JobRecord } from "@/modules/jobs/jobs.store.ts";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import { AutoApprove } from "@/modules/tools/auto-approve.store.ts";
import type { Memory } from "@/modules/memory/index.ts";
import { bootMemory, checkMemoryVault } from "@/boot/memory.ts";
import { stopTurns } from "@/boot/interrupted.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { peersFrom } from "@/modules/tools/builtins/ask-agent.ts";
import { UndeliverableError } from "@nouride/gateways";
import { AutoApprovalGate, conversationOf, envelope as envelopeAt, eventually, FakeGateway, type scriptedOpenAI, sleep, UnavailableApprovalGate } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

/**
 * A message as a platform delivers it now. The harness has the inbox a daemon has, which leaves a message sent long ago
 * unanswered as a backlog after downtime — and `envelopeAt`'s fixed timestamp is years old. A test about when a message
 * was sent says so.
 */
const envelope = (overrides: Parameters<typeof envelopeAt>[0] = {}) => envelopeAt({ timestamp: Date.now(), ...overrides });

const PROVIDER_TOML = {
  providers: {
    test: { kind: "openai", base_url: "https://fake.test/v1", api_key: "testkey" },
  },
  llm: { defaults: { provider: "test", model: "test-model" } },
  gateways: { telegram: { main: { enabled: false, token: "telegram-main", agent: "nouva" } } },
};

interface Harness {
  pipeline: Pipeline;
  /** Present when the harness was asked for memory. */
  memory?: Memory;
  gateway: FakeGateway;
  /** The second connection, when `secondAgent` asked for one. */
  second: FakeGateway;
  /** What the daemon said in its own voice — pairing codes to a chat, alerts to the operator. */
  notices: {
    /**
     * `sentCount` is how many messages had already reached the gateway when this notice went out.
     *
     * The notifier records rather than sends, so its ordering against the agent's own replies is
     * otherwise invisible — and ordering is the whole question for a notice that explains a reply
     * standing next to it.
     */
    chat: { chatId: string; text: string; sentCount: number; replyTo?: string }[];
    alerts: string[];
  };
  sessions: SessionStore;
  /** What each turn did. Present in every daemon, so present on the bench. */
  turns: TurnStore;
  requests: any[];
  agentsDir: string;
  dataDir: string;
  db: SqliteDb;
  /** Swap the provider's transport mid-test — for stalls and recoveries. */
  setFetch: (impl: typeof fetch) => void;
  /** The scripted transport, to restore after a failure. */
  scripted: typeof fetch;
}

let cleanup: (() => void)[] = [];

async function harness(options: {
  turns: Parameters<typeof scriptedOpenAI>[0];
  agentConfigToml?: string;
  /** `MEMORY.md` for the pack, written before the registry loads it. For prompt-budget tests. */
  agentMemory?: string;
  configOverrides?: Record<string, unknown>;
  autoApprove?: boolean;
  /** Observe provider health counting. */
  providerErrors?: Map<string, number>;
  /** Start with a failing transport instead of the scripted one. */
  failWith?: { status: number; body: unknown };
  /** Fast typing keepalive, so a test can observe refreshes without waiting seconds. */
  typingRefreshMs?: number;
  /** Fast progress edits, so a test can watch the line change without waiting seconds. */
  progressIntervalMs?: number;
  /**
   * The persisted "stop asking me" store.
   *
   * Deliberately not called `autoApprove` — that name is already taken above by the boolean that
   * swaps in `AutoApprovalGate`, and colliding with it made a test pass by approving everything
   * rather than by exercising the store.
   */
  autoApproveStore?: AutoApprove;
  /** Extra tools merged into the registry — used to script a deliberately slow tool. */
  extraTools?: Map<string, Tool>;
  /**
   * Adds a second agent pack *and* a second gateway that owns it.
   *
   * The shape one-bot-per-agent takes, and the only way to see which identity an answer went out
   * under: a single gateway cannot tell "answered through its own connection" from "answered through
   * the trigger's".
   */
  secondAgent?: string;
  /** The second agent's `config.toml`, when what it may do is the question. */
  secondAgentConfigToml?: string;
  /** Swap the approval gate — for a gate that never answers, which is the case worth testing. */
  approvals?: ConstructorParameters<typeof Pipeline>[0]["approvals"];
  /** Wire `modules/memory` the way `boot/memory.ts` does: recall in the prompt, the memory tools. */
  memory?: boolean;
  /** Record usage into `llm_usage`, as a daemon does. */
  usage?: boolean;
}): Promise<Harness> {
  // Indirection so a test can swap the transport after construction: the provider client is built
  // once and cached, so replacing it later is not an option.
  let scripted!: typeof fetch;
  let active!: typeof fetch;
  const routed = ((...args: Parameters<typeof fetch>) => active(...args)) as typeof fetch;

  const gateway = new FakeGateway();
  // Same platform, different instance — a Telegram bot cannot answer into a Discord channel, and the
  // rule under test is explicitly platform-local.
  const second = new FakeGateway("telegram:second", "telegram");

  // Records rather than sends. The pairing path goes through the notifier, not through a gateway, so
  // without this it is invisible to a test — which is why a storm of pairing codes reached a live
  // Discord channel with the suite green.
  const notices: Harness["notices"] = { chat: [], alerts: [] };
  const notifier = {
    toChat: async (target: { chatId: string; replyTo?: string }, text: string) => {
      notices.chat.push({ chatId: target.chatId, text, sentCount: gateway.sent.length, ...(target.replyTo ? { replyTo: target.replyTo } : {}) });
      return true;
    },
    alert: async (_key: string, text: string) => {
      notices.alerts.push(text);
      return true;
    },
  } as unknown as ConstructorParameters<typeof Pipeline>[0]["notifier"];

  let memory: Memory | undefined;
  const bench = await pipelineBench({
    turns: options.turns,
    fetch: (fetchImpl) => {
      scripted = fetchImpl;
      active = options.failWith
        ? ((async () =>
            new Response(JSON.stringify(options.failWith!.body), {
              status: options.failWith!.status,
              headers: { "content-type": "application/json" },
            })) as unknown as typeof fetch)
        : fetchImpl;
      return routed;
    },
    agents: [
      { id: "nouva", ...(options.agentMemory ? { memory: options.agentMemory } : {}), ...(options.agentConfigToml ? { configToml: options.agentConfigToml } : {}) },
      ...(options.secondAgent
        ? [{
            id: options.secondAgent,
            identity: `# IDENTITY\n- Name: ${options.secondAgent}\n- Headline: Runs the builds and reports what broke\n`,
            ...(options.secondAgentConfigToml ? { configToml: options.secondAgentConfigToml } : {}),
          }]
        : []),
    ],
    // Access is `pair` by default, which is right for a daemon and wrong for a test bench: every
    // fixture sender is a stranger, so every test would assert against a pairing code. Tests that are
    // *about* the gate say so by setting `[security.access]` themselves; everyone else runs open — the
    // bench's rule.
    //
    // Not the same as leaving the store out. That is what this suite did before, and it made the whole
    // gate unreachable — a pairing storm shipped to a live Discord channel with all of this green.
    config: { ...PROVIDER_TOML, ...options.configOverrides },
    configure: (config) => {
      // A steering reply is its own model call, and these scripts answer turns in order — `steering.test.ts` covers it.
      config.queue.steerReply = false;
      /**
       * And approvals default to `careful` here, for the same reason.
       *
       * The daemon ships `balanced`, which is right for one person on their own machine and wrong for a suite
       * that is largely *about* the gate: at `balanced` every gated tool with no hardline class auto-approves,
       * so a test asserting that `write` asks would pass on a daemon that had stopped asking. A test that
       * is about the level sets it itself.
       */
      if ((options.configOverrides?.security as { approvals?: unknown } | undefined)?.approvals === undefined) {
        config.security.approvals = "careful";
      }
    },
    gateway,
    gateways: [gateway, ...(options.secondAgent ? [second] : [])],
    deps: async ({ config, db, dataDir, turns, providers }) => {
      // The room log, as a daemon has it: the people's half of a group episode.
      const roomMessages = new RoomMessageStore(db);
      // Built the way boot builds it, over the same turn and room logs the pipeline writes — so a memory
      // test here is the daemon's wiring, not a hand-assembled copy of it.
      memory = options.memory ? await bootMemory(config, db, { turns, roomMessages, providers, vaultFormat: await checkMemoryVault(config) }) : undefined;
      return {
        roomMessages,
        ...(memory ? { memory } : {}),
        // Present in every test because it is present in every daemon. Left out, a tool result of any size
        // reaches the context untouched — which is the behaviour the cap exists to end, and a suite that
        // omits it would go green on a daemon that had lost the feature.
        spill: new ToolOutputSpill(join(dataDir, "tool-output")),
        notifier,
        approvals: options.approvals ?? (options.autoApprove ? new AutoApprovalGate() : new UnavailableApprovalGate()),
        ...(options.providerErrors ? { providerErrors: options.providerErrors } : {}),
        ...(options.typingRefreshMs ? { typingRefreshMs: options.typingRefreshMs } : {}),
        ...(options.progressIntervalMs ? { progressIntervalMs: options.progressIntervalMs } : {}),
        ...(options.autoApproveStore ? { autoApprove: options.autoApproveStore } : {}),
        ...(options.usage ? { usage: new UsageStore(db) } : {}),
      };
    },
  });
  cleanup.push(bench.dispose);
  const { pipeline, registry, config, sessions, requests, agentsDir, dataDir, db } = bench;
  const turnRecords = bench.turns;

  const registryTools = createBuiltinTools({
    security: config.security,
    ...(memory ? { memory } : {}),
    sessionStatus: (ctx) => pipeline.sessionStatus(ctx),
    runSubagent: pipeline.subagentRunner(),
    // Mirrors `boot/tools.ts`. Offered here for the same reason it is there: `resolveToolset` withdraws
    // it per turn when there is nobody to ask, so a single-agent test is unaffected by its presence.
    askAgent: {
      run: pipeline.peerTurnRunner(),
      ...peersFrom(registry, () => true),
    },
  });
  for (const [name, tool] of options.extraTools ?? []) registryTools.set(name, tool);
  pipeline.setTools(registryTools);
  pipeline.attach();

  return {
    pipeline,
    ...(memory ? { memory } : {}),
    gateway,
    second,
    notices,
    sessions,
    turns: turnRecords,
    requests,
    agentsDir,
    dataDir,
    db,
    setFetch: (impl) => {
      active = impl;
    },
    scripted,
  };
}


beforeEach(() => {
  cleanup = [];
});

afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
});

/**
 * The access gate runs before anything else knows what the message is — before the bot check, before
 * routing. Both defects below were live on Discord with six agents in one channel: one "@Nero hidup?"
 * produced twelve messages, and none of the twelve came from Nero deciding to answer.
 */
/**
 * With one bot per agent, an agent has to answer with its own face.
 *
 * Discord delivers a bot's message to every other bot, and authorship is only resolvable on the
 * connection that sent it — so a handover is picked up on the *sender's* connection, and the answer
 * used to go out through the sender's bot. Live: Nestor was asked something, handed it to Nexa, and
 * Nexa's answer appeared under Nestor's name, signed "Halo! Nexa di sini".
 */
describe("whose bot an agent speaks through", () => {
  const twoBots = {
    configOverrides: {
      ...PROVIDER_TOML,
      // Enabled, because ownership is only consulted for connections the daemon considers live —
      // and `enabled: false` is what the default fixture uses, which made the first version of this
      // test assert against a rule that never ran.
      gateways: {
        telegram: {
          main: { enabled: true, token: "telegram-main", agent: "nouva" },
          second: { enabled: true, token: "telegram-main", agent: "nox" },
        },
      },
    },
  };

  test("an agent with its own connection answers through it, not through the trigger's", async () => {
    const h = await harness({ turns: [{ text: "Nox here" }], ...twoBots, secondAgent: "nox" });
    // Addressed by name, so it routes to nox while arriving on nouva's connection.
    h.gateway.receive(envelope({ chatType: "group", text: "nox: are you there?" }));
    await h.pipeline.idle();

    expect(h.second.sent.map((m) => m.text)).toEqual(["Nox here"]);
    // And nothing under the wrong name.
    expect(h.gateway.sent).toHaveLength(0);
  });

  test("it falls back to the inbound connection when its own cannot deliver", async () => {
    // Nothing in config says which rooms a bot was invited to, so this is the normal way it fails.
    const h = await harness({ turns: [{ text: "Nox here" }], ...twoBots, secondAgent: "nox" });
    h.second.failSend = new Error("Missing Access");

    h.gateway.receive(envelope({ chatType: "group", text: "nox: are you there?" }));
    await h.pipeline.idle();

    // Under the wrong name, which beats silence.
    expect(h.gateway.sent.map((m) => m.text)).toEqual(["Nox here"]);
  });

  test("the daemon's own notices stay on the connection they came in on", async () => {
    // A pairing code or a cost-cap refusal is nobody's words; there is no identity to speak with.
    const h = await harness({ turns: [{ text: "hi" }], ...twoBots, secondAgent: "nox" });
    h.gateway.receive(envelope({ chatType: "group", text: "nox: /new" }));
    await h.pipeline.idle();

    // `/new` on an empty conversation is a daemon notice, and it answers where it was asked.
    expect(h.gateway.lastText()).toContain("Already fresh");
    expect(h.second.sent).toHaveLength(0);
  });
});

describe("a command addressed by a platform tag", () => {
  const sixBots = {
    configOverrides: {
      ...PROVIDER_TOML,
      daemon: { orchestrator: "nouva" },
      gateways: {
        telegram: {
          main: { enabled: true, token: "telegram-main", agent: "nouva" },
          second: { enabled: true, token: "telegram-main", agent: "nox" },
        },
      },
    },
  };

  test("a tagged command is handled, and never reaches the model", async () => {
    // The shape that mattered: while a turn waits for an approval, `/approve` is the only way out —
    // and it has to be recognised as a command *and* jump the queue. The adapter has already taken the
    // tag off the front of the text by this point; what is left is the routing half.
    const h = await harness({ turns: [{ text: "should not happen" }], ...sixBots, secondAgent: "nox" });

    h.gateway.receive(
      envelope({
        chatType: "channel",
        text: "/new",
        mentions: ["1"],
        mentionsSelf: true,
      }),
    );
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toContain("Already fresh");
    expect(h.requests).toHaveLength(0);
  });

  test("a command tagging somebody else is not ours to answer", async () => {
    const h = await harness({ turns: [{ text: "should not happen" }], ...sixBots, secondAgent: "nox" });

    h.gateway.receive(
      envelope({ chatType: "channel", text: "/new", mentions: ["someone-else"] }),
    );
    await h.pipeline.idle();

    expect(h.gateway.sent).toHaveLength(0);
    expect(h.second.sent).toHaveLength(0);
  });
});

/**
 * A handover between agents that have separate bot tokens.
 *
 * The arrangement where it could not work at all, and nothing said so. Nouva writes a correct mention
 * of Nexa; Nouva's own connection sees the tag is not for it and defers; Nexa's connection sees a bot
 * message it has no record of and drops it as somebody else's. Both decisions are right in isolation
 * and together they mean nobody runs.
 *
 * The record of who wrote a message was keyed by connection, and every connection gets its own copy
 * of the same message — so the author was only findable on the one that sent it.
 */
/**
 * One identity rule, every output.
 *
 * An agent says three kinds of thing — its answer, its live progress line, and its approval request —
 * and each went out on a different rule until they were made to share one. The visible result was
 * Nexa's "waiting for you" posted under Nouva's name and avatar, which then made `@Nouva /approve`
 * look for a request that was never Nouva's.
 */
describe("which connection an agent speaks through", () => {
  const twoBots = {
    configOverrides: {
      ...PROVIDER_TOML,
      gateways: {
        telegram: {
          main: { enabled: true, token: "telegram-main", agent: "nouva" },
          second: { enabled: true, token: "telegram-main", agent: "nox" },
        },
      },
    },
  };

  test("its own, when it has one on this platform", async () => {
    const h = await harness({ turns: [{ text: "ok" }], ...twoBots, secondAgent: "nox" });
    expect(h.pipeline.voiceGatewayId("nox", "telegram:main")).toBe("telegram:second");
    expect(h.pipeline.voiceGatewayId("nouva", "telegram:second")).toBe("telegram:main");
  });

  test("the inbound one, when it has none", async () => {
    const h = await harness({ turns: [{ text: "ok" }], ...twoBots, secondAgent: "nox" });
    // No connection owns `nobody`, so there is no identity to switch to.
    expect(h.pipeline.voiceGatewayId("nobody", "telegram:main")).toBe("telegram:main");
  });

  test("the inbound one, when its own is disconnected", async () => {
    const h = await harness({ turns: [{ text: "ok" }], ...twoBots, secondAgent: "nox" });
    h.second.status = "disconnected";
    // Speaking through a connection that is down is silence with extra steps.
    expect(h.pipeline.voiceGatewayId("nox", "telegram:main")).toBe("telegram:main");
  });

  test("the typing indicator goes to its own connection, not the trigger's", async () => {
    // The one a person notices first: the chat said "Nouva is typing…" for the whole time Nexa was
    // working. Asserted instead of the progress bubble because the bubble is written on a timer, and a
    // test that races it passes for the wrong reason.
    const h = await harness({ turns: [{ text: "done" }], ...twoBots, secondAgent: "nox" });

    h.gateway.receive(envelope({ chatType: "group", text: "nox: baca file" }));
    await h.pipeline.idle();

    expect(h.second.typing).toContain("chat-1");
    expect(h.gateway.typing).toEqual([]);
    // And the answer landed there too, so both halves agree on who is speaking.
    expect(h.second.sent.map((m) => m.text)).toEqual(["done"]);
  });
});

describe("when a chain runs out of hops", () => {
  const twoBots = {
    configOverrides: {
      ...PROVIDER_TOML,
      agents: { mentions_enabled: true, mention_max_hops: 1 },
      gateways: {
        telegram: {
          main: { enabled: true, token: "telegram-main", agent: "nouva" },
          second: { enabled: true, token: "telegram-main", agent: "nox" },
        },
      },
    },
  };

  /**
   * The same two bots with room for two hops.
   *
   * A budget of one cannot show the counting bug: the extra count a second connection wrote was
   * invisible while it happened, because the claim already stopped that connection from speaking.
   * It only surfaced on the hop after, so seeing it needs a chain rather than a handover.
   */
  const twoHops = {
    configOverrides: {
      ...twoBots.configOverrides,
      agents: { mentions_enabled: true, mention_max_hops: 2 },
    },
  };

  test("the notice comes from the agent that would have answered", async () => {
    // It reads "nouva and I have gone back and forth…", so the "I" is the agent being handed to —
    // which nothing knows until the message is routed. Sent before routing it went out on whichever
    // connection carried the trigger, under the wrong name, describing itself in the third person.
    //
    // The arrangement that makes that visible: the exhausting message arrives on *nox's* connection
    // and names nouva, so the connection that carried it and the one that owes the answer differ.
    const h = await harness({
      turns: [{ text: "nox: satu" }, { text: "nouva: dua" }],
      ...twoBots,
      secondAgent: "nox",
    });

    h.gateway.receive(envelope({ id: "m1", chatType: "group", text: "nouva: mulai" }));
    await h.pipeline.idle();

    // Nouva handed over. Echo it to nox's connection, as the platform does.
    h.second.receive(
      envelope({
        id: `${h.gateway.id}#${h.gateway.sent.length}`,
        chatType: "group",
        text: h.gateway.sent.at(-1)!.text,
        senderIsBot: true,
        gatewayId: "telegram:second",
      }),
    );
    await h.pipeline.idle();

    // Nox handed back, which spends the last hop. This copy arrives on nox's own connection.
    h.second.receive(
      envelope({
        id: `${h.second.id}#${h.second.sent.length}`,
        chatType: "group",
        text: h.second.sent.at(-1)!.text,
        senderIsBot: true,
        gatewayId: "telegram:second",
      }),
    );
    await h.pipeline.idle();

    // Nouva declines, on nouva's connection — not on the one the message came in through.
    expect(h.gateway.sent.at(-1)?.text).toContain("gone back and forth");
    expect(h.second.sent.at(-1)?.text).not.toContain("gone back and forth");
  });

  /**
   * One handover is one hop, however many of our bots were handed the message.
   *
   * The count used to be advanced before routing, and every connection on the platform is handed
   * every message — so each pass read the depth the pass before it had just written. Two bots made
   * one handover cost two; six bots made it cost six. Observed live in a Discord thread with six of
   * them, where the first delegation of the conversation came back "(nouva and I have gone back and
   * forth 5 times, so I am leaving it there)". Nobody had gone anywhere.
   *
   * The extra counts were invisible when they happened — the claim already stopped the second
   * connection from *saying* anything — so the symptom only appeared on the hop after. Which is why
   * this runs a chain rather than a single handover: with a budget of two, the second real hop is
   * the one the old counting refused.
   */
  test("one handover costs one hop, whatever it is echoed to", async () => {
    const h = await harness({
      turns: [{ text: "nox: satu" }, { text: "nouva: dua" }, { text: "nox: tiga" }],
      ...twoHops,
      secondAgent: "nox",
    });

    /** The platform's behaviour: every connection is handed every message. */
    const echoToBoth = async (from: FakeGateway) => {
      const copy = envelope({
        id: `${from.id}#${from.sent.length}`,
        chatType: "group",
        text: from.sent.at(-1)!.text,
        senderIsBot: true,
      });
      h.gateway.receive({ ...copy, gatewayId: "telegram:main" });
      h.second.receive({ ...copy, gatewayId: "telegram:second" });
      await h.pipeline.idle();
    };

    h.gateway.receive(envelope({ id: "m1", chatType: "group", text: "nouva: mulai" }));
    await h.pipeline.idle();

    await echoToBoth(h.gateway); // hop 1: nouva → nox
    expect(h.second.sent.at(-1)?.text).toContain("nouva: dua");

    await echoToBoth(h.second); // hop 2: nox → nouva, the last one the budget allows
    expect(h.gateway.sent.at(-1)?.text).toContain("nox: tiga");

    const notices = [...h.gateway.sent, ...h.second.sent].filter((m) =>
      m.text.includes("gone back and forth"),
    );
    expect(notices).toHaveLength(0);
  });

  test("and the hop after that is still refused", async () => {
    // The other side of the same rule, in the same arrangement: spend the budget for real and the
    // next hop stops. Without this the test above is satisfied by a counter that counts nothing.
    const h = await harness({
      turns: [{ text: "nox: satu" }, { text: "nouva: dua" }, { text: "nox: tiga" }],
      ...twoHops,
      secondAgent: "nox",
    });

    const echoToBoth = async (from: FakeGateway) => {
      const copy = envelope({
        id: `${from.id}#${from.sent.length}`,
        chatType: "group",
        text: from.sent.at(-1)!.text,
        senderIsBot: true,
      });
      h.gateway.receive({ ...copy, gatewayId: "telegram:main" });
      h.second.receive({ ...copy, gatewayId: "telegram:second" });
      await h.pipeline.idle();
    };

    h.gateway.receive(envelope({ id: "m1", chatType: "group", text: "nouva: mulai" }));
    await h.pipeline.idle();
    await echoToBoth(h.gateway); // hop 1
    await echoToBoth(h.second); // hop 2
    await echoToBoth(h.gateway); // hop 3 — past the budget

    expect(h.second.sent.at(-1)?.text).toContain("gone back and forth");
  });
});

describe("a handover between two bots", () => {
  const twoBots = {
    configOverrides: {
      ...PROVIDER_TOML,
      gateways: {
        telegram: {
          main: { enabled: true, token: "telegram-main", agent: "nouva" },
          second: { enabled: true, token: "telegram-main", agent: "nox" },
        },
      },
    },
  };

  test("the addressed agent runs when the trigger arrives on the other connection", async () => {
    const h = await harness({
      turns: [{ text: "nox: tolong cek ini" }, { text: "checked" }],
      ...twoBots,
      secondAgent: "nox",
    });

    // A human starts it, addressing nouva by name.
    h.gateway.receive(envelope({ id: "m1", chatType: "group", text: "nouva: mulai" }));
    await h.pipeline.idle();

    // Nouva's reply went out through its own connection and was recorded there.
    const handover = h.gateway.sent.at(-1);
    expect(handover?.text).toContain("nox:");

    // The platform hands that message back to *both* bots. This is the copy nox's connection sees —
    // a bot message it never sent, with the same id.
    const echo = envelope({
      // The id nouva's connection actually returned for it — the same id nox's connection sees.
      id: `${h.gateway.id}#${h.gateway.sent.length}`,
      chatType: "group",
      text: handover!.text,
      senderIsBot: true,
      gatewayId: "telegram:second",
    });
    h.second.receive(echo);
    await h.pipeline.idle();

    // Nox recognised it as ours, and answered.
    expect(h.requests).toHaveLength(2);
    expect(h.second.sent.map((m) => m.text)).toEqual(["checked"]);
  });

  test("a stranger's bot is still dropped", async () => {
    // The property the connection-scoped key was providing by accident, and which has to survive:
    // a message from a bot we never sent is not ours to answer.
    const h = await harness({ turns: [{ text: "should not happen" }], ...twoBots, secondAgent: "nox" });

    h.second.receive(
      envelope({
        id: "not-ours",
        chatType: "group",
        text: "nox: do something",
        senderIsBot: true,
        gatewayId: "telegram:second",
      }),
    );
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(0);
    expect(h.second.sent).toHaveLength(0);
  });

  test("an agent's own bot is recognised before the outbound registry has a record of it", async () => {
    // The race the message-id registry cannot close: this connection's copy of a message can arrive
    // before this daemon's own send() call — on the *other* connection — has resolved and recorded
    // who sent it. Nothing here ever went through h.gateway.sent, which is what "no record yet"
    // means; the only way nox's connection can tell this is nouva's bot is nouva's own account id.
    const h = await harness({ turns: [{ text: "checked" }], ...twoBots, secondAgent: "nox" });
    h.gateway.selfId = "nouva-bot-id";

    h.second.receive(
      envelope({
        id: "race-1",
        chatType: "group",
        text: "nox: tolong cek ini",
        senderId: "nouva-bot-id",
        senderIsBot: true,
        gatewayId: "telegram:second",
      }),
    );
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    expect(h.second.sent.map((m) => m.text)).toEqual(["checked"]);
  });

  test("a bot that owns none of our connections is still a stranger", async () => {
    // The fallback only ever answers "whose bot is this" — an id that matches none of our own
    // connections must still be dropped, or every unrecognised bot account would be waved through.
    const h = await harness({ turns: [{ text: "should not happen" }], ...twoBots, secondAgent: "nox" });
    h.gateway.selfId = "nouva-bot-id";

    h.second.receive(
      envelope({
        id: "race-2",
        chatType: "group",
        text: "nox: tolong cek ini",
        senderId: "someone-elses-bot",
        senderIsBot: true,
        gatewayId: "telegram:second",
      }),
    );
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(0);
  });
});

describe("one message, one turn", () => {
  const twoBots = {
    configOverrides: {
      ...PROVIDER_TOML,
      // Without it an untagged group message routes nowhere, and the test would pass by asserting
      // silence rather than by asserting one reply.
      daemon: { orchestrator: "nouva" },
      gateways: {
        telegram: {
          main: { enabled: true, token: "telegram-main", agent: "nouva" },
          second: { enabled: true, token: "telegram-main", agent: "nox" },
        },
      },
    },
  };

  test("a message delivered to two connections runs once", async () => {
    // What a platform actually does with a channel message: every bot in the room gets a copy, with
    // the same message id. Each copy is routed independently, and where the signal is the same
    // everywhere — the default agent, here — every copy reaches the same conclusion.
    const h = await harness({ turns: [{ text: "once" }, { text: "twice" }], ...twoBots, secondAgent: "nox" });

    // Addressed by name, so both connections route it to the same agent — which is the collision the
    // claim exists for. An untagged message would now be answered by nobody at all.
    const same = envelope({ id: "m-same", chatType: "group", text: "nouva: tes" });
    h.gateway.receive(same);
    h.second.receive({ ...same, gatewayId: "telegram:second" });
    await h.pipeline.idle();

    const replies = [...h.gateway.sent, ...h.second.sent].map((m) => m.text);
    expect(replies).toEqual(["once"]);
    expect(h.requests).toHaveLength(1);
  });

  test("one message that tags both bots runs both agents", async () => {
    // The case the agent-keyed claim exists for. Each connection resolves the tag to *its own* bot, so
    // the two copies reach different conclusions and are not in conflict — collapsing on the message
    // alone would silence whichever arrived second.
    const h = await harness({
      turns: [{ text: "from nouva" }, { text: "from nox" }],
      ...twoBots,
      secondAgent: "nox",
    });

    const both = envelope({
      id: "m-both",
      chatType: "group",
      text: "<@1>, <@2> tolong dua-duanya",
      mentions: ["1", "2"],
      mentionsSelf: true,
    });
    h.gateway.receive(both);
    h.second.receive({ ...both, gatewayId: "telegram:second" });
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(2);
    expect(h.gateway.sent).toHaveLength(1);
    expect(h.second.sent).toHaveLength(1);
  });

  test("a Telegram basic group, where each bot numbers the message differently, still runs once", async () => {
    // Seen live: `nero halo` in a basic group reached both bots as two different ids, both claims
    // won, and nero answered twice — the copy from the other bot quoting an id nero's bot never saw.
    const h = await harness({ turns: [{ text: "once" }, { text: "twice" }], ...twoBots, secondAgent: "nox" });

    const base = { chatType: "group" as const, text: "nox: tes", idsPerConnection: true };
    h.gateway.receive(envelope({ ...base, id: "57" }));
    h.second.receive(envelope({ ...base, id: "102", gatewayId: "telegram:second" }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    expect(h.gateway.sent).toHaveLength(0);
    expect(h.second.sent.map((m) => [m.text, m.replyTo])).toEqual([["once", "102"]]);
  });

  test("the claim table does not grow without bound", async () => {
    const h = await harness({ turns: [{ text: "ok" }], ...twoBots, secondAgent: "nox" });
    for (let i = 0; i < 40; i += 1) {
      h.gateway.receive(envelope({ id: `m${i}`, chatType: "group", text: "nouva: tes" }));
    }
    await h.pipeline.idle();
    expect(h.pipeline.claimEntries()).toBeLessThanOrEqual(40);
  });
});

describe("the pairing gate", () => {
  const pairing = {
    configOverrides: {
      ...PROVIDER_TOML,
      security: { access: { mode: "pair" } },
    },
  };

  test("a bot is never offered a pairing code", async () => {
    // The loop: a code is a thing a human reads and forwards. A bot does neither, and on a platform
    // that hands every channel message to every bot, the code itself becomes a new unknown sender for
    // the other connections. Each reply produced three more.
    const h = await harness({ turns: [{ text: "should not happen" }], ...pairing });

    h.gateway.receive(
      envelope({
        senderId: "7777777777777777777",
        senderName: "Nox | Security Agent",
        senderIsBot: true,
        chatType: "channel",
        text: "Pairing code: DLV-HF8",
      }),
    );
    await h.pipeline.idle();

    expect(h.notices.chat).toEqual([]);
    expect(h.notices.alerts).toEqual([]);
    // And it does not become a turn either: an unrecognised bot is dropped as foreign_bot, which is
    // where that decision has always belonged.
    expect(h.requests).toHaveLength(0);
    expect(h.gateway.sent).toHaveLength(0);
  });

  /**
   * A room with two of our bots in it. The platform hands each of them the same message, and the gate runs
   * on both: each used to issue a code of its own — two requests on the dashboard for a message that tagged
   * one bot — and neither said anything in the chat.
   */
  const twoBotsPairing = {
    configOverrides: {
      ...PROVIDER_TOML,
      security: { access: { mode: "pair" } },
      gateways: {
        telegram: {
          main: { enabled: true, token: "telegram-main", agent: "nouva" },
          second: { enabled: true, token: "telegram-main", agent: "nox" },
        },
      },
    },
    secondAgent: "nox",
  };
  const stranger = (overrides: Parameters<typeof envelope>[0] = {}) =>
    envelope({ id: "m-stranger", senderId: "5550009999", senderName: "A Stranger", chatType: "group", chatId: "-100200", text: "hidup?", ...overrides });
  /** Who is waiting for approval, as `<connection>:<sender>`. */
  const pending = (h: Harness) =>
    h.db
      .prepare<{ gateway_id: string; sender_id: string }>("SELECT gateway_id, sender_id FROM sender_access WHERE status = 'pending' ORDER BY gateway_id, sender_id")
      .all()
      .map((row) => `${row.gateway_id}:${row.sender_id}`);

  test("a stranger in a room is paired by the bot they tagged, and only by that one", async () => {
    const h = await harness({ turns: [{ text: "should not happen" }], ...twoBotsPairing });
    h.gateway.receive(stranger({ gatewayId: h.gateway.id, mentionsSelf: true }));
    h.second.receive(stranger({ gatewayId: h.second.id, mentions: ["nouva_bot"] }));
    await h.pipeline.idle();

    expect(pending(h)).toEqual(["telegram:main:5550009999"]);
    // Said where they asked, once, quoted under their message — a room used to hear nothing at all.
    expect(h.notices.chat).toHaveLength(1);
    expect(h.notices.chat[0]?.text).toMatch(/[A-Z0-9]{3}-[A-Z0-9]{3}/);
    expect(h.notices.chat[0]?.replyTo).toBe("m-stranger");
    expect(h.notices.alerts).toHaveLength(1);
    expect(h.notices.alerts[0]).toContain("wants to talk to telegram:main");
    expect(h.requests).toHaveLength(0);
  });

  test("nobody tagged, nobody pairs — a room's chatter is not a request", async () => {
    // On Discord every bot is handed every channel message, whether or not it named an agent.
    const h = await harness({ turns: [{ text: "should not happen" }], ...twoBotsPairing });
    h.gateway.receive(stranger({ gatewayId: h.gateway.id, text: "@Nero | Infra Agent hidup?" }));
    h.second.receive(stranger({ gatewayId: h.second.id, text: "@Nero | Infra Agent hidup?" }));
    await h.pipeline.idle();

    expect(pending(h)).toEqual([]);
    expect(h.notices.chat).toEqual([]);
    expect(h.notices.alerts).toEqual([]);
  });

  test("naming the agent, or replying to what it said, is tagging it", async () => {
    const h = await harness({ turns: [{ text: "should not happen" }], ...twoBotsPairing });
    // A name in front is how a person addresses an agent in text, and how WhatsApp reports a tagged bot.
    h.gateway.receive(stranger({ gatewayId: h.gateway.id, id: "m1", text: "nouva: hidup?" }));
    h.second.receive(stranger({ gatewayId: h.second.id, id: "m1", text: "nouva: hidup?" }));
    // A reply to something Nox said is for Nox's bot, wherever else it is delivered.
    (h.pipeline as unknown as { voice: { outbound: { record(entry: { platform: string; chatId: string; messageId: string; agentId: string }): void } } }).voice.outbound.record({
      platform: "telegram",
      chatId: "-100200",
      messageId: "nox-said",
      agentId: "nox",
    });
    h.gateway.receive(stranger({ gatewayId: h.gateway.id, id: "m2", senderId: "777", replyTo: "nox-said", text: "ini apa?" }));
    h.second.receive(stranger({ gatewayId: h.second.id, id: "m2", senderId: "777", replyTo: "nox-said", text: "ini apa?" }));
    await h.pipeline.idle();

    expect(pending(h)).toEqual(["telegram:main:5550009999", "telegram:second:777"]);
    expect(h.notices.chat.map((notice) => notice.replyTo)).toEqual(["m1", "m2"]);
  });

  test("an unknown human in a DM still gets the code", async () => {
    // Where pairing works as designed: one connection, one reply, a person who can act on it.
    const h = await harness({ turns: [{ text: "should not happen" }], ...pairing });

    h.gateway.receive(
      envelope({ senderId: "999", senderName: "A Stranger", chatType: "dm", text: "hello?" }),
    );
    await h.pipeline.idle();

    expect(h.notices.chat).toHaveLength(1);
    expect(h.notices.chat[0]?.text).toMatch(/[A-Z0-9]{3}-[A-Z0-9]{3}/);
    // A one-to-one chat quotes nothing: the code is the whole conversation.
    expect(h.notices.chat[0]?.replyTo).toBeUndefined();
    expect(h.notices.alerts).toHaveLength(1);
    expect(h.requests).toHaveLength(0);
  });

  test("an agent that says Off drops a stranger on its own connections, though the default pairs", async () => {
    // `[agent] access` on the connection's owner wins over `[security.access] mode`.
    const h = await harness({ turns: [{ text: "should not happen" }], ...pairing, agentConfigToml: '[agent]\naccess = "allowlist"\n\n[llm]\nprovider = "test"\n' });
    h.gateway.receive(envelope({ senderId: "999", senderName: "A Stranger", chatType: "dm", text: "hello?" }));
    await h.pipeline.idle();
    expect(h.notices.chat).toEqual([]);
    expect(h.notices.alerts).toEqual([]);
    expect(h.requests).toHaveLength(0);
  });

  test("an agent that says On pairs a stranger though the default is locked; one that follows does not", async () => {
    const locked = { configOverrides: { ...PROVIDER_TOML, security: { access: { mode: "allowlist" } } } };
    const on = await harness({ turns: [{ text: "should not happen" }], ...locked, agentConfigToml: '[agent]\naccess = "pair"\n\n[llm]\nprovider = "test"\n' });
    on.gateway.receive(envelope({ senderId: "999", senderName: "A Stranger", chatType: "dm", text: "hello?" }));
    await on.pipeline.idle();
    expect(on.notices.chat[0]?.text).toMatch(/[A-Z0-9]{3}-[A-Z0-9]{3}/);

    const follows = await harness({ turns: [{ text: "should not happen" }], ...locked, agentConfigToml: '[agent]\naccess = "follow"\n\n[llm]\nprovider = "test"\n' });
    follows.gateway.receive(envelope({ senderId: "999", senderName: "A Stranger", chatType: "dm", text: "hello?" }));
    await follows.pipeline.idle();
    expect(follows.notices.chat).toEqual([]);
  });

  test("an allowlisted sender is untouched by any of this", async () => {
    const h = await harness({
      turns: [{ text: "hello Gading" }],
      configOverrides: {
        ...PROVIDER_TOML,
        security: { access: { mode: "pair", allowlist: ["telegram:main:214700000000000001"] } },
      },
    });

    h.gateway.receive(
      envelope({ senderId: "214700000000000001", chatType: "channel", text: "nouva: hidup?" }),
    );
    await h.pipeline.idle();

    expect(h.notices.chat).toEqual([]);
    expect(h.gateway.lastText()).toBe("hello Gading");
  });
});

describe("a plain text turn", () => {
  test("routes, answers, and replies through the gateway", async () => {
    const h = await harness({ turns: [{ text: "Jakarta." }] });

    h.gateway.receive(envelope({ text: "What is the capital of Indonesia?" }));
    await h.pipeline.idle();

    expect(h.gateway.sent).toHaveLength(1);
    expect(h.gateway.lastText()).toBe("Jakarta.");
    expect(h.gateway.sent[0]?.gatewayId).toBe("telegram:main");
  });

  test("sends the assembled system prompt, with the persona in it", async () => {
    const h = await harness({ turns: [{ text: "ok" }] });

    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();

    const system = h.requests[0]?.messages?.[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("Be brief.");
    // Sections are fenced so a persona file cannot impersonate one the engine controls.
    expect(system.content).toContain("<<<NOURIDE:IDENTITY>>>");
    expect(system.content).toContain("<<<NOURIDE:RUNTIME>>>");
  });

  test("persists the conversation, and carries it into the next turn", async () => {
    const h = await harness({ turns: [{ text: "first" }, { text: "second" }] });

    h.gateway.receive(envelope({ id: "m1", text: "one" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", text: "two" }));
    await h.pipeline.idle();

    const session = h.sessions.load({
      agentId: "nouva",
      chatId: "chat-1",
      gatewayId: "telegram:main",
    });
    // What was written, once the turn's clock note is taken off — it is stored with the message now,
    // because that is how the message was sent (`llm/executor/reminders.ts`).
    expect(session.messages.map((m) => messageText(withoutReminders(m).content))).toEqual(["one", "first", "two", "second"]);
    expect(messageText(session.messages[0]!.content)).toMatch(/^one\n\n\(Sent [^)]+\)$/);

    // The second request carries the first exchange — this is what makes it a conversation — and
    // carries it exactly as the first request sent it, which is what lets a prefix cache reuse it.
    const conversation = (request: { messages?: { role: string; content: unknown }[] } | undefined) =>
      request?.messages?.filter((m) => m.role !== "system").map((m) => m.content);
    const first = conversation(h.requests[0]);
    const second = conversation(h.requests[1]);
    expect(second?.slice(0, 2)).toEqual([first?.at(-1), "first"]);
  });

  test("shows a typing indicator before answering", async () => {
    const h = await harness({ turns: [{ text: "ok" }] });
    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();
    expect(h.gateway.typing).toContain("chat-1");
  });

  test("quotes the trigger in a group chat but not in a DM", async () => {
    const h = await harness({ turns: [{ text: "a" }, { text: "b" }] });

    h.gateway.receive(envelope({ id: "dm1", chatType: "dm", text: "hi" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "grp1", chatId: "group-9", chatType: "group", text: "nouva: hi" }));
    await h.pipeline.idle();

    expect(h.gateway.sent[0]?.replyTo).toBeUndefined();
    expect(h.gateway.sent[1]?.replyTo).toBe("grp1");
  });
});

describe("tool calls", () => {
  test("runs a tool and feeds the result back for a final answer", async () => {
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "memory_read", args: {} }] },
        { text: "Your memory is empty." },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["memory_read"]\n',
    });

    h.gateway.receive(envelope({ text: "what do you remember?" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toBe("Your memory is empty.");
    // Second request must contain the tool result, keyed to the call it answers.
    const toolMessage = h.requests[1]?.messages?.find((m: any) => m.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("c1");
    expect(toolMessage?.content).toContain("memory is empty");
  });

  test("writes memory to the agent's own directory", async () => {
    const h = await harness({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "memory_write", args: { mode: "append", content: "Gading prefers Bun." } },
          ],
        },
        { text: "Noted." },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["memory_write"]\n',
    });

    h.gateway.receive(envelope({ text: "remember that I prefer Bun" }));
    await h.pipeline.idle();

    const memory = await readTextFileIfExists(join(h.agentsDir, "nouva", "MEMORY.md"));
    expect(memory).toContain("Gading prefers Bun.");
  });

  test("denies an approval-gated tool with an actionable message", async () => {
    // No gate wired in this harness, and denying is the safe default — but the model has to be
    // told why, or it just tries again.
    const h = await harness({
      turns: [
        // Deliberately not `ls`: that is on the default allowlist and would run without asking,
        // which is correct behaviour and would make this test assert nothing.
        { toolCalls: [{ id: "c1", name: "exec", args: { command: ["bun", "test"] } }] },
        { text: "I can't run commands yet." },
      ],
      agentConfigToml:
        '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["exec"]\napproval_required = ["exec"]\n',
    });

    h.gateway.receive(envelope({ text: "list the files" }));
    await h.pipeline.idle();

    const toolResult = h.requests[1]?.messages?.find((m: any) => m.role === "tool");
    expect(toolResult?.content).toContain("needs approval");
    // The policy's own reason is carried through, so the model learns which rule stopped it.
    expect(toolResult?.content).toMatch(/Reason given/);
  });

  test("runs an approval-gated tool when a gate approves", async () => {
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "exec", args: { command: ["echo", "hi"] } }] },
        { text: "It printed hi." },
      ],
      agentConfigToml:
        '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["exec"]\napproval_required = ["exec"]\n',
      autoApprove: true,
    });

    h.gateway.receive(envelope({ text: "run echo hi" }));
    await h.pipeline.idle();

    const toolResult = h.requests[1]?.messages?.find((m: any) => m.role === "tool");
    expect(toolResult?.content).toContain("hi");
  });

  test("tells the model which tools exist when it invents one", async () => {
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "search_the_internet", args: {} }] },
        { text: "I don't have that." },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["memory_read"]\n',
    });

    h.gateway.receive(envelope({ text: "search for something" }));
    await h.pipeline.idle();

    const toolResult = h.requests[1]?.messages?.find((m: any) => m.role === "tool");
    expect(toolResult?.content).toContain('Unknown tool "search_the_internet"');
    expect(toolResult?.content).toContain("memory_read");
  });

  test("stops at the iteration cap and still answers", async () => {
    // A model that keeps asking for tools must not leave the user with silence.
    const h = await harness({
      // A different read each round: the same one answered the same ends the turn on its own (`SameAnswers`).
      turns: Array.from({ length: 30 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: "memory_read", args: { query: `q${i}` } }] })),
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["memory_read"]\n',
      configOverrides: {
        ...PROVIDER_TOML,
        llm: { defaults: { provider: "test", model: "test-model" }, limits: { max_tool_iterations: 2 } },
      },
    });

    h.gateway.receive(envelope({ text: "loop forever" }));
    await h.pipeline.idle();

    expect(h.gateway.sent).toHaveLength(1);
    // The wrap-up keeps the tools and may not call them — what makes it terminate, and what keeps the turn's cached prefix.
    const lastRequest = h.requests.at(-1);
    expect(lastRequest.tool_choice).toBe("none");
    expect(lastRequest.tools?.length).toBeGreaterThan(0);
    expect(String(conversationOf(lastRequest.messages).at(-1)?.content)).toContain("Tool call limit reached");
  });
});

describe("hooks", () => {
  test("/status answers without calling the model", async () => {
    const h = await harness({ turns: [{ text: "should not be used" }] });

    h.gateway.receive(envelope({ text: "/status" }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(0);
    expect(h.gateway.lastText()).toContain("Nouva");
    expect(h.gateway.lastText()).toContain("test-model");
  });

  test("/status is six lines, not a tool and skill inventory", async () => {
    /**
     * It printed every enabled tool and every skill — twenty-three names and thirty names on a real
     * agent, wrapping over fifteen lines on a phone. They are identical on every call and they are
     * what `nouride agents` and the Skills page are for. A status readout nobody scrolls to the end
     * of has stopped being one.
     */
    const h = await harness({ turns: [{ text: "unused" }] });

    h.gateway.receive(envelope({ text: "/status" }));
    await h.pipeline.idle();
    const text = h.gateway.lastText();

    for (const field of ["State:", "Model:", "Provider:", "Messages:", "Daemon uptime:"]) {
      expect(text).toContain(field);
    }
    expect(text).not.toContain("Tools:");
    expect(text).not.toContain("Skills:");
  });

  test("/status names the edition beside the version, or says it is a checkout", async () => {
    /**
     * Two boxes on the same version differ in whether WhatsApp is compiled in and whether they can
     * update themselves at all, so the version alone does not say what is deployed. The suite runs
     * from source, which is not an edition — so this asserts the honest half, and `editionLabel`
     * covers the four names.
     */
    const h = await harness({ turns: [{ text: "unused" }] });

    h.gateway.receive(envelope({ text: "/status" }));
    await h.pipeline.idle();
    const text = h.gateway.lastText();

    expect(text).toContain("source checkout");
    // The build flag is never the word shown, on any path through that line.
    expect(text).not.toMatch(/\(v[\d.]+ (basic|router|pro|unknown)\)/);
  });

  test("/status does not put an estimate of the transcript where the billed number goes", async () => {
    /**
     * The line read "Messages in context: 11 (~490 tokens)" directly above "Tokens: 133.6k in". Both
     * are correct and they measure different things — the first is `estimateMessagesTokens` over the
     * transcript, the second is what the provider billed, and the difference is the system prompt,
     * which is most of every request. Side by side they read as a contradiction, and the conclusion
     * a person draws is that the accounting is broken.
     */
    const h = await harness({ turns: [{ text: "unused" }] });

    h.gateway.receive(envelope({ text: "/status" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).not.toMatch(/Messages.*~\d+ tokens/);
  });

  test("/compact summarizes the conversation and keeps the recent turns", async () => {
    // Four scripted turns: three exchanges, then the summary call `/compact` makes. The summary is
    // just another provider response, which is why the scripted transport can stand in for it.
    const h = await harness({
      turns: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "SUMMARY OF EARLIER" }],
      configOverrides: {
        ...PROVIDER_TOML,
        llm: { ...PROVIDER_TOML.llm, context: { preserve_recent_turns: 1 } },
      },
    });

    // Long enough that the summary is smaller than what it replaces: one that is not is not kept (`summarize.ts`).
    for (const [i, text] of ["first", "second", "third"].entries()) {
      h.gateway.receive(envelope({ id: `m${i}`, text: `${text} ${"the details of the question, at length. ".repeat(20)}` }));
      await h.pipeline.idle();
    }

    h.gateway.receive(envelope({ id: "mc", text: "/compact" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toContain("Compacted");

    const session = h.sessions.load({
      agentId: "nouva",
      chatId: "chat-1",
      gatewayId: "telegram:main",
    });
    // The summary replaced the older turns and was *persisted*, so the next turn starts from the
    // compacted history rather than re-summarizing the same messages.
    expect(session.messages[0]?.content).toContain("SUMMARY OF EARLIER");
    expect(JSON.stringify(session.messages)).not.toContain("first");
    // ...and the most recent exchange survived verbatim.
    expect(JSON.stringify(session.messages)).toContain("third");
  });

  test("/compact on a short conversation says so instead of spending a call", async () => {
    const h = await harness({ turns: [{ text: "hi there" }] });

    h.gateway.receive(envelope({ id: "m1", text: "hello" }));
    await h.pipeline.idle();
    const before = h.requests.length;

    h.gateway.receive(envelope({ id: "m2", text: "/compact" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toContain("Nothing to compact");
    // No provider call: every turn here is one the config says to keep verbatim.
    expect(h.requests).toHaveLength(before);
  });

  test("/compact whose summary would outgrow the chat keeps it word for word, and says so", async () => {
    // Two one-line exchanges and a summary longer than both: replacing them would make every later turn bigger.
    const h = await harness({ turns: [{ text: "one" }, { text: "two" }, { text: `SUMMARY ${"at length, ".repeat(60)}` }] });
    for (const [i, text] of ["first", "second"].entries()) {
      h.gateway.receive(envelope({ id: `m${i}`, text }));
      await h.pipeline.idle();
    }
    const key = { agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" };
    const before = JSON.stringify(h.sessions.load(key).messages);

    h.gateway.receive(envelope({ id: "mc", text: "/compact" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toContain("Nothing to compact: the conversation is short enough to keep verbatim.");
    expect(JSON.stringify(h.sessions.load(key).messages)).toBe(before);
  });

  test("/compact on an empty conversation is not an error", async () => {
    const h = await harness({ turns: [{ text: "unused" }] });

    h.gateway.receive(envelope({ text: "/compact" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toContain("empty");
    expect(h.requests).toHaveLength(0);
  });

  test("/new clears the conversation", async () => {
    const h = await harness({ turns: [{ text: "hi there" }] });

    h.gateway.receive(envelope({ id: "m1", text: "hello" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", text: "/new" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toContain("New conversation started");
    const session = h.sessions.load({
      agentId: "nouva",
      chatId: "chat-1",
      gatewayId: "telegram:main",
    });
    expect(session.messages).toEqual([]);
  });

  test("/new cuts the conversation into memory before clearing it", async () => {
    const h = await harness({ memory: true, turns: [{ text: "hi there" }] });

    h.gateway.receive(envelope({ id: "m1", text: "hello" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", text: "/new" }));
    await h.pipeline.idle();

    // The reply says so, which is the only signal the person typing it gets.
    expect(h.gateway.lastText()).toContain("Saved to memory");
    const [episode, ...more] = h.memory!.episodes({}, 10);
    expect(more).toEqual([]);
    expect(episode).toMatchObject({ status: "raw", kind: "dm", chat: "telegram:main:chat-1", agents: ["nouva"] });
    const file = await h.memory!.episode(episode!.id);
    expect(file?.episode.transcript).toContain("hello");
    expect(file?.episode.transcript).toContain("hi there");
    // The command itself is not part of the conversation.
    expect(file?.episode.transcript).not.toContain("/new");

    // And the history really is gone — the cut is on the way out, not instead of the clear.
    expect(h.sessions.load({ agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" }).messages).toEqual([]);

    // Cut once: the next pass has nothing new from this chat, and the /new reply is not an episode.
    await h.memory!.cutAll();
    expect(h.memory!.episodes({}, 10)).toHaveLength(1);
  });

  test("/reset cuts too", async () => {
    const h = await harness({ memory: true, turns: [{ text: "hi there" }] });

    h.gateway.receive(envelope({ id: "m1", text: "hello" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", text: "/reset" }));
    await h.pipeline.idle();

    expect(h.memory!.episodes({}, 10)).toHaveLength(1);
    expect(h.gateway.lastText()).toContain("Saved to memory");
  });

  test("/new says nothing about memory where memory is not wired", async () => {
    const h = await harness({ turns: [{ text: "hi there" }] });

    h.gateway.receive(envelope({ id: "m1", text: "hello" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", text: "/new" }));
    await h.pipeline.idle();

    // A note about a save that did not happen sends someone looking for it.
    expect(h.gateway.lastText()).toContain("New conversation started");
    expect(h.gateway.lastText()).not.toContain("memory");
  });

  test("a stale conversation's context is cleared before the next message runs, and memory still has it", async () => {
    const h = await harness({
      memory: true,
      turns: [{ text: "first answer" }, { text: "second answer" }],
      configOverrides: { rollover: { mode: "idle", idle_minutes: 60 } },
    });

    h.gateway.receive(envelope({ id: "m1", text: "yesterday's question" }));
    await h.pipeline.idle();

    const key = { agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" };
    // Backdate the conversation past the idle window, the way one left alone overnight looks.
    h.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - 120 * 60_000, h.sessions.load(key).id);

    h.gateway.receive(envelope({ id: "m2", text: "a new morning" }));
    await h.pipeline.idle();

    // The rollover happened before the turn: the fresh context starts from the new message.
    const texts = h.sessions.load(key).messages.map((m) => String(m.content));
    expect(texts.some((t) => t.includes("a new morning"))).toBe(true);
    expect(texts.some((t) => t.includes("yesterday's question"))).toBe(false);

    // Memory is cut from the turn log, which a rollover does not touch: both are in tonight's episode.
    await h.memory!.cutAll();
    const [episode] = h.memory!.episodes({}, 10);
    const transcript = (await h.memory!.episode(episode!.id))?.episode.transcript ?? "";
    expect(transcript).toContain("yesterday's question");
    expect(transcript).toContain("a new morning");
  });

  test("a fresh conversation is not rolled over", async () => {
    const h = await harness({
      turns: [{ text: "one" }, { text: "two" }],
      configOverrides: { rollover: { mode: "idle", idle_minutes: 60 } },
    });

    h.gateway.receive(envelope({ id: "m1", text: "first" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", text: "second" }));
    await h.pipeline.idle();

    const texts = h.sessions.load({ agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" }).messages.map((m) => String(m.content));
    expect(texts.some((t) => t.includes("first"))).toBe(true);
  });

  test("the memory tools are offered where memory is wired, and memory_recent is gone", async () => {
    const h = await harness({ memory: true, turns: [{ text: "ok" }] });

    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();

    const names = (h.requests[0]?.tools ?? []).map((t: any) => t.function?.name ?? t.name);
    expect(names).toEqual(expect.arrayContaining(["memory_read", "memory_write", "memory_search", "memory_analyze"]));
    expect(names).not.toContain("memory_recent");
  });

  test("/stop silences the agent until /start", async () => {
    const h = await harness({ turns: [{ text: "answer" }] });

    h.gateway.receive(envelope({ id: "m1", text: "/stop" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", text: "are you there?" }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(0);

    h.gateway.receive(envelope({ id: "m3", text: "/start" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m4", text: "now?" }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    expect(h.gateway.lastText()).toBe("answer");
  });

  test("/model overrides the model for this chat only", async () => {
    const h = await harness({ turns: [{ text: "ok" }] });

    h.gateway.receive(envelope({ id: "m1", text: "/model antigravity:claude-sonnet-4-6" }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", text: "hi" }));
    await h.pipeline.idle();

    expect(h.requests[0]?.model).toBe("antigravity:claude-sonnet-4-6");
  });

  test("slash commands work in a group, where the agent must be addressed first", async () => {
    // "nouva: /new" is how a command reaches an agent in a group; a parser that only accepts
    // text starting with "/" made every command unusable outside a DM.
    const h = await harness({ turns: [{ text: "should not be reached" }] });

    h.gateway.receive(envelope({ id: "g1", chatId: "group-9", chatType: "group", text: "nouva: /status" }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(0);
    expect(h.gateway.lastText()).toContain("test-model");
  });

  test("/prompt shows the assembled prompt in a DM and refuses in a group", async () => {
    const h = await harness({ turns: [{ text: "unused" }] });

    h.gateway.receive(envelope({ id: "m1", chatType: "dm", text: "/prompt" }));
    await h.pipeline.idle();
    expect(h.gateway.lastText()).toContain("<<<NOURIDE:HARNESS>>>");
    expect(h.requests).toHaveLength(0);

    // The prompt carries SOUL and MEMORY; dumping it into a group leaks it to everyone there.
    h.gateway.receive(envelope({ id: "m2", chatId: "group-3", chatType: "group", text: "nouva: /prompt" }));
    await h.pipeline.idle();
    expect(h.gateway.lastText()).toContain("direct message");
    expect(h.gateway.lastText()).not.toContain("<<<NOURIDE:");
  });

  test("/prompt says who the agent is talking to, like a turn would", async () => {
    /**
     * The fourth fact `render-prompt.ts` assembled separately and simply left out — so `/prompt`
     * showed *no* identity line at all: not a matched person, not a signed-in account, not even "you
     * do not know who is speaking". Which makes the diagnostic silently wrong about the one question
     * an operator opens it to answer, and it was found on a live box while trying to verify a
     * `[[people]]` entry that had been matching correctly the whole time.
     */
    const h = await harness({
      turns: [{ text: "unused" }],
      configOverrides: {
        ...PROVIDER_TOML,
        people: [{ ids: ["telegram:5550001111"], name: "Gading", notes: "Runs the homelab." }],
      },
    });

    h.gateway.receive(envelope({ chatType: "dm", senderId: "5550001111", text: "/prompt" }));
    await h.pipeline.idle();

    // Matched by a platform-qualified id against the connection `telegram:main`.
    expect(h.gateway.lastText()).toContain("You are talking to Gading.");
    expect(h.gateway.lastText()).toContain("Runs the homelab.");
  });

  test("/prompt says so when it does not know the sender", async () => {
    const h = await harness({
      turns: [{ text: "unused" }],
      configOverrides: {
        ...PROVIDER_TOML,
        people: [{ ids: ["telegram:5550001111"], name: "Gading" }],
      },
    });

    h.gateway.receive(envelope({ chatType: "dm", senderId: "stranger", text: "/prompt" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toContain("You do not know who is speaking");
  });

  test("/prompt shows the workspace a turn actually gets, not the pack directory", async () => {
    /**
     * It reported `agents/<id>/` as the working directory and never mentioned `workspace/shared` or
     * `workspace/private/<id>` at all — because `render-prompt.ts` assembled its own workspace facts
     * and got them wrong. Every real turn was correct; only the diagnostic lied, which is the worst
     * place for it: `/prompt` is what an operator opens to check whether the agent has been told
     * something, and it answered "no" about a capability the harness has always given.
     */
    const h = await harness({ turns: [{ text: "unused" }] });

    /**
     * Asserted against the *assembled* prompt rather than what `/prompt` prints.
     *
     * `/prompt` no longer shows the harness at all — it answers with the operator's own files and
     * replaces everything this repository wrote with a note. The drift this test was written for is
     * unaffected by that: `render-prompt.ts` still builds its harness facts by hand, separately
     * from `turn.ts`, and if they diverge every real turn stays correct while the diagnostic lies.
     * The display used to be the canary; this is now the only thing that would notice.
     */
    const built = await h.pipeline.renderPrompt("nouva", envelope({ id: "w1", chatType: "dm", text: "x" }));
    const full = typeof built === "string" ? built : built.text;

    expect(full).toContain("workspace/shared");
    expect(full).toContain("shared with the other agents");
    expect(full).toContain("workspace/private/nouva");
    expect(full).toContain("yours alone");
    // And the pack is still reachable — it is where MEMORY.md lives — just not the working directory.
    expect(full).toContain("nouva");

    // What the operator actually receives carries none of it.
    h.gateway.receive(envelope({ id: "w2", chatType: "dm", text: "/prompt" }));
    await h.pipeline.idle();
    expect(h.gateway.lastText()).not.toContain("yours alone");
  });

  test("/prompt shows the OTHER AGENTS block the turn would actually get", async () => {
    // Found on a live box while chasing a different bug: `render-prompt.ts` assembled the harness
    // facts separately from `turn.ts` and simply left this one out, so the diagnostic showed no
    // OTHER AGENTS section whatever the chat was — which is the section you open `/prompt` to check
    // when an agent is not handing work over. Sharing `buildSystemPrompt` does not prevent that; the
    // facts are the half that can drift.
    const h = await harness({ turns: [{ text: "unused" }], secondAgent: "nox" });

    /**
     * Against the *assembled* prompt, not what `/prompt` prints.
     *
     * `/prompt` answers with the operator's own files now and replaces the harness with a note, so
     * the display can no longer show this. The drift is unchanged by that — the facts are still
     * built by hand here and can still go missing — and this assertion is what is left to catch it.
     */
    const built = await h.pipeline.renderPrompt("nouva", envelope({ id: "p1", chatType: "dm", text: "x" }));
    const full = typeof built === "string" ? built : built.text;

    expect(full).toContain("OTHER AGENTS");
    // A DM, so it is the bus — and `ask_agent` is offered here, so the section may name it.
    expect(full).toContain("ask_agent");
    // And it describes the transport this chat actually has.
    expect(full).toContain("does nothing");
    // And what the peer is for, from its IDENTITY.md — built by the same `otherAgentsFor` a turn uses.
    expect(full).toContain("  - nox: Nox. Runs the builds and reports what broke");

    // None of which reaches the person who typed the command.
    h.gateway.receive(envelope({ id: "p2", chatType: "dm", text: "/prompt" }));
    await h.pipeline.idle();
    expect(h.gateway.lastText()).not.toContain("OTHER AGENTS");
  });

  test("an unknown slash command is not intercepted — it reaches the model like any message", async () => {
    const h = await harness({ turns: [{ text: "unused" }] });

    h.gateway.receive(envelope({ text: "/frobnicate" }));
    await h.pipeline.idle();

    // Falls through to the agent: only registered commands are intercepted, so a user talking
    // about "/etc/hosts" still gets an answer.
    expect(h.requests).toHaveLength(1);
  });
});

describe("backpressure and resilience", () => {
  test("processes messages in one chat sequentially", async () => {
    const h = await harness({ turns: [{ text: "one" }, { text: "two" }, { text: "three" }] });

    for (const id of ["m1", "m2", "m3"]) {
      h.gateway.receive(envelope({ id, text: `message ${id}` }));
    }
    await h.pipeline.idle();

    expect(h.gateway.sent.map((m) => m.text)).toEqual(["one", "two", "three"]);
  });

  test("rate limits a flooding sender without calling the model", async () => {
    const h = await harness({
      turns: [{ text: "ok" }],
      configOverrides: {
        ...PROVIDER_TOML,
        security: { rate_limit: { messages_per_minute: 2, cooldown_reply: "Too fast." } },
      },
    });

    for (let i = 0; i < 5; i++) {
      h.gateway.receive(envelope({ id: `m${i}`, text: `msg ${i}` }));
    }
    await h.pipeline.idle();

    expect(h.requests.length).toBeLessThanOrEqual(2);
    expect(h.gateway.sent.some((m) => m.text === "Too fast.")).toBe(true);
  });

  test("does not rate limit — or answer — messages no agent was going to take", async () => {
    // The bug this pins: counting unaddressed group chatter burned the sender's budget, so
    // their actual question was refused, and the daemon announced "Too fast." in a channel it
    // was never addressed in.
    const h = await harness({
      turns: [{ text: "answered" }],
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: { telegram: { main: { enabled: false, token: "telegram-main" } } },
        security: { rate_limit: { messages_per_minute: 2, cooldown_reply: "Too fast." } },
      },
    });

    // Five unaddressed messages in a group: no owner, no binding, so nothing is for us.
    for (let i = 0; i < 5; i++) {
      h.gateway.receive(envelope({ id: `g${i}`, chatId: "group-1", chatType: "group", text: `chat ${i}` }));
    }
    await h.pipeline.idle();

    expect(h.gateway.sent).toHaveLength(0);

    // The same sender's actual question still goes through.
    h.gateway.receive(
      envelope({ id: "q1", chatId: "group-1", chatType: "group", text: "nouva: are you there?" }),
    );
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toBe("answered");
  });

  test("honours a per-agent sender allowlist", async () => {
    // Parsed and documented since the first commit, enforced nowhere — a security setting that
    // silently did nothing.
    const h = await harness({
      turns: [{ text: "should not be reached" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[security]\nsender_allowlist = ["boss"]\n',
    });

    h.gateway.receive(envelope({ id: "m1", senderId: "stranger", text: "hi" }));
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(0);
    expect(h.gateway.sent).toHaveLength(0);

    h.gateway.receive(envelope({ id: "m2", senderId: "boss", text: "hi" }));
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(1);
  });

  test("a per-agent allowlist takes the gateway-qualified spelling too, and only for that gateway", async () => {
    // The daemon-wide list always took `<gateway>:<id>`; this one took only the bare id, so the
    // qualified entry refused the person it named.
    const gatewayId = envelope({}).gatewayId;
    const h = await harness({
      turns: [{ text: "ok" }],
      agentConfigToml: `[llm]\nprovider = "test"\n\n[security]\nsender_allowlist = ["${gatewayId}:boss", "other:gw:stranger"]\n`,
    });

    h.gateway.receive(envelope({ id: "q1", senderId: "stranger", text: "hi" }));
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(0);

    h.gateway.receive(envelope({ id: "q2", senderId: "boss", text: "hi" }));
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(1);
  });

  test("strips the agent's own name from an addressed message", async () => {
    // Left in, the model sees its own name as the first token of every message and starts
    // echoing the pattern back.
    const h = await harness({ turns: [{ text: "ok" }] });

    h.gateway.receive(
      envelope({ chatId: "group-2", chatType: "group", text: "nouva: what is the time?" }),
    );
    await h.pipeline.idle();

    const userMessage = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content;
    // Followed by the time it was sent (`clockNote`), and nothing else.
    // In a group, said by who said it (`speakerName`).
    expect(userMessage).toMatch(/^Gading: what is the time\?\n\n\(Sent [^)]+\)$/);
  });

  test("caps stored history at max_conversation_turns", async () => {
    const h = await harness({
      turns: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }],
      configOverrides: { ...PROVIDER_TOML, security: { max_conversation_turns: 2 } },
    });

    for (const id of ["m1", "m2", "m3", "m4"]) {
      h.gateway.receive(envelope({ id, text: `turn ${id}` }));
      await h.pipeline.idle();
    }

    const session = h.sessions.load({
      agentId: "nouva",
      chatId: "chat-1",
      gatewayId: "telegram:main",
    });
    // Two turns kept, oldest dropped — without the cap this grows for the life of the chat.
    expect(session.messages.map((m) => messageText(withoutReminders(m).content))).toEqual(["turn m3", "c", "turn m4", "d"]);
  });

  test("a provider failure becomes a sanitized reply, not a crash", async () => {
    // Whoever speaks — the bench's open access: this is about the provider failing, not about who may talk.
    const failing = (async () =>
      new Response(JSON.stringify({ error: "upstream exploded" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const bench = await pipelineBench({ fetch: () => failing, config: PROVIDER_TOML, deps: { approvals: new UnavailableApprovalGate() } });
    cleanup.push(bench.dispose);
    const { pipeline, gateway, config } = bench;
    pipeline.setTools(createBuiltinTools({ security: config.security }));
    pipeline.attach();

    gateway.receive(envelope({ text: "hi" }));
    await pipeline.idle();

    // The user gets something human; the status code and body stay in the log (§17.2 item 5).
    // A 500 with no more specific wording classifies as `transient`, so the message now also says
    // trying again is worth it — which the old fixed string did not.
    expect(gateway.lastText()).toMatch(/not responding right now/);
    expect(gateway.lastText()).toMatch(/try again/i);
    expect(gateway.lastText()).not.toContain("500");
    expect(gateway.lastText()).not.toContain("upstream exploded");
  });
});

describe("cancellation and provider health", () => {
  test("/stop interrupts the turn in flight, not only the next one", async () => {
    // `cancelTurn` existed but nothing called it, so /stop merely refused *new* messages while the
    // running turn carried on — an agent stuck in a tool loop could not be stopped short of
    // restarting the daemon.
    //
    // Named by agent and chat alone, never by connection: a turn is keyed by the connection that
    // delivered its trigger and a command by the one that delivered the command, and in a channel of
    // several bots those differ — matching on it made `/stop` say "Paused" while the agent worked on.
    const h = await harness({ turns: [{ text: "answer" }] });

    // A turn that parks until aborted, standing in for a slow provider call.
    let released = false;
    const hanging = (async (_url: string, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          released = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    h.setFetch(hanging);

    h.gateway.receive(envelope({ id: "m1", text: "do something slow" }));
    // Let the turn start and register its controller.
    await sleep(50);

    expect(h.pipeline.cancelTurnFor("nouva", "chat-1")).toBe(true);
    await h.pipeline.idle();

    expect(released).toBe(true);
  });

  test("a stopped turn says nothing more, however far it had got", async () => {
    /**
     * `/stop` cancelled the work and not the answer. Whatever the model had produced up to that
     * point still went out, so the person got "Paused, and cancelled what I was doing" and then one
     * more message from the agent — the last word, after being asked to stop. Reported live.
     */
    const h = await harness({ turns: [{ text: "here is the thing I was in the middle of" }] });

    // Parked in the provider call, which is where a turn actually is when somebody stops it. The
    // abort makes that call throw, so the branch this guards is the error one.
    const hanging = (async (_url: string, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    h.setFetch(hanging);

    h.gateway.receive(envelope({ id: "m1", text: "do something slow" }));
    await sleep(50);
    const before = h.gateway.sent.length;

    h.gateway.receive(envelope({ id: "m2", text: "/stop" }));
    await h.pipeline.idle();

    // The hook's own confirmation, and nothing else.
    const after = h.gateway.sent.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.text).toContain("cancelled what I was doing");
  });

  test("a stopped turn stays silent even when the answer had already come back", async () => {
    /**
     * The other half of the same rule, and the one that is easy to leave untested: the stop can land
     * between the provider answering and the answer being posted. The work is finished, the text
     * exists, and it must still not be said — the person stopped it.
     *
     * Made deterministic by cancelling from inside the provider call, so the turn resumes with a
     * complete response and an already-aborted signal.
     */
    const h = await harness({
      turns: [
        {
          text: "the answer nobody wants any more",
          // A tool that takes a moment, so the stop lands *during* it — which is where a person
          // presses stop, and the state the screenshot showed: mid-`exec`.
          toolCalls: [{ id: "c1", name: "exec", args: { command: ["sleep", "1"] } }],
        },
        { text: "never reached" },
      ],
      // Without the opening line (`preamble.ts`): with it, words beside a tool call are said before the tool runs —
      // before any stop — and this is about the answer the turn ends holding.
      configOverrides: { ...PROVIDER_TOML, llm: { ...PROVIDER_TOML.llm, streaming: { progress_in_chat: false } } },
    });

    h.gateway.receive(envelope({ id: "m1", text: "do something" }));
    // Long enough for the provider to answer and the tool to run, and short enough to land before
    // the loop asks for a second round — which is where the abort is noticed and the turn ends
    // holding the text that came with the tool call.
    await sleep(120);
    h.pipeline.cancelTurnFor("nouva", "chat-1");
    await h.pipeline.idle();

    expect(h.gateway.sent.map((message) => message.text ?? "")).not.toContain(
      "the answer nobody wants any more",
    );
  });

  test("a stopped turn keeps the conversation, including the message it was answering", async () => {
    /**
     * Stop is an interrupt, not an erase. `sessions.save` lived on the success path and only there,
     * so a turn that threw left the conversation exactly as it found it — the question included. Stop
     * an agent mid-answer and `/start` resumed one that had never heard what you asked.
     *
     * The same held for a provider error and for a socket that dropped mid-reply: every failed turn
     * silently forgot its own question.
     */
    const h = await harness({ turns: [{ text: "answer" }] });

    const hanging = (async (_url: string, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    h.setFetch(hanging);

    h.gateway.receive(envelope({ id: "m1", text: "rewrite the docs, they are bad" }));
    await sleep(50);
    h.gateway.receive(envelope({ id: "m2", text: "/stop" }));
    await h.pipeline.idle();

    const stored = h.sessions.load({
      agentId: "nouva",
      gatewayId: "telegram:main",
      chatId: "chat-1",
    }).messages;

    expect(stored.map((message) => messageText(message.content)).join("\n")).toContain(
      "rewrite the docs, they are bad",
    );
    // And it closes on an assistant turn: a history ending on a user message makes the next turn
    // append a second one, and consecutive same-role turns are not a shape both providers accept.
    expect(stored.at(-1)?.role).toBe("assistant");
    expect(messageText(stored.at(-1)!.content)).toContain("stopped me here");
  });

  test("a stopped turn does not count against its provider", async () => {
    // Live, 2026-10-31: twelve stopped missions logged "turn failed … LLMError: request aborted" at error level and
    // counted twelve failures against Gemini, which was answering fine. The person stopped them.
    const providerErrors = new Map<string, number>();
    const h = await harness({ turns: [{ text: "answer" }], providerErrors });
    const hanging = (async (_url: string, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    h.setFetch(hanging);

    h.gateway.receive(envelope({ id: "m1", text: "do something slow" }));
    // Stopped as soon as it is running: `cancelTurnFor` is true once the turn has registered.
    await eventually(() => h.pipeline.cancelTurnFor("nouva", "chat-1"), 4_000, "the turn to be running");
    await h.pipeline.idle();

    expect(providerErrors.get("test") ?? 0).toBe(0);
  });

  test("cancelling a chat with nothing running reports false", async () => {
    const h = await harness({ turns: [{ text: "ok" }] });
    expect(h.pipeline.cancelTurnFor("nouva", "chat-1")).toBe(false);
  });

  test("counts provider failures but not configuration failures", async () => {
    // Counting every failure made a bad agent config report the *provider* as down. Health that
    // blames a healthy component sends you to the wrong place first.
    const providerErrors = new Map<string, number>();
    const h = await harness({
      turns: [{ text: "unused" }],
      providerErrors,
      failWith: { status: 500, body: { error: "upstream exploded" } },
    });

    h.gateway.receive(envelope({ id: "m1", text: "hi" }));
    await h.pipeline.idle();
    expect(providerErrors.get("test")).toBe(1);

    // A successful turn resets the counter — health is about *consecutive* failures.
    h.setFetch(h.scripted);
    h.gateway.receive(envelope({ id: "m2", text: "hi again" }));
    await h.pipeline.idle();
    expect(providerErrors.get("test")).toBe(0);
  });
});

describe("routing", () => {
  test("a gateway owner gets everything on that connection", async () => {
    const h = await harness({ turns: [{ text: "mine" }] });
    h.gateway.receive(envelope({ chatType: "group", chatId: "group-1", text: "anyone there?" }));
    await h.pipeline.idle();
    expect(h.gateway.lastText()).toBe("mine");
  });

  test("says nothing when no agent matches", async () => {
    const h = await harness({
      turns: [{ text: "unused" }],
      // No owner on the instance, no bindings, group chat: nobody was addressed.
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: { telegram: { main: { enabled: false, token: "telegram-main" } } },
      },
    });

    h.gateway.receive(envelope({ chatType: "group", chatId: "group-1", text: "hello?" }));
    await h.pipeline.idle();

    expect(h.gateway.sent).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
  });

  test("groupsRequireMention ignores unaddressed group chatter but answers DMs", async () => {
    const h = await harness({
      turns: [{ text: "answering dm" }],
      configOverrides: {
        ...PROVIDER_TOML,
        agents: { groups_require_mention: true },
      },
    });

    // Unaddressed group message -> ignored
    h.gateway.receive(envelope({ chatType: "group", chatId: "group-1", text: "hello everyone" }));
    await h.pipeline.idle();
    expect(h.gateway.sent).toHaveLength(0);
    expect(h.requests).toHaveLength(0);

    // DM message -> answered as normal
    h.gateway.receive(envelope({ chatType: "dm", chatId: "dm-1", text: "hello bot" }));
    await h.pipeline.idle();
    expect(h.gateway.lastText()).toBe("answering dm");
  });

  test("groupsRequireMention still answers in group when tagged or prefixed", async () => {
    const h = await harness({
      turns: [{ text: "answering tagged group" }],
      configOverrides: {
        ...PROVIDER_TOML,
        agents: { groups_require_mention: true },
      },
    });

    h.gateway.receive(envelope({ chatType: "group", chatId: "group-1", text: "nouva: hello" }));
    await h.pipeline.idle();
    expect(h.gateway.lastText()).toBe("answering tagged group");
  });

  test("@agent in a DM reaches nobody — the mention is not a handover here", async () => {
    // The bug these two tests used to pin the wrong way round. A DM is one person and one bot: the
    // engine used to re-inject Nouva's reply so the mentioned agent could answer, and what the person
    // got was a second agent inside a conversation they had opened with the first — its answer, its
    // progress lines and its tool output, arriving under a name they were not talking to. Twice over
    // when both agents were reachable.
    //
    // Now a mention in a DM is what it looks like: text. The handover goes over `ask_agent`, which is
    // what the prompt tells the agent to use here — see `busConventionLines`.
    const h = await harness({
      turns: [
        { text: "@nox tolong review security di repo utama" },
        // Never reached. Present so a second turn would have something to answer with, which is what
        // makes the assertion below mean "nobody ran" rather than "the script ran out".
        { text: "sudah saya review, aman" },
      ],
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            // Only Nouva has a Telegram bot — nox has none, which is the arrangement the internal
            // handover existed for.
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
    });

    h.gateway.receive(envelope({ chatType: "dm", text: "review security repo utama" }));
    await h.pipeline.idle();

    // One turn, one message. Nouva said something with an @ in it and that is all that happened.
    expect(h.requests).toHaveLength(1);
    expect(h.gateway.sent).toHaveLength(1);
    expect(h.gateway.sent[0]!.text).toContain("@nox");
  });

  test("@agent in a DM does not reach an agent that has its own bot either", async () => {
    // The same rule, and the case that was worst live: Nox's bot has a *separate* DM with the same
    // person, so the handover moved the answer into a conversation nobody was looking at while the one
    // they were watching stayed silent.
    const h = await harness({
      turns: [{ text: "@nox tolong review security" }, { text: "done reviewing" }],
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-second", agent: "nox" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
    });

    h.gateway.receive(envelope({ chatType: "dm", text: "review security" }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    expect(h.gateway.sent).toHaveLength(1);
    // Nothing on Nox's connection: no turn ran, so there is nothing for it to have said.
    expect(h.second.sent).toHaveLength(0);
  });

  test("in a DM the handover runs behind the chat and only one agent speaks", async () => {
    // The shape the operator asked for, end to end: the person tells Nouva to do something, Nouva
    // needs Nox, Nox runs behind the chat, and Nouva reports back. Nox is visible only as progress —
    // it never says anything into a conversation the person opened with somebody else.
    const h = await harness({
      turns: [
        // 1. Nouva hands the work over — as a tool call, not as a mention.
        { toolCalls: [{ id: "c1", name: "ask_agent", args: { agent: "nox", task: "benerin build" } }] },
        // 2. Nox's turn: it does something, which is what puts a progress line in the chat.
        {
          toolCalls: [
            { id: "c2", name: "plan", args: { steps: [{ state: "in_progress", text: "benerin build" }] } },
          ],
        },
        // 3. Nox's answer. It goes back to Nouva as the tool result, not into the chat.
        { text: "build gw benerin, PR #12" },
        // 4. Nouva, now holding it, tells the person.
        { text: "udah kelar Ding — nox benerin buildnya, PR #12" },
      ],
      progressIntervalMs: 1,
      // The real `plan`, slowed down. The progress line is written on a timer, and every provider
      // call in this harness resolves without yielding to one — so with an instant tool the turn is
      // over before the first tick and the bubble is never posted. A tool that actually takes a moment
      // is what the timer exists for, and it is the only way to observe the line from a test.
      extraTools: new Map<string, Tool>([
        [
          "plan",
          {
            requiresApproval: false,
            definition: {
              name: "plan",
              description: "tracks a plan",
              parameters: { type: "object", properties: {} },
            },
            async execute() {
              await sleep(20);
              return { content: "plan noted", isError: false };
            },
          },
        ],
      ]),
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-second", agent: "nox" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
    });

    h.gateway.receive(envelope({ chatType: "dm", text: "tolong benerin build" }));
    await h.pipeline.idle();
    // The progress line is written on a timer and the last edit lands after the answer — the same
    // wait every other progress test takes.
    await sleep(30);

    // Four provider calls: Nouva's, Nox's two, and Nouva's again with the answer in hand.
    expect(h.requests).toHaveLength(4);

    // The last thing the person sees is Nouva's, and it carries what Nox found.
    expect(h.gateway.lastText()).toBe("udah kelar Ding — nox benerin buildnya, PR #12");
    // Nox never speaks — not here, and not in the separate DM its own bot has with the same person.
    // That second one is the failure that is hardest to notice: the answer arrives in a conversation
    // nobody is looking at.
    expect(h.second.sent).toHaveLength(0);
    expect(h.gateway.sent.some((m) => m.text === "build gw benerin, PR #12")).toBe(false);

    // Visible as work, though. The progress line is posted on the connection the person is watching
    // and labelled with the agent actually doing it — a minute of silence otherwise reads as a
    // conversation that has died.
    // On the connection the person is watching, not on Nox's own — and it says only what a status
    // line says. The edit trail is where the running line lives; `sent` holds it after `finish`
    // rewrote it into a record of the work.
    const noxProgress = h.gateway.sent.filter((m) => m.text.startsWith("[nox]"));
    expect(noxProgress).toHaveLength(1);
    expect(noxProgress[0]!.text).toMatch(/^\[nox\] ✓ \d+ steps? · \d+s$/);
  });

  test("a tag of an agent whose bot cannot read the room is followed by a line saying so", async () => {
    // Live on Discord (0.8.12): told in its prompt that Nexa's bot cannot read the channel, Nouva tagged her anyway, from
    // an earlier message of its own, and nothing came back. The room is told why, and the agent reads it next turn.
    const h = await harness({
      turns: [{ text: "@NoxAgentBot tolong review security" }],
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-second", agent: "nox" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
    });
    h.second.selfMention = "@NoxAgentBot";
    h.second.sees = (chatId) => (chatId === "general" ? false : undefined);
    h.gateway.receive(envelope({ chatType: "channel", chatId: "general", text: "nouva: get nox to review it" }));
    await h.pipeline.idle();
    await eventually(() => h.gateway.sent.some((m) => m.text.startsWith("⚠")), 2_000, "the line about the unseen tag");
    expect(h.gateway.sent.map((m) => m.text)).toEqual([
      "@NoxAgentBot tolong review security",
      "⚠ nox cannot read this channel, so the tag above reaches nobody. Let its bot into this channel, or ask it elsewhere.",
    ]);
    expect(h.second.sent).toHaveLength(0);
  });

  test("@agent in a group skips handover when the mentioned agent has its own bot", async () => {
    // In a group both bots see every message — the platform delivers Nouva's reply to Nox's bot.
    // The engine should NOT internally hand over; that would cause a duplicate turn.
    const h = await harness({
      turns: [
        { text: "@nox tolong review security" },  // Nouva's reply mentions nox
        { text: "done reviewing" },                // Nox's reply (via platform delivery)
      ],
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-second", agent: "nox" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
    });

    h.gateway.receive(envelope({ chatType: "group", text: "nouva: review security" }));
    await h.pipeline.idle();

    // Only Nouva's turn ran — the engine did NOT internally hand over because Nox has its own
    // bot in the group.  The platform would deliver Nouva's reply to Nox's bot.
    expect(h.requests).toHaveLength(1);
    expect(h.gateway.sent).toHaveLength(1);
    expect(h.gateway.sent[0]!.text).toContain("@nox");
    // Nox's bot did NOT get an internal handover — nothing on the second gateway.
    expect(h.second.sent).toHaveLength(0);
  });

  test("on Telegram, where no bot sees another bot's message, the handover is carried by the engine", async () => {
    // Seen live: Nouva wrote `@RenNourideBot tolong cek cluster`, the person read it, and Nero never
    // did — Telegram does not deliver one bot's message to another, and the handle was not matched.
    const h = await harness({
      turns: [{ text: "@NoxAgentBot tolong review security" }, { text: "done reviewing" }],
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-second", agent: "nox" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
    });
    for (const gateway of [h.gateway, h.second]) gateway.echoesOwnMessages = false;
    h.gateway.selfMention = "@NouvaAgentBot";
    h.second.selfMention = "@NoxAgentBot";

    h.gateway.receive(envelope({ chatType: "group", text: "nouva: review security", idsPerConnection: true }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(2);
    expect(h.gateway.sent.map((m) => m.text)).toEqual(["@NoxAgentBot tolong review security"]);
    // Through Nox's own bot, and quoting nothing: the only id it could quote is another bot's.
    expect(h.second.sent.map((m) => [m.text, m.replyTo])).toEqual([["done reviewing", expect.stringMatching(/^msg/)]]);
  });

  test("a scheduled turn in a room only the room log knows hands its tag over — after a restart, before anyone spoke", async () => {
    // Live in the owner's group (0.8.12): the daemon had restarted and nobody had written there since, so Nouva's
    // scheduled turn was built as a one-to-one — the chat type was this process's memory, empty — and her
    // `@NexaNourideBot …` was posted and never handed over: a DM never is. The room log is on disk, and holds only rooms.
    const h = await harness({
      turns: [{ text: "@NoxAgentBot [TEST] tag check" }, { text: "tag received" }],
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-second", agent: "nox" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
    });
    for (const gateway of [h.gateway, h.second]) gateway.echoesOwnMessages = false;
    h.gateway.selfMention = "@NouvaAgentBot";
    h.second.selfMention = "@NoxAgentBot";
    new RoomMessageStore(h.db).record({ id: "said-before-restart", gatewayId: "telegram:main", chatId: "room-7", senderId: "555", senderName: "Gading", text: "earlier" });

    const target = { gatewayId: "telegram:main", chatId: "room-7" };
    const job = { id: "cron_tag", name: "TEST tag", agentId: "nouva", target, delivery: { mode: "announce", ...target }, allowed: [] };
    expect(h.pipeline.cronExecutors().dispatchTurn(job as never, "Post the tag")).toBe(true);
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(2);
    expect(h.gateway.sent.map((m) => m.text)).toEqual(["@NoxAgentBot [TEST] tag check"]);
    expect(h.second.sent.map((m) => m.text)).toEqual(["tag received"]);
  });

  test("an agent speaking through another's bot reaches that bot's agent by its handle, the tag whole", async () => {
    // Live in the sandbox (0.8.12): Alpha, with no bot of its own, wrote `@nouride_sandbox_e2e_bot go ahead` in a group
    // — the handle of the bot it spoke through, whose agent is Nou. "internal handover" was logged and the copy went to
    // nobody: it named no agent by id or name, it was not marked as the bot's own tag, and a room several agents share
    // hands an untagged message to none. Nou's handle starting with its name is 0.8.12's other fix, on the same path.
    const h = await harness({
      turns: [{ text: "@NoxAgentBot tolong review security" }, { text: "done reviewing" }],
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: { telegram: { main: { enabled: true, token: "telegram-main", agent: "nox" } } },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
    });
    h.gateway.echoesOwnMessages = false;
    h.gateway.selfMention = "@NoxAgentBot";

    h.gateway.receive(envelope({ chatType: "group", text: "nouva: review security", idsPerConnection: true }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(2);
    expect(h.gateway.sent.map((m) => m.text).filter((text) => !text.startsWith("["))).toEqual(["@NoxAgentBot tolong review security", "done reviewing"]);
    // Whole: "@NoxAgentBot" is the bot's handle, not "@Nox" with "AgentBot tolong…" after it.
    expect(JSON.stringify(h.requests[1])).toContain("@NoxAgentBot tolong review security");
    expect(JSON.stringify(h.requests[1])).not.toMatch(/"AgentBot tolong/);
  });
});

describe("the typing indicator spans the whole turn", () => {
  /** A tool that takes long enough for several keepalive ticks to land. */
  function slowTool(ms: number): Map<string, Tool> {
    return new Map<string, Tool>([
      [
        "slow",
        {
          requiresApproval: false,
          definition: {
            name: "slow",
            description: "takes a while",
            parameters: { type: "object", properties: {} },
          },
          async execute() {
            await sleep(ms);
            return { content: "done", isError: false };
          },
        },
      ],
    ]);
  }

  test("keeps refreshing while a tool is running", async () => {
    // The regression this pins: the keepalive used to be armed inside the provider call and
    // cleared on return, so the indicator died for the entire duration of every tool — which is
    // the part that actually takes time. A 30-second exec looked like a hung chat.
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "slow", args: {} }] },
        { text: "finished" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n',
      extraTools: slowTool(60),
      typingRefreshMs: 5,
    });

    h.gateway.receive(envelope({ text: "do the slow thing" }));
    await h.pipeline.idle();

    // Many, not one: a single tick would mean the indicator was shown once and left to expire.
    expect(h.gateway.typing.length).toBeGreaterThan(3);
  });

  test("stops once the turn is over", async () => {
    // A keepalive left running would keep a chat showing "typing" with nobody working on it.
    const h = await harness({
      turns: [{ text: "hi" }],
      typingRefreshMs: 5,
    });

    h.gateway.receive(envelope({ text: "hello" }));
    await h.pipeline.idle();

    const after = h.gateway.typing.length;
    await sleep(40);
    expect(h.gateway.typing.length).toBe(after);
  });
});

describe("inbound attachments reach the model as a stated limitation", () => {
  test("a caption plus an image tells the model an image arrived and it cannot read it", async () => {
    // The silent failure this pins: the caption went through alone, so the model answered
    // confidently about a screenshot it had never seen. Nothing in the reply showed it happened.
    const h = await harness({ turns: [{ text: "I can see a file but cannot open it." }] });

    h.gateway.receive(
      envelope({
        text: "what is wrong here",
        attachments: [
          { type: "image", mimeType: "image/png", filename: "error.png", size: 240_000 },
        ],
      }),
    );
    await h.pipeline.idle();

    // No AttachmentStore in this harness, so the honest outcome is "could not be retrieved" — the
    // point of the assertion is that the caption is not sent *alone*, which is what used to happen.
    const sent = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content as string;
    expect(sent).toContain("what is wrong here");
    expect(sent).toContain("error.png");
    expect(sent).toMatch(/could not be retrieved/);
  });

  test("an attachment-only message still produces a turn", async () => {
    // Adapters used to drop these outright (`if (!text.trim()) return null`), so the sender got no
    // reply and no error — indistinguishable from the bot ignoring them.
    const h = await harness({ turns: [{ text: "Got your photo, but I cannot open it yet." }] });

    h.gateway.receive(
      envelope({
        text: "",
        attachments: [{ type: "image", mimeType: "image/jpeg", size: 100_000 }],
      }),
    );
    await h.pipeline.idle();

    expect(h.gateway.sent).toHaveLength(1);
    const sent = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content as string;
    expect(sent).toMatch(/1 file\(s\) could not be retrieved/);
  });

  test("batches rapid inbound media events into a single turn with all attachments", async () => {
    const h = await harness({ turns: [{ text: "Analyzed all images together." }] });

    // Send 3 media messages in rapid succession (album burst)
    h.gateway.receive(
      envelope({
        id: "msg-1",
        text: "check these 3 screenshots",
        attachments: [{ type: "image", mimeType: "image/png", filename: "img1.png", size: 100_000 }],
      }),
    );
    h.gateway.receive(
      envelope({
        id: "msg-2",
        text: "",
        attachments: [{ type: "image", mimeType: "image/png", filename: "img2.png", size: 120_000 }],
      }),
    );
    h.gateway.receive(
      envelope({
        id: "msg-3",
        text: "",
        attachments: [{ type: "image", mimeType: "image/png", filename: "img3.png", size: 140_000 }],
      }),
    );

    await h.pipeline.idle();

    // Only ONE turn was triggered for all 3 images
    expect(h.requests).toHaveLength(1);
    const sent = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content as string;
    expect(sent).toContain("check these 3 screenshots");
    expect(sent).toContain("img1.png");
    expect(sent).toContain("img2.png");
    expect(sent).toContain("img3.png");
  });
});

/**
 * A turn is not allowed to end in silence, and it is not allowed to end in a guess either.
 *
 * The second half is the newer lesson. Every empty turn with a tool call in it used to be reported as
 * "most likely an approval timed out or was denied" — printed live to a Discord channel after
 * twenty-two tool calls that had all succeeded and no approval anywhere in the turn. It sent the
 * operator to `nouride approvals`, which was empty, which read as a second failure. So the closing
 * message now comes from what actually happened: the model gets one more chance to speak, and the
 * approval hint only appears when an approval was genuinely refused.
 */
describe("a turn that produces no text still says something", () => {
  /** A tool that always works, so a silent turn is the *only* thing under test. */
  function quietTool(): [string, Tool] {
    return [
      "peek",
      {
        requiresApproval: false,
        definition: {
          name: "peek",
          description: "looks at a thing",
          parameters: { type: "object", properties: {} },
        },
        async execute() {
          return { content: "three lines", isError: false };
        },
      },
    ];
  }

  test("a call whose arguments are not one JSON object is answered with what went wrong, and the tool never runs", async () => {
    let ran = 0;
    const h = await harness({
      // `"ls -la"` on the wire: JSON, but a string where an object belongs.
      turns: [{ toolCalls: [{ id: "c1", name: "peek", args: "ls -la" }] }, { text: "resent it" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["peek"]\n',
      extraTools: new Map<string, Tool>([["peek", { ...quietTool()[1], execute: async () => ((ran += 1), { content: "ran", isError: false }) }]]),
    });

    h.gateway.receive(envelope({ text: "peek at it" }));
    await h.pipeline.idle();

    expect(ran).toBe(0);
    expect(JSON.stringify(h.requests[1]?.messages ?? [])).toContain("The arguments for peek were a JSON string, not an object");
  });

  test("a model that goes quiet after doing work is asked again, and its own words win", async () => {
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "peek", args: {} }] },
        // The failure this rescues: a final message with no tool calls and no content. A reasoning
        // model that spends its whole response on thinking lands here.
        { text: "" },
        { text: "I looked — the file has three lines." },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["peek"]\n',
      extraTools: new Map<string, Tool>([quietTool()]),
    });

    h.gateway.receive(envelope({ text: "peek at it" }));
    await h.pipeline.idle();

    const reply = h.gateway.sent.find((msg) => msg.text?.includes("three lines"));
    expect(reply).toBeDefined();
    // The canned line is a last resort, not the first thing reached for.
    expect(h.gateway.sent.some((m) => /approval/i.test(m.text ?? ""))).toBe(false);
  });

  test("a turn with no approval in it never mentions approvals, even when the rescue also comes back empty", async () => {
    // The exact shape of the live misdiagnosis: real tool work, nothing to do with the approval gate,
    // and a model that will not produce text however often it is asked.
    const h = await harness({
      turns: [{ toolCalls: [{ id: "c1", name: "peek", args: {} }] }, { text: "" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["peek"]\n',
      extraTools: new Map<string, Tool>([quietTool()]),
    });

    h.gateway.receive(envelope({ text: "peek at it" }));
    await h.pipeline.idle();

    const reply = h.gateway.sent.at(-1);
    expect(reply?.text).toContain("could not put an answer together");
    expect(reply?.text).not.toMatch(/approval/i);
    expect(reply?.text).not.toContain("nouride approvals");
  });

  test("a denied tool call gets an actionable reply, not silence", async () => {
    // Found live: an approval expired, the model returned no text, and the sender got nothing at
    // all — indistinguishable from a crash. The old code logged a warning and stopped.
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "exec", args: { command: ["bun", "test"] } }] },
        { text: "" },
      ],
      agentConfigToml:
        '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["exec"]\napproval_required = ["exec"]\n',
    });

    h.gateway.receive(envelope({ text: "run the tests" }));
    await h.pipeline.idle();

    // Asserted on the reply rather than on the message count. A tool that needs approval now also
    // posts a progress bubble first — sealed before the prompt goes out, so the reader sees what the
    // turn had done before it stopped to ask. Counting messages made that indistinguishable from a
    // regression.
    //
    // Reaching this line now takes two empty replies from the model — the rescue above asks once more
    // before falling back. Which is the point: the hint below is what the daemon says when it has
    // nothing better, and here it is *true*, because the gate really did refuse the call.
    const reply = h.gateway.sent.find((msg) => /did not go through|approval/i.test(msg.text ?? ""));
    expect(reply).toBeDefined();
    expect(reply?.text).toContain("nouride approvals");
  });

  test("an empty answer with no tools gets a different, still useful reply", async () => {
    const h = await harness({ turns: [{ text: "   " }] });

    h.gateway.receive(envelope({ text: "hello" }));
    await h.pipeline.idle();

    expect(h.gateway.sent[0]?.text).toMatch(/did not manage to produce an answer/);
  });
});

describe("provider failures are classified, not lumped together", () => {
  /**
   * The measured gap: `retryable` was `429 || >= 500` and nothing else, so every other failure looked
   * identical. Observed live in this repo — a model id missing its provider prefix came back as
   * `model_prefix_required`, a permanent configuration error, and the chat said "The model is not
   * responding right now." The model was answering perfectly.
   */
  test("a config error says it is a config error, not an outage", async () => {
    const h = await harness({
      turns: [],
      failWith: {
        status: 400,
        body: {
          error: {
            message: 'Model must include provider prefix. Got: "claude-sonnet-4-5".',
            code: "model_prefix_required",
          },
        },
      },
    });

    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();

    const reply = h.gateway.lastText();
    expect(reply).toMatch(/misconfigured/i);
    expect(reply).not.toMatch(/not responding/);
    // And the provider's own wording stays out of the chat.
    expect(reply).not.toContain("claude-sonnet-4-5");
  });

  test("a bad credential is reported as one", async () => {
    const h = await harness({
      turns: [],
      failWith: { status: 401, body: { error: { message: "invalid_api_key" } } },
    });

    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();
    expect(h.gateway.lastText()).toMatch(/credentials are not working/i);
  });

  test("a content refusal is not presented as a fault", async () => {
    const h = await harness({
      turns: [],
      failWith: { status: 400, body: { error: { message: "content_policy violation" } } },
    });

    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();
    expect(h.gateway.lastText()).toMatch(/declined to answer/i);
  });

  // "a permanent failure is not retried" lives in packages/llm/tests/classify.test.ts: the retry loop
  // is `postJson`'s, and counting attempts there is direct rather than inferred from this harness —
  // whose failing transport is a separate fetch impl that records nothing.
});

/**
 * A dropped message used to be a `log.warn` and nothing else.
 *
 * From the sender's side it simply vanished: no reply, no error, indistinguishable from being ignored.
 * And it needed no load to hit — an approval parks the turn, the turn holds this chat's queue key, and
 * anything sent meanwhile ages past `queue_timeout_ms` on its way to the handler.
 */
describe("a dropped message is not silence", () => {
  /** Occupies the queue key long enough for the next message to age out behind it. */
  function slowTool(ms: number): Map<string, Tool> {
    return new Map<string, Tool>([
      [
        "slow",
        {
          requiresApproval: false,
          definition: {
            name: "slow",
            description: "takes a while",
            parameters: { type: "object", properties: {} },
          },
          async execute() {
            await sleep(ms);
            return { content: "done", isError: false };
          },
        },
      ],
    ]);
  }

  // Steering off: these are about the queue, and a one-to-one chat now reads a message sent mid-turn into
  // the running turn rather than queueing it (`steering.test.ts`). A room, or steering switched off, queues.
  const blocking = (queueOverrides: Record<string, unknown>) => ({
    turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "finished" }],
    agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n',
    extraTools: slowTool(80),
    configOverrides: { ...PROVIDER_TOML, queue: { steer: false, ...queueOverrides } },
  });

  test("a message that ages out behind a slow turn is told so", async () => {
    const h = await harness(blocking({ queue_timeout_ms: 1 }));

    h.gateway.receive(envelope({ id: "m1", text: "start the slow thing" }));
    await sleep(20);
    h.gateway.receive(envelope({ id: "m2", text: "are you there?" }));
    await h.pipeline.idle();
    await sleep(10);

    expect(h.gateway.sent.some((m) => m.text.includes("waited behind the one before it"))).toBe(true);
  });

  test("a burst of drops produces one notice, not one per message", async () => {
    // The apology must not become the flood. Twenty dropped messages is one thing to say.
    const h = await harness(blocking({ queue_timeout_ms: 1, max_queue_depth: 2 }));

    h.gateway.receive(envelope({ id: "m1", text: "start the slow thing" }));
    await sleep(20);
    for (let i = 2; i <= 8; i++) h.gateway.receive(envelope({ id: `m${i}`, text: `follow-up ${i}` }));
    await h.pipeline.idle();
    await sleep(10);

    const notices = h.gateway.sent.filter(
      (m) => m.text.includes("waited behind") || m.text.includes("faster than I can answer"),
    );
    expect(notices).toHaveLength(1);
  });

  test("a duplicate says nothing — it is the message the sender already sent", async () => {
    const h = await harness({ turns: [{ text: "hi" }] });

    const same = envelope({ id: "m1", text: "hello" });
    h.gateway.receive(same);
    h.gateway.receive(same);
    await h.pipeline.idle();
    await sleep(10);

    // One answer and nothing else: no second turn, and no drop notice of any kind.
    expect(h.gateway.sent.map((m) => m.text)).toEqual(["hi"]);
  });
});

/**
 * A long turn used to be unrecoverable.
 *
 * Compaction runs once, before the tool loop. Inside the loop the working set grows with every tool
 * result across up to `max_tool_iterations` of them, and nothing measured it again. The only net was
 * reactive — `ProviderCaller.call` catching the provider's overflow and retrying with harder truncation — and
 * truncation is turn-aligned, preserving the *running* turn. So it could only drop history, never the
 * turn's own tool output, which is what had overflowed. Four `read` calls at the 256KB tool cap did it.
 */
describe("a long turn makes room for itself", () => {
  /** ~24KB per call — two of them clear any budget a 32k context window leaves for history. */
  function bigOutputTool(): Map<string, Tool> {
    let call = 0;
    return new Map<string, Tool>([
      [
        "dump",
        {
          requiresApproval: false,
          definition: {
            name: "dump",
            description: "returns a lot",
            parameters: { type: "object", properties: {} },
          },
          async execute() {
            call += 1;
            /**
             * Sized against the fixture's real budget: `compact_at` comes out at ~3180 tokens, so one
             * result at ~2000 fits and two at ~4000 do not.
             *
             * It was 24k characters — about 6000 tokens — which exceeded the budget *on its own*. These
             * tests therefore only passed because the newest result used to be protected absolutely:
             * they were asserting the behaviour that guaranteed an overflow, not the trimming they
             * describe. Now that the protection yields when nothing else can, the fixture has to
             * actually create the situation it claims to.
             */
            // Many lines rather than one long one: a single line past the per-result cap is now cut to
            // it, and the excerpt has to be big enough to press on the budget for trimming to be tested.
            // Each line its own (0.8.17): two hundred identical ones are counted as one by kind and press on nothing.
            return { content: `PAYLOAD-${call}\n${Array.from({ length: 200 }, (_, i) => `${"x".repeat(35)}${String(i).padStart(4, "0")}`).join("\n")}`, isError: false };
          },
        },
      ],
    ]);
  }

  const tightContext = {
    ...PROVIDER_TOML,
    llm: {
      ...PROVIDER_TOML.llm,
      context: {
        max_context_ratio: 0.5,
        compact_at_ratio: 0.5,
        // One, so the second call's output is protected and the first is not — which is the
        // distinction the setting exists to make.
        preserve_recent_tool_results: 1,
      },
    },
  };

  test("old tool output is dropped from the request, the newest is kept", async () => {
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "dump", args: {} }] },
        { toolCalls: [{ id: "c2", name: "dump", args: {} }] },
        { text: "read both" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["dump"]\n',
      extraTools: bigOutputTool(),
      configOverrides: tightContext,
    });

    h.gateway.receive(envelope({ text: "dump everything" }));
    await h.pipeline.idle();

    // Three provider calls: the opening one, and one after each tool result.
    expect(h.requests.length).toBeGreaterThanOrEqual(3);
    const third = JSON.stringify(h.requests[2]);

    // The first payload is gone, replaced by a marker that says so...
    expect(third).toContain("earlier tool output moved out of context to make room");
    expect(third).not.toContain("PAYLOAD-1");
    // ...and the one the model is still working from survived.
    expect(third).toContain("PAYLOAD-2");
  });

  test("nothing is trimmed while it still fits", async () => {
    // The second request carries only one result and is under the threshold. Trimming there would cost
    // the model context for nothing.
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "dump", args: {} }] },
        { text: "done" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["dump"]\n',
      extraTools: bigOutputTool(),
      configOverrides: tightContext,
    });

    h.gateway.receive(envelope({ text: "dump once" }));
    await h.pipeline.idle();

    expect(JSON.stringify(h.requests[1])).toContain("PAYLOAD-1");
  });

  test("the turn still answers instead of failing on overflow", async () => {
    // The point of all of it: the reply arrives.
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "dump", args: {} }] },
        { toolCalls: [{ id: "c2", name: "dump", args: {} }] },
        { toolCalls: [{ id: "c3", name: "dump", args: {} }] },
        { text: "here is what I found" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["dump"]\n',
      extraTools: bigOutputTool(),
      configOverrides: tightContext,
    });

    h.gateway.receive(envelope({ text: "dump it all" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toBe("here is what I found");
  });
});

/**
 * A conversation's next turn starts from what its provider last counted (M8), through the daemon's own wiring.
 *
 * A turn learns from its first call how many tokens the provider counts for each one we estimate. Unless the
 * next turn starts from that, a history that tokenizes at four times its estimate is sent whole by the
 * estimate, and corrected only once the request that should have been cut is already out.
 */
describe("a conversation's next turn starts at its provider's count", () => {
  const slidingWindow = { ...PROVIDER_TOML, llm: { ...PROVIDER_TOML.llm, context: { truncation_strategy: "sliding_window" } } };
  const key = { agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" };

  /** Ten earlier turns of ~1k estimated tokens: the default 32k window holds them by the estimate, not at 4x. */
  const earlier = () =>
    Array.from({ length: 10 }, (_, i) => [
      { role: "user" as const, content: `turn ${i} ${"y".repeat(3_900)}`, timestamp: i * 2 },
      { role: "assistant" as const, content: `answered ${i}`, timestamp: i * 2 + 1 },
    ]).flat();

  /** A first turn whose provider reports `promptTokens`, then the next thing to run in the conversation. */
  async function after(promptTokens: number, next: (h: Harness) => Promise<unknown>) {
    const h = await harness({ turns: [{ text: "first", promptTokens }, { text: "second" }], configOverrides: slidingWindow });
    h.sessions.save(key, earlier(), 0);
    h.gateway.receive(envelope({ id: "m1", text: "one" }));
    await h.pipeline.idle();
    await next(h);
    return { first: h.requests[0], second: h.requests[1] };
  }

  const message = async (h: Harness) => {
    h.gateway.receive(envelope({ id: "m2", text: "two" }));
    await h.pipeline.idle();
  };

  test("a history the provider counted at 4x its estimate is cut before the next turn's first call", async () => {
    // A million tokens for the first request: four times the estimate, the most a scale is allowed to be.
    const dense = await after(1_000_000, message);
    const plain = await after(10, message);

    // The first turn knew nothing yet, and sent the whole history either way.
    expect(dense.first.messages.length).toBe(plain.first.messages.length);
    expect(dense.second.messages.length).toBeLessThan(plain.second.messages.length);
  });

  test("and so does a scheduled job kept in that conversation", async () => {
    const job = {
      id: "job_report",
      name: "report",
      agentId: "nouva",
      session: "chat",
      trigger: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "send the daily report" },
      target: { gatewayId: "telegram:main", chatId: "chat-1" },
      delivery: { mode: "none" },
      enabled: true,
    } as unknown as Job;
    const report = (h: Harness) =>
      h.pipeline.cronExecutors().runTurn({ job, session: { gatewayId: "telegram:main", chatId: "chat-1" }, message: "send the daily report", signal: new AbortController().signal });

    const dense = await after(1_000_000, report);
    const plain = await after(10, report);
    expect(dense.second.messages.length).toBeLessThan(plain.second.messages.length);
  });
});

/**
 * A slash command must not queue behind the turn it is answering.
 *
 * Found in production, on Telegram. `/approve` was parsed inside the queue handler, and the queue is
 * one-at-a-time per conversation — so the turn waiting on the approval held the key, and the answer
 * queued behind the question. Neither could move until the approval timed out five minutes later.
 * Three `/approve` messages went unanswered; the third message, `/stop`, then landed and paused the
 * agent. From the outside it read as a bot that had simply stopped working.
 *
 * The property that matters is not "commands are fast" but "commands do not wait for turns".
 */
describe("commands answer while a turn is still running", () => {
  function slowTool(ms: number): Map<string, Tool> {
    return new Map<string, Tool>([
      [
        "slow",
        {
          requiresApproval: false,
          definition: { name: "slow", description: "takes a while", parameters: { type: "object", properties: {} } },
          async execute() {
            await sleep(ms);
            return { content: "done", isError: false };
          },
        },
      ],
    ]);
  }

  const busyTurn = () => ({
    turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "finished the long thing" }],
    agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n',
    extraTools: slowTool(400),
  });

  test("/status replies before the blocking turn finishes", async () => {
    const h = await harness(busyTurn());

    h.gateway.receive(envelope({ id: "m1", text: "do the slow thing" }));
    await sleep(40);
    // Same conversation, while the turn is mid-tool.
    h.gateway.receive(envelope({ id: "m2", text: "/status" }));

    // Well inside the turn's 400ms tool. Before the fix this saw nothing at all.
    await sleep(120);
    const early = h.gateway.sent.map((m) => m.text);
    expect(early.some((t) => t.includes("Nouva"))).toBe(true);
    expect(early.some((t) => t.includes("finished the long thing"))).toBe(false);

    await h.pipeline.idle();
    expect(h.gateway.sent.some((m) => m.text.includes("finished the long thing"))).toBe(true);
  });

  test("ordinary messages still queue, one turn at a time", async () => {
    // The exemption has to stay narrow. Two turns at once in one conversation both load the same
    // session and write the whole thing back, so the slower one erases the other.
    const h = await harness(busyTurn());

    h.gateway.receive(envelope({ id: "m1", text: "do the slow thing" }));
    await sleep(40);
    h.gateway.receive(envelope({ id: "m2", text: "and this one too" }));
    await sleep(120);

    // No *answer* from the second message yet: it is still waiting its turn, which is correct.
    // Message count is not the assertion — the progress line is its own message and may be there.
    expect(h.gateway.sent.some((m) => m.text.includes("finished the long thing"))).toBe(false);
    await h.pipeline.idle();
  });

  test("a message that merely mentions a command is not exempt", async () => {
    // "/status" inside a sentence is a question for the model, not a command. Treating it as one
    // would run a turn outside the ordering — the exact concurrency this guards against.
    const h = await harness({ turns: [{ text: "that command shows uptime" }] });

    h.gateway.receive(envelope({ text: "what does /status do?" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toBe("that command shows uptime");
    expect(h.requests.length).toBeGreaterThan(0);
  });
});

/**
 * Live progress in the conversation.
 *
 * The daemon has emitted `tool` and `waiting` since Phase 3 and the CLI has rendered them all along;
 * chat gateways were never wired to the same stream. From a phone, a turn that reads four files and
 * runs a command looked exactly like one that had hung.
 */
describe("progress in the chat", () => {
  function namedTool(name: string, ms = 60): [string, Tool] {
    return [
      name,
      {
        requiresApproval: false,
        definition: { name, description: "does a thing", parameters: { type: "object", properties: {} } },
        async execute() {
          await sleep(ms);
          return { content: "done", isError: false };
        },
      },
    ];
  }

  const withTools = (turns: any[]) => ({
    turns,
    progressIntervalMs: 1,
    agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["alpha","beta"]\n',
    extraTools: new Map<string, Tool>([namedTool("alpha"), namedTool("beta")]),
  });

  test("names the tool it is running, then leaves a summary", async () => {
    const h = await harness(
      withTools([
        { toolCalls: [{ id: "c1", name: "alpha", args: {} }] },
        { toolCalls: [{ id: "c2", name: "beta", args: {} }] },
        { text: "all done" },
      ]),
    );

    h.gateway.receive(envelope({ text: "do both" }));
    await h.pipeline.idle();
    await sleep(30);

    // The tool was named while it ran, behind an in-progress mark...
    expect(h.gateway.edits.some((e) => e.text.includes("⏳"))).toBe(true);
    expect(h.gateway.edits.some((e) => e.text.includes("alpha") || e.text.includes("beta"))).toBe(true);
    // ...and the line ends as a record rather than a stale "running".
    const progressLine = h.gateway.sent[0]!;
    expect(progressLine.text).toMatch(/^(\[\w+\] )?✓ \d+ steps? · \d+s$/);
    // The answer is its own message, untouched by any of it.
    expect(h.gateway.sent.at(-1)?.text).toBe("all done");
  });

  test("a turn with no tools posts nothing at all", async () => {
    // A "working…" that is immediately replaced by the answer is noise with extra steps.
    const h = await harness({ turns: [{ text: "just an answer" }] });

    h.gateway.receive(envelope({ text: "hello" }));
    await h.pipeline.idle();
    await sleep(30);

    expect(h.gateway.sent).toHaveLength(1);
    expect(h.gateway.sent[0]?.text).toBe("just an answer");
    expect(h.gateway.edits).toHaveLength(0);
  });

  test("one message is edited, never one per step", async () => {
    // The property that makes this usable on a phone: editing re-notifies nobody, so a long turn
    // must not grow the message count.
    const h = await harness(
      withTools([
        { toolCalls: [{ id: "c1", name: "alpha", args: {} }] },
        { toolCalls: [{ id: "c2", name: "beta", args: {} }] },
        { toolCalls: [{ id: "c3", name: "alpha", args: {} }] },
        { text: "finished" },
      ]),
    );

    h.gateway.receive(envelope({ text: "do three things" }));
    await h.pipeline.idle();
    await sleep(30);

    // Exactly two: the progress line and the answer.
    expect(h.gateway.sent).toHaveLength(2);
    expect(h.gateway.edits.length).toBeGreaterThan(0);
  });

  test("starting a background job wraps the turn up instead of looping for more tools", async () => {
    const executed: string[] = [];
    const tools = new Map<string, Tool>([
      [
        "alpha",
        {
          requiresApproval: false,
          definition: { name: "alpha", description: "starts background work", parameters: { type: "object", properties: {} } },
          async execute() {
            executed.push("alpha");
            return {
              content: "Started in the background as job_1.",
              isError: false,
              metadata: { control: { finishTurn: "wrap_up", note: "background_started" } },
            };
          },
        },
      ],
      [
        "beta",
        {
          requiresApproval: false,
          definition: { name: "beta", description: "should not run", parameters: { type: "object", properties: {} } },
          async execute() {
            executed.push("beta");
            return { content: "should not happen", isError: false };
          },
        },
      ],
    ]);
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "alpha", args: {} }] },
        { text: "clone started in the background.", toolCalls: [{ id: "c2", name: "beta", args: {} }] },
      ],
      progressIntervalMs: 1,
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["alpha","beta"]\n',
      extraTools: tools,
    });

    h.gateway.receive(envelope({ text: "clone that repo" }));
    await h.pipeline.idle();

    expect(executed).toEqual(["alpha"]);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.stream).not.toBe(true);
    expect(h.gateway.lastText()).toBe("clone started in the background.");
  });

  test("a failed turn says so rather than leaving a running line", async () => {
    // A tool runs, then the provider fails on the call after it: the bubble the tool opened has to end
    // as a failure. This used to fail on the first call, before any tool — so no bubble existed, and
    // finishing a failed turn as `ok` passed it.
    let h!: Harness;
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const alpha: Tool = {
      requiresApproval: false,
      definition: { name: "alpha", description: "does a thing", parameters: { type: "object", properties: {} } },
      async execute() {
        await sleep(20);
        h.setFetch(failing);
        return { content: "done", isError: false };
      },
    };
    h = await harness({
      ...withTools([{ toolCalls: [{ id: "c1", name: "alpha", args: {} }] }]),
      extraTools: new Map<string, Tool>([["alpha", alpha]]),
    });

    h.gateway.receive(envelope({ text: "try" }));
    await h.pipeline.idle();
    await sleep(30);

    const bubble = h.gateway.edits.at(-1)?.text ?? h.gateway.sent[0]?.text ?? "";
    expect(bubble).toMatch(/^(\[\w+\] )?✕/);
    expect(h.gateway.lastText()).toMatch(/credentials are not working/i);
  });

  test("it can be turned off", async () => {
    const h = await harness({
      ...withTools([{ toolCalls: [{ id: "c1", name: "alpha", args: {} }] }, { text: "done" }]),
      configOverrides: {
        ...PROVIDER_TOML,
        llm: { ...PROVIDER_TOML.llm, streaming: { progress_in_chat: false } },
      },
    });

    h.gateway.receive(envelope({ text: "go" }));
    await h.pipeline.idle();
    await sleep(30);

    expect(h.gateway.sent).toHaveLength(1);
    expect(h.gateway.sent[0]?.text).toBe("done");
  });
});

/**
 * A person's approval level (`/approvals balanced`), end to end.
 *
 * The store is unit-tested; what this pins is the **wiring** — that the executor actually consults it,
 * keyed by sender, at the moment the gate says "ask". That is the part that would break silently: the
 * store would keep answering correctly while nothing asked it.
 */
describe("auto-approval reaches the tool gate", () => {
  const gated = (auto?: AutoApprove) => ({
    turns: [{ toolCalls: [{ id: "c1", name: "write", args: { path: "a.md", content: "hi" } }] }, { text: "wrote it" }],
    // `write` on the approval list and no gate wired: normally that is a refusal the model is told
    // about, which makes it a clean signal for whether the ask happened at all.
    agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["write"]\napproval_required = ["write"]\n',
    ...(auto ? { autoApproveStore: auto } : {}),
  });

  test("without it, the gated tool is not run", async () => {
    const h = await harness(gated());

    h.gateway.receive(envelope({ text: "write a file" }));
    await h.pipeline.idle();

    const sentToModel = JSON.stringify(h.requests);
    expect(sentToModel).toContain("no approval gate");
  });

  test("with it on for that sender, the tool runs", async () => {
    const auto = new AutoApprove({ db: (await import("@nouride/runtime")).openDatabase(":memory:") });
    await (await import("@/db/index.ts")).migrate((auto as never as { options: { db: never } }).options.db);
    auto.enable("telegram:main", "user-1", "user-1");

    const h = await harness(gated(auto));
    h.gateway.receive(envelope({ text: "write a file", senderId: "user-1" }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toBe("wrote it");
    expect(JSON.stringify(h.requests)).not.toContain("no approval gate");
  });

  test("the call it answers for is one step, marked on its result", async () => {
    /**
     * What the operator sees, and what a screenshot of a working turn showed instead: a spinner that
     * never stopped, with the same command completed on the row below it.
     *
     * The gate used to announce the call a second time with `(auto)` on the end, so the stream read
     * `tool`, `tool`, `tool_done`. The dashboard pairs a call with the result that follows it, so the
     * real call was never closed — and `countedSteps` counts `tool` steps, so every auto-approved
     * call was counted twice in the turn's step total. The marker is on the result line now, which
     * is where the row is.
     */
    const auto = new AutoApprove({ db: (await import("@nouride/runtime")).openDatabase(":memory:") });
    await (await import("@/db/index.ts")).migrate((auto as never as { options: { db: never } }).options.db);
    auto.enable("telegram:main", "user-1", "user-1");

    const h = await harness(gated(auto));
    h.gateway.receive(envelope({ text: "write a file", senderId: "user-1" }));
    await h.pipeline.idle();

    const session = sessionIdFor({ agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" });
    const turn = h.turns.latestForSession(session);
    const steps = h.turns.stepsSince(turn!.id, 0);
    const calls = steps.filter((step) => step.kind === "tool" && step.text.startsWith("write"));
    const results = steps.filter((step) => step.kind === "tool_done" && step.text.startsWith("write"));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).not.toContain("(auto)");
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toContain("(auto)");
  });

  test("another sender is still asked", async () => {
    // Keyed by person. One paired operator switching it off must not disarm the gate for everyone
    // else in a shared channel.
    const auto = new AutoApprove({ db: (await import("@nouride/runtime")).openDatabase(":memory:") });
    await (await import("@/db/index.ts")).migrate((auto as never as { options: { db: never } }).options.db);
    auto.enable("telegram:main", "someone-else", "someone-else");

    const h = await harness(gated(auto));
    h.gateway.receive(envelope({ text: "write a file", senderId: "user-1" }));
    await h.pipeline.idle();

    expect(JSON.stringify(h.requests)).toContain("no approval gate");
  });
});

/**
 * A spilled output is a note about a call, not the call's result.
 *
 * It is emitted the moment the tool returns and *before* the result line, so for as long as it was a
 * `tool_done` it was read as the result: the dashboard folded "output was 812KB" into the call as its
 * outcome and left the real `exec ok · 41ms` as an orphan row underneath. No pairing rule could have
 * fixed that from the other side — the two were indistinguishable — so the note has its own kind.
 */
describe("a tool that outgrows the context", () => {
  const loud = (bytes: number) =>
    new Map<string, Tool>([
      [
        "loud",
        {
          requiresApproval: false,
          definition: { name: "loud", description: "prints a lot", parameters: { type: "object", properties: {} } },
          async execute() {
            return { content: "x".repeat(bytes), isError: false };
          },
        },
      ],
    ]);

  test("says so as a note, and the call still gets its own result", async () => {
    const h = await harness({
      turns: [{ toolCalls: [{ id: "c1", name: "loud", args: {} }] }, { text: "that was a lot" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["loud"]\n',
      extraTools: loud(400_000),
    });

    h.gateway.receive(envelope({ text: "run the loud one" }));
    await h.pipeline.idle();

    const session = sessionIdFor({ agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" });
    const turn = h.turns.latestForSession(session);
    const steps = h.turns.stepsSince(turn!.id, 0);

    const note = steps.find((step) => step.text.includes("kept an excerpt"));
    expect(note?.kind).toBe("note");
    // The result is still a `tool_done`, and still the only one: that is the row the outcome belongs on.
    const results = steps.filter((step) => step.kind === "tool_done");
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toStartWith("loud ok ");
  });

  test("a turn may open its own spilled output and no one else's", async () => {
    // The whole spill directory used to be every agent's read-only root: one agent could read what
    // another's commands printed, in any conversation, for as long as retention kept it.
    let roots: string[] = [];
    const tools = loud(400_000);
    tools.set("roots", {
      requiresApproval: false,
      definition: { name: "roots", description: "reports roots", parameters: { type: "object", properties: {} } },
      async execute(_args, ctx) {
        roots = ctx.readOnlyRoots ?? [];
        return { content: "ok", isError: false };
      },
    });
    const h = await harness({
      turns: [{ toolCalls: [{ id: "c1", name: "loud", args: {} }, { id: "c2", name: "roots", args: {} }] }, { text: "ok" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["loud", "roots"]\n',
      extraTools: tools,
    });

    h.gateway.receive(envelope({ text: "go" }));
    await h.pipeline.idle();

    const spillRoot = join(h.dataDir, "tool-output");
    const mine = roots.filter((root) => root.startsWith(spillRoot));
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toBe(spillRoot);
    expect(mine[0]!.startsWith(join(spillRoot, "nouva") + "/")).toBe(true);
    // And the file the excerpt names is inside it, so the pointer can actually be followed.
    expect(JSON.stringify(h.requests.at(-1))).toContain(`${mine[0]}/c1.txt`);
  });

  test("a delegate helper can open what it spilled, and so can the lead", async () => {
    // A helper was given no read-only roots at all, so the excerpt of its own output said "open it
    // with `read`" and `read` refused the path.
    let helperRoots: string[] = [];
    const tools = loud(400_000);
    tools.set("roots", {
      requiresApproval: false,
      definition: { name: "roots", description: "reports roots", parameters: { type: "object", properties: {} } },
      async execute(_args, ctx) {
        helperRoots = ctx.readOnlyRoots ?? [];
        return { content: "ok", isError: false };
      },
    });
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [{ goal: "look", context: "a test", deliverable: "what you found" }] } }] },
        { toolCalls: [{ id: "c1", name: "roots", args: {} }] },
        { text: "looked" },
        { text: "done" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["roots", "delegate"]\n',
      extraTools: tools,
    });

    h.gateway.receive(envelope({ text: "delegate it" }));
    await h.pipeline.idle();

    const spillRoot = join(h.dataDir, "tool-output", "nouva");
    const scoped = helperRoots.filter((root) => root.startsWith(spillRoot));
    expect(scoped).toHaveLength(1);
    // The lead's conversation directory, not one of the helper's own: that is where the lead looks.
    expect(scoped[0]).not.toContain("sub_");
  });

  test("/new drops the output the conversation spilled", async () => {
    // The session id is derived from the chat, so the next conversation would otherwise inherit a
    // directory of output it never produced — and still be able to read it.
    const h = await harness({
      turns: [{ toolCalls: [{ id: "c1", name: "loud", args: {} }] }, { text: "that was a lot" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["loud"]\n',
      extraTools: loud(400_000),
    });

    h.gateway.receive(envelope({ id: "m1", text: "go" }));
    await h.pipeline.idle();
    const path = /tool-output[^"\\]*c1\.txt/.exec(JSON.stringify(h.requests.at(-1)))?.[0];
    expect(path).toBeDefined();
    expect(statFile(join(h.dataDir, path!))).not.toBeNull();

    h.gateway.receive(envelope({ id: "m2", text: "/new" }));
    await h.pipeline.idle();

    expect(statFile(join(h.dataDir, path!))).toBeNull();
  });

  test("a helper's spilled output reaches the agent that delegated, by path", async () => {
    // The helper read an excerpt and wrote a summary; the lead has only that summary unless it is told
    // where the whole output lives. Asked for lines 400-450 afterwards, it had nothing to open.
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [{ goal: "run the loud one", context: "a test", deliverable: "what you found" }] } }] },
        { toolCalls: [{ id: "c1", name: "loud", args: {} }] },
        { text: "it printed a lot" },
        { text: "the helper is done" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["loud", "delegate"]\n',
      extraTools: loud(400_000),
    });

    h.gateway.receive(envelope({ text: "delegate the loud one" }));
    await h.pipeline.idle();

    const handedBack = JSON.stringify(h.requests.at(-1));
    expect(handedBack).toContain("Full output of its large tool results");
    expect(handedBack).toMatch(/tool-output[^"]*c1\.txt/);
  });
});

/**
 * A background job reporting in is a system event, not a message from a person.
 *
 * Seen live: the agent killed a dev server it had started, said "Sudah dihentikan, Gading", and then
 * the job's own completion fired a second turn — "Sip, pekerjaan sudah resmi dihentikan. Ada hal lain
 * yang bisa dibantu?" A conversational answer to a message nobody had sent, restating what had just
 * been said one line earlier.
 */
describe("job wake-ups", () => {
  const wake = (h: Awaited<ReturnType<typeof harness>>) =>
    h.pipeline.wakeForJob({
      job: {
        id: "job_1",
        agentId: "nouva",
        gatewayId: "telegram:main",
        chatId: "chat-1",
        command: "vite dev",
        status: "succeeded",
        exitCode: 0,
        startedAt: Date.now() - 5000,
        endedAt: Date.now(),
        logPath: "/tmp/job_1.log",
      },
      tail: "ready in 300ms",
    } as never);

  test("a turn with nothing to add says nothing at all", async () => {
    // For a person, silence is the failure the empty-turn fallback exists for. For a job reporting in,
    // "I did not manage to produce an answer" is a reply to a question nobody asked.
    const h = await harness({ turns: [{ text: "" }] });

    wake(h);
    await h.pipeline.idle();

    expect(h.gateway.sent).toHaveLength(0);
  });

  test("a full stop is the silence it was allowed, not a message", async () => {
    // Told it may reply with nothing, a model that cannot send an empty message sends "." — and one
    // Telegram chat got nine bubbles holding a dot in an evening. Nothing is owed for it either: a "."
    // recorded as the reply would be re-sent by the next boot.
    const h = await harness({ turns: [{ text: "." }] });

    const release = holdLines();
    wake(h);
    await h.pipeline.idle();

    expect(h.gateway.sent).toHaveLength(0);
    // Silence asked for is not a warning: each counted in a deploy's warn lines (0.8.12).
    expect(release().map((line) => line.message)).not.toContain("turn produced no text");
  });

  test("a person still gets the fallback when a turn produces nothing", async () => {
    // The exemption must stay narrow: an approval that expires mid-turn leaves a human with no reply
    // and no error, which is exactly the impression this daemon spent a session learning not to give.
    const h = await harness({ turns: [{ text: "" }] });

    h.gateway.receive(envelope({ text: "hello?" }));
    await h.pipeline.idle();

    expect(h.gateway.sent).toHaveLength(1);
    expect(h.gateway.lastText()).toContain("did not manage");
  });

  test("the model is told nobody is waiting on a reply", async () => {
    const h = await harness({ turns: [{ text: "vite is up" }] });

    wake(h);
    await h.pipeline.idle();

    const prompt = JSON.stringify(h.requests);
    expect(prompt).toContain("System event");
    expect(prompt).toContain("Nobody is waiting on a reply");
    // And what to do with it: one line, or nothing.
    // The request as JSON: the full stop's quotes are escaped there.
    expect(prompt).toContain('reply with only \\".\\" (it is not sent)');
  });

  test("something worth saying still reaches the chat", async () => {
    const h = await harness({ turns: [{ text: "the build finished, 0 errors" }] });

    wake(h);
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toBe("the build finished, 0 errors");
  });

  /**
   * A job that finishes in a room wakes into a room.
   *
   * `chatType` was hardcoded `"dm"` on every synthetic envelope, and that was harmless right up until
   * a DM's handover became a bus — from then on the constant decided *how the agent is told it can
   * reach another agent*. A job completing in a Discord channel woke its agent with a prompt saying
   * "this is a one-to-one chat, writing @their-name does nothing", in the one room where the tag is
   * the whole mechanism. A background job is exactly what interrupts a handover, so this is the turn
   * that has to close it.
   */
  describe("a job that finishes in a channel", () => {
    /** The live shape: several of our bots in one room, and unaddressed chatter ignored. */
    const room = {
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-second", agent: "nox" },
          },
        },
        agents: { groups_require_mention: true, mentions_enabled: true, mention_max_hops: 4 },
      },
      secondAgent: "nox",
    };

    const wakeIn = (h: Awaited<ReturnType<typeof harness>>, chatId: string) =>
      h.pipeline.wakeForJob({
        job: {
          id: "job_2",
          agentId: "nouva",
          gatewayId: "telegram:main",
          chatId,
          command: "npm run build",
          status: "succeeded",
          exitCode: 0,
          startedAt: Date.now() - 5000,
          endedAt: Date.now(),
          logPath: "/tmp/job_2.log",
        },
        tail: "built in 12s",
      } as never);

    test("is told the tag works, because in a room it does", async () => {
      const h = await harness({ ...room, turns: [{ text: "seen" }, { text: "build done" }] });

      // The message that started the job. This is the only place the platform says what kind of chat
      // this is, and it is what the wake-up reads back.
      h.gateway.receive(envelope({ chatType: "channel", chatId: "room-9", text: "nouva: build it" }));
      await h.pipeline.idle();

      wakeIn(h, "room-9");
      await h.pipeline.idle();
      // The wake-up turn's prompt, not the first one's. The OTHER AGENTS block is what is under test —
      // `ask_agent` is still *offered* in a room, it is simply not the transport it is pointed at.
      const system: string = h.requests.at(-1)?.messages?.[0]?.content ?? "";
      expect(system).toContain("write @nox");
      expect(system).toContain("  - nox: Nox. Runs the builds and reports what broke");
      expect(system).toContain("hands the work over");
      // The bus lines, quoted tightly — "does nothing" on its own also appears in the config section,
      // about an endpoint that needs `allow_private_urls`.
      expect(system).not.toContain("one-to-one chat");
      expect(system).not.toContain("Writing @their-name here does nothing");
    });

    test("still reaches its agent where nothing unaddressed is answered", async () => {
      // The half that would have broken silently. `groups_require_mention` plus two of our bots means
      // no fallback names an agent, so an honest `chatType` alone would have routed the wake-up to
      // nobody and the job would have finished into silence. The job row knows whose it is.
      const h = await harness({ ...room, turns: [{ text: "seen" }, { text: "build done" }] });

      h.gateway.receive(envelope({ chatType: "channel", chatId: "room-9", text: "nouva: build it" }));
      await h.pipeline.idle();
      const before = h.requests.length;

      wakeIn(h, "room-9");
      await h.pipeline.idle();

      expect(h.requests.length).toBe(before + 1);
      expect(h.gateway.lastText()).toBe("build done");
    });

    test("does not ask the platform to quote a message it invented", async () => {
      // A system event's id names nothing the platform has seen. Invisible while these envelopes all
      // claimed to be DMs — a DM is not quoted anyway — and a refused send the moment one says
      // "channel": Telegram rejects a reply to a message that does not exist, so the answer is lost.
      const h = await harness({ ...room, turns: [{ text: "seen" }, { text: "build done" }] });

      h.gateway.receive(envelope({ chatType: "channel", chatId: "room-9", text: "nouva: build it" }));
      await h.pipeline.idle();

      wakeIn(h, "room-9");
      await h.pipeline.idle();

      const wakeReply = h.gateway.sent.at(-1)!;
      expect(wakeReply.text).toBe("build done");
      expect(wakeReply.replyTo).toBeUndefined();
    });

    test("the chat-type table does not grow without bound", async () => {
      // Every table in this directory has grown without a ceiling at least once. This one holds a
      // short string per conversation the daemon has ever seen, which is small right up until a
      // public bot has been up for a month.
      const { ChatTypes } = await import("@/modules/pipeline/chat-types.ts");
      const types = new ChatTypes();

      for (let i = 0; i < 6_000; i += 1) {
        types.remember(envelope({ chatId: `chat-${i}`, chatType: "channel" }));
      }

      expect(types.size()).toBeLessThanOrEqual(5_000);
      // And the recent ones are the ones kept — eviction takes the oldest, not the newest.
      expect(types.of("telegram:main", "chat-5999")).toBe("channel");
    });

    test("an agent whose own bot cannot read the room is said to be out of it, not handed a tag", async () => {
      // Live on Discord (0.8.12): only Nouva's bot could view the channel; Nouva was told to write Nexa's tag, did, and
      // Nexa's bot never received it. Its connection says so (`Gateway.sees`), and the prompt does.
      const h = await harness({ ...room, turns: [{ text: "ok" }] });
      h.second.selfMention = "<@2>";
      h.second.sees = (chatId) => (chatId === "room-5" ? false : undefined);
      h.gateway.receive(envelope({ chatType: "channel", chatId: "room-5", text: "nouva: who is here?" }));
      await h.pipeline.idle();
      const system: string = h.requests.at(-1)?.messages?.[0]?.content ?? "";
      expect(system).toContain("- Not in this chat: nox. Their bot cannot read it");
      expect(system).not.toContain("nox (write <@2>)");
    });

    test("a chat this process has never seen falls back to a one-to-one", async () => {
      // After a restart, for a job that outlived the daemon. Wrong in a room, but wrong in the quiet
      // direction: it under-promises a transport instead of advertising one that may not be there.
      const h = await harness({ ...room, turns: [{ text: "build done" }] });

      wakeIn(h, "never-seen");
      await h.pipeline.idle();

      const system: string = h.requests.at(-1)?.messages?.[0]?.content ?? "";
      expect(system).toContain("one-to-one chat");
    });

    test("a wake-up that arrives while the turn is still active waits rather than being dropped", async () => {
      // The bug this pins: in a room the queue's per-key concurrency is relaxed (several agents run
      // at once), so a job wake-up pushed while the originating turn was still wrapping up passed the
      // queue and hit `isBusy`, which dropped it silently. Every background job started from a
      // Discord channel finished into silence — the log showed `background job finished` followed by
      // `that agent is already working in this chat`, and the agent never reported the result.
      let releaseTool!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });

      const h = await harness({
        ...room,
        turns: [
          // First turn: calls the slow tool, then says "starting"
          { toolCalls: [{ id: "c1", name: "gate", args: {} }] },
          { text: "starting" },
          // Second turn: the wake-up turn that reports the result
          { text: "build done" },
        ],
        agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["gate"]\n',
        extraTools: new Map<string, Tool>([
          [
            "gate",
            {
              requiresApproval: false,
              definition: {
                name: "gate",
                description: "blocks until released",
                parameters: { type: "object", properties: {} },
              },
              async execute() {
                await gate;
                return { content: "done", isError: false };
              },
            },
          ],
        ]),
      });

      // Start a turn in a room — the tool blocks, so the turn stays active.
      h.gateway.receive(envelope({ chatType: "channel", chatId: "room-9", text: "nouva: build it" }));
      // Let the turn start (reach the tool call) but don't let it finish.
      await sleep(50);

      // The job completes while the turn is still active — this is the race.
      wakeIn(h, "room-9");

      // Release the tool so the first turn can finish.
      releaseTool();
      await h.pipeline.idle();

      // The wake-up turn ran: the agent reported the build result.
      expect(h.gateway.lastText()).toBe("build done");
    });
  });
});

/**
 * Every tool call the model makes must come back with a result, on the same wire request.
 *
 * Both providers enforce it: Anthropic rejects a `tool_use` block with no matching `tool_result`, and
 * OpenAI rejects an assistant message with `tool_calls` that is not followed by a `tool` message per
 * id. A 400 there is not a recoverable tool error — it fails the whole turn, and because the turn's
 * messages are what gets *persisted*, a malformed pair poisons the conversation for every turn after
 * it too.
 */
describe("a turn that stops early still answers every tool call it made", () => {
  /** Starts a background job: returns the `wrap_up` control that ends the tool loop. */
  function backgroundTool(): [string, Tool] {
    return [
      "launch",
      {
        requiresApproval: false,
        definition: {
          name: "launch",
          description: "starts something in the background",
          parameters: { type: "object", properties: {} },
        },
        async execute() {
          return {
            content: "job started",
            isError: false,
            metadata: { control: { finishTurn: "wrap_up", note: "background_started" } },
          };
        },
      },
    ];
  }

  function plainTool(): [string, Tool] {
    return [
      "peek",
      {
        requiresApproval: false,
        definition: {
          name: "peek",
          description: "looks at a thing",
          parameters: { type: "object", properties: {} },
        },
        async execute() {
          return { content: "looked", isError: false };
        },
      },
    ];
  }

  test("a wrap_up in the middle of a parallel batch does not orphan the calls after it", async () => {
    // Models batch tool calls, so `launch` arriving alongside `peek` is ordinary rather than exotic.
    // The loop used to `break` on the control flag, which left `peek` with a call and no result.
    const h = await harness({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "launch", args: {} },
            { id: "c2", name: "peek", args: {} },
          ],
        },
        { text: "started it; will report back" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["launch","peek"]\n',
      extraTools: new Map<string, Tool>([backgroundTool(), plainTool()]),
    });

    h.gateway.receive(envelope({ text: "launch it and peek" }));
    await h.pipeline.idle();

    // The wrap-up call is the one that carries the malformed history to the provider.
    const wrapUp = h.requests.at(-1);
    const calls = (wrapUp.messages as any[]).flatMap((m) =>
      (m.tool_calls ?? []).map((c: any) => c.id),
    );
    const answered = (wrapUp.messages as any[])
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id);

    expect(calls.sort()).toEqual(["c1", "c2"]);
    expect(answered.sort()).toEqual(["c1", "c2"]);
  });

  test("the calls after the wrap_up still run, rather than being silently dropped", async () => {
    // Wrap-up means "do not ask for another round", not "abandon what was already asked for". A model
    // that batches three `exec(background: true)` clones intends three jobs; breaking on the first
    // gave it one and no word about the other two.
    const h = await harness({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "launch", args: {} },
            { id: "c2", name: "peek", args: {} },
          ],
        },
        { text: "ok" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["launch","peek"]\n',
      extraTools: new Map<string, Tool>([backgroundTool(), plainTool()]),
    });

    h.gateway.receive(envelope({ text: "launch it and peek" }));
    await h.pipeline.idle();

    const wrapUp = h.requests.at(-1);
    const peeked = (wrapUp.messages as any[]).find((m) => m.tool_call_id === "c2");
    expect(peeked.content).toContain("looked");
  });

  test("the wrap_up still ends the turn — one more round is exactly what it prevents", async () => {
    // Two provider calls: the batch, then the wrap-up. A third would mean the loop kept going.
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "launch", args: {} }] },
        { text: "started it" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["launch","peek"]\n',
      extraTools: new Map<string, Tool>([backgroundTool(), plainTool()]),
    });

    h.gateway.receive(envelope({ text: "launch it" }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(2);
    expect(h.gateway.sent.at(-1)?.text).toContain("started it");
  });
});

/**
 * Replying to a message must not stop a slash command from being one.
 *
 * Telegram and Discord learned to include the quoted message so the model has the context a reply
 * points at — but they did it by prepending `> [Name]: …` to `envelope.text`, and that field is what
 * the command parser, the slash-command queue bypass and the mention router all read.
 *
 * The result: replying to the approval prompt with `/approve` — the most natural way to answer one —
 * produced text starting with `>`, so `parseCommand` returned null. The command was not recognised at
 * all, it was sent to the model as chat, and it lost the queue bypass that exists precisely so an
 * answer does not wait behind the turn that is blocked on it. Which is the deadlock the bypass was
 * built for, reintroduced through the inbound path.
 */
describe("a command sent as a reply is still a command", () => {
  test("`/status` quoting an earlier message is handled by the hook, not the model", async () => {
    const h = await harness({ turns: [{ text: "should not be reached" }] });

    h.gateway.receive(
      envelope({
        text: "/status",
        quotedText: "Waiting on you before I run exec.",
        replyTo: "m0",
      }),
    );
    await h.pipeline.idle();

    // The hook answered, so the provider was never called.
    expect(h.requests).toHaveLength(0);
    // Nothing running and nothing waiting: idle, not the pack's "running" (0.7.18).
    expect(h.gateway.sent[0]?.text).toContain("State: idle");
  });

  test("the quote still reaches the model on an ordinary message", async () => {
    // Removing it from `text` must not lose it: "what about this?" means nothing without the message
    // it points at, which is the whole reason the gateways started including it.
    const h = await harness({ turns: [{ text: "answered" }] });

    h.gateway.receive(
      envelope({ text: "what about this?", quotedText: "the build is red", replyTo: "m0" }),
    );
    await h.pipeline.idle();

    const sent = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content as string;
    expect(sent).toContain("the build is red");
    expect(sent).toContain("what about this?");
  });

  test("the quote is marked so the model cannot read it as the person's own words", async () => {
    // "what about this?" and the message it points at are different claims. Merged, a model answers
    // the wrong one.
    const h = await harness({ turns: [{ text: "answered" }] });

    h.gateway.receive(
      envelope({ text: "still red?", quotedText: "the build is red", quotedSender: "Nouva" }),
    );
    await h.pipeline.idle();

    const sent = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content as string;
    expect(sent).toContain("> [Nouva]: the build is red");
    expect(sent.indexOf("the build is red")).toBeLessThan(sent.indexOf("still red?"));
  });

  test("a quote with no message of its own still reaches the model", async () => {
    // Forwarding something with no comment is a real thing people do; dropping it would answer nothing.
    const h = await harness({ turns: [{ text: "answered" }] });

    h.gateway.receive(envelope({ text: "", quotedText: "the build is red" }));
    await h.pipeline.idle();

    const sent = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content as string;
    expect(sent).toContain("the build is red");
  });

  test("a quoted mention does not reroute the message to the agent it names", async () => {
    // `findMentioned` scans the whole text for `@name`. With the quote inside it, replying to a
    // message that happened to mention another agent handed your reply to that agent.
    const h = await harness({
      turns: [{ text: "nouva answering" }],
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-main", agent: "nox" },
          },
        },
      },
    });

    h.gateway.receive(
      envelope({ chatType: "dm", text: "carry on", quotedText: "ask @nox about it", replyTo: "m0" }),
    );
    await h.pipeline.idle();

    expect(h.gateway.sent.map((m) => m.text).join(" ")).toContain("nouva answering");
    expect(h.second.sent).toHaveLength(0);
  });
});

/**
 * An unanswered approval must not cost the agent its whole turn.
 *
 * `approval_timeout_ms` and `max_turn_duration_ms` both default to 300s and the turn starts first, so
 * the turn was always aborted before the model could react to a refused call — the "denial is a tool
 * result the model can adapt to" path was unreachable by construction. Live, that read as an agent
 * going silent for five minutes: seven tool calls, an approval nobody answered, and no reply at all.
 *
 * A slice of the turn is held back now, and the question stays open after the turn stops waiting.
 */
describe("the platform command menu", () => {
  /**
   * Published when a connection comes up, not when somebody remembers `/commands`.
   *
   * The day `/auto` became `/approvals`, the Telegram menu went on offering `/auto` — a rename that
   * shipped, deployed, and then lied in the one place a person looks for the list. Nobody forgets a
   * maintenance command because they are careless; they forget because it exists.
   */
  test("is published on connect, without the renamed commands in it", async () => {
    const h = await harness({ turns: [{ text: "unused" }] });

    // What a real adapter emits once it is up.
    h.gateway.emit({ type: "status", gatewayId: h.gateway.id, status: "connected" });
    await sleep(5);

    const published = h.gateway.syncedCommands;
    expect(published).not.toBeNull();
    const names = (published ?? []).map((c) => c.command);
    expect(names).toContain("approvals");
    expect(names).not.toContain("auto");
    // And no leading slash: Telegram rejects the list otherwise.
    expect(names.every((name) => !name.startsWith("/"))).toBe(true);
  });
});

describe("/approvals", () => {
  /**
   * The rename, and the one thing the chat surface must not be able to do.
   *
   * `/auto on|off` could say "stop asking me" or "ask me" and nothing either side. `trusted` is the level
   * either side — and a chat sender is not authenticated, which is the entire reason pairing exists. So
   * `/approvals trusted` typed in a Discord server must not work, however paired the person typing it is.
   */
  test("refuses `trusted` from a chat message, and says where it is set", async () => {
    const h = await harness({ turns: [{ text: "unused" }] });

    h.gateway.receive(envelope({ id: "a1", chatType: "dm", text: "/approvals trusted" }));
    await h.pipeline.idle();

    const reply = h.gateway.lastText();
    expect(reply).toContain("cannot be set from a chat message");
    expect(reply).toContain("dashboard");
  });

  test("shows what is set and who set it", async () => {
    // "Why am I being asked" and "why am I not" are one question, and the answer is the source.
    const h = await harness({ turns: [{ text: "unused" }] });
    h.gateway.receive(envelope({ id: "a3", chatType: "dm", text: "/approvals" }));
    await h.pipeline.idle();

    const reply = h.gateway.lastText();
    expect(reply).toContain("Approvals:");
    expect(reply).toContain("daemon default");
  });

  test("`/auto`, the old name, is gone: it reaches the model as an unknown command does, and sets nothing", async () => {
    // 0.7.x answered it with the new name; 0.8.0 has no stub for it, so it is words like `/frobnicate`.
    const h = await harness({ turns: [{ text: "the model's answer" }] });
    h.gateway.receive(envelope({ id: "a4", chatType: "dm", text: "/auto on" }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    expect(h.gateway.lastText()).toBe("the model's answer");
  });
});

describe("a turn that gives up waiting on a human", () => {
  /** A gate that never answers, and remembers it was asked. */
  function silentGate() {
    const asked: { tool: string; waitMs?: number }[] = [];
    return {
      asked,
      gate: {
        available: true,
        async request(ask: { tool: string; waitMs?: number }) {
          asked.push({ tool: ask.tool, waitMs: ask.waitMs });
          // What the store now returns when the turn's slice runs out: not a no, a not-yet.
          return { status: "expired" as const, stillAnswerable: true };
        },
        pending: () => [],
        expireAll: () => 0,
      },
    };
  }

  function gatedTool(): [string, Tool] {
    return [
      "touchy",
      {
        requiresApproval: true,
        definition: {
          name: "touchy",
          description: "needs a human",
          parameters: { type: "object", properties: {} },
        },
        async execute() {
          return { content: "should never run", isError: false };
        },
      },
    ];
  }

  test("the model is told it is a not-yet, and still gets to answer", async () => {
    const silent = silentGate();
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "touchy", args: {} }] },
        { text: "I need approval for that one — everything else is done." },
      ],
      agentConfigToml:
        '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["touchy"]\napproval_required = ["touchy"]\n',
      extraTools: new Map<string, Tool>([gatedTool()]),
      approvals: silent.gate,
    });

    h.gateway.receive(envelope({ text: "do the touchy thing" }));
    await h.pipeline.idle();

    // It asked, and it asked with a bounded wait rather than the full approval timeout.
    expect(silent.asked).toHaveLength(1);
    expect(silent.asked[0]?.waitMs).toBeGreaterThan(0);

    // And the turn produced a real reply instead of dying silently.
    expect(h.gateway.sent.at(-1)?.text).toContain("everything else is done");

    // The model was told it is still open, not that it was refused.
    const afterTool = h.requests.at(-1)?.messages?.find((m: any) => m.role === "tool");
    expect(afterTool.content).toMatch(/still open/i);
    expect(afterTool.content).not.toMatch(/denied/i);
  });

  test("the wait is bounded by the turn's deadline, not by the approval timeout", async () => {
    // The number that matters: with a 60s turn, the gate must not be handed anything close to the
    // 300s approval window, or the turn dies inside it exactly as before.
    const silent = silentGate();
    const h = await harness({
      turns: [{ toolCalls: [{ id: "c1", name: "touchy", args: {} }] }, { text: "done" }],
      agentConfigToml:
        '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["touchy"]\napproval_required = ["touchy"]\n',
      extraTools: new Map<string, Tool>([gatedTool()]),
      approvals: silent.gate,
      configOverrides: { ...PROVIDER_TOML, llm: { limits: { max_turn_duration_ms: 60_000 } } },
    });

    h.gateway.receive(envelope({ text: "do it" }));
    await h.pipeline.idle();

    expect(silent.asked[0]?.waitMs).toBeLessThan(60_000);
  });
});

/**
 * What the room said while nobody was addressing the agent.
 *
 * The behaviour this replaces was live on both Discord and WhatsApp: asked "@nouva ini" about the
 * message directly above it, the agent had no record of that message and answered by asking what
 * "ini" meant. Every test here drives the real gateway callback, so the two placement decisions the
 * feature rests on — capture before `admit`, replay after the session loads — are exercised rather
 * than described.
 */
describe("group context", () => {
  // A minute ago: fresh, so the inbox lets the messages through.
  const AT = Date.now() - 60_000;

  /** A message in a shared channel. The fixture's default is a DM, where none of this applies. */
  const said = (
    id: string,
    text: string,
    at: number,
    extra: Parameters<typeof envelope>[0] = {},
  ) => envelope({ id, text, chatType: "group", chatId: "group-1", timestamp: at, ...extra });

  /**
   * A group where an agent has to be addressed.
   *
   * Without this the fixture's single disabled gateway makes `answerUnaddressed` true even in a
   * channel, so every line of chatter would start a turn of its own and there would be nothing left
   * to overhear.
   */
  const inAGroup = { agents: { groups_require_mention: true } };

  /** The last thing sent to the provider — the user message the turn was actually built from. */
  const question = (h: Harness, index = 0): string =>
    (conversationOf(h.requests[index]?.messages ?? []).at(-1)?.content as string) ?? "";

  test("chatter nobody was addressed in is replayed when the agent is finally tagged", async () => {
    const h = await harness({ turns: [{ text: "kereta ya" }], configOverrides: inAGroup });

    h.gateway.receive(said("c1", "udah pesen tiket belum?", AT + 1_000, { senderName: "Jordan" }));
    h.gateway.receive(said("c2", "belum, nunggu approval", AT + 2_000, { senderName: "Ani" }));
    await h.pipeline.idle();

    h.gateway.receive(said("t1", "ini gimana?", AT + 3_000, { mentions: ["nouva"] }));
    await h.pipeline.idle();

    const sent = question(h);
    expect(sent).toContain("Jordan: udah pesen tiket belum?");
    expect(sent).toContain("Ani: belum, nunggu approval");
    // Labelled, and in front of the question — the block is entirely other people asking each other
    // things, and a model that reads it as the request answers the wrong one.
    expect(sent).toContain("do not bring up anything from them unless");
    expect(sent.indexOf("Jordan")).toBeLessThan(sent.indexOf("ini gimana?"));
  });

  test("chatter on its own still starts nothing", async () => {
    // The whole point of `groups_require_mention` survives: the room is remembered, not answered.
    // A version of this that queued a turn per message would be a bill and a very talkative bot.
    const h = await harness({ turns: [{ text: "should not run" }], configOverrides: inAGroup });

    h.gateway.receive(said("c1", "udah pesen tiket belum?", AT + 1_000, { senderName: "Jordan" }));
    h.gateway.receive(said("c2", "belum", AT + 2_000, { senderName: "Ani" }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(0);
    expect(h.gateway.sent).toHaveLength(0);
    expect(h.pipeline.groupContextRooms()).toBe(1);
  });

  test("someone the daemon has never paired with is still overheard", async () => {
    /**
     * The placement decision, pinned.
     *
     * Capture runs before `admit`, which in its default `pair` mode drops everyone the operator has
     * not approved — in a group of friends, everyone. Captured after it, the buffer would fill only
     * with paired senders' messages: the feature would look wired up and hold nothing.
     *
     * What keeps that safe is that overhearing is not obeying, which the assertions below state: the
     * stranger drew no reply and started no turn, and their words reached the model only on a turn an
     * admitted sender started.
     */
    const h = await harness({
      turns: [{ text: "answered" }],
      configOverrides: {
        ...inAGroup,
        security: { access: { mode: "pair", allowlist: ["user-1"] } },
      },
    });

    h.gateway.receive(
      said("c1", "gw baru dari Bandung", AT + 1_000, {
        senderId: "stranger-9",
        senderName: "Rangga",
      }),
    );
    await h.pipeline.idle();

    // The stranger got nothing: no turn, no reply, not even a pairing code (this is a channel).
    expect(h.requests).toHaveLength(0);
    expect(h.gateway.sent).toHaveLength(0);

    h.gateway.receive(said("t1", "siapa tuh?", AT + 2_000, { mentions: ["nouva"] }));
    await h.pipeline.idle();

    expect(question(h)).toContain("Rangga: gw baru dari Bandung");
  });

  test("one message delivered to every bot in the room is replayed once", async () => {
    // Six agents in one Discord channel means the platform hands each message to six connections
    // within milliseconds of each other. Counted per delivery, three lines of chatter fill the window
    // with the same three lines repeated six times.
    const h = await harness({
      turns: [{ text: "answered" }],
      secondAgent: "nox",
      configOverrides: {
        ...inAGroup,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-main", agent: "nox" },
          },
        },
      },
    });

    const chatter = said("c1", "udah pesen tiket belum?", AT + 1_000, { senderName: "Jordan" });
    h.gateway.receive(chatter);
    h.second.receive({ ...chatter, gatewayId: h.second.id });
    await h.pipeline.idle();

    h.gateway.receive(said("t1", "ini gimana?", AT + 2_000, { mentions: ["nouva"] }));
    await h.pipeline.idle();

    const sent = question(h);
    expect(sent.split("Jordan: udah pesen tiket belum?")).toHaveLength(2);
    expect(h.pipeline.groupContextRooms()).toBe(1);
  });

  test("nothing is replayed to the same agent twice", async () => {
    // The block is stored with the message that carried it, so a window that did not advance would
    // resend the same lines every turn and grow the stored conversation by a copy of them each time.
    const h = await harness({
      turns: [{ text: "first" }, { text: "second" }],
      configOverrides: inAGroup,
    });

    h.gateway.receive(said("c1", "soal tiket tadi", AT + 1_000, { senderName: "Jordan" }));
    h.gateway.receive(said("t1", "ini gimana?", AT + 2_000, { mentions: ["nouva"] }));
    await h.pipeline.idle();

    h.gateway.receive(said("c2", "oh udah dibayar", AT + 3_000, { senderName: "Ani" }));
    h.gateway.receive(said("t2", "jadi aman?", AT + 4_000, { mentions: ["nouva"] }));
    await h.pipeline.idle();

    expect(question(h, 0)).toContain("Jordan: soal tiket tadi");

    const second = question(h, 1);
    expect(second).toContain("Ani: oh udah dibayar");
    // Jordan's line is in the stored history from the first turn, which is where it belongs. What it
    // must not be is in the *new* user message a second time.
    expect(second).not.toContain("Jordan: soal tiket tadi");
  });

  test("the message a tag was replying to is not sent twice", async () => {
    // Reply-and-tag is the ordinary way to ask an agent about something above, and the quote is
    // already prepended to the question. The buffer holds that same message as chatter.
    const h = await harness({ turns: [{ text: "answered" }], configOverrides: inAGroup });

    h.gateway.receive(said("c1", "the build is red", AT + 1_000, { senderName: "Jordan" }));
    h.gateway.receive(
      said("t1", "ini kenapa?", AT + 2_000, {
        mentions: ["nouva"],
        quotedText: "the build is red",
        quotedSender: "Jordan",
        replyTo: "c1",
      }),
    );
    await h.pipeline.idle();

    const sent = question(h);
    expect(sent).toContain("> [Jordan]: the build is red");
    expect(sent.split("the build is red")).toHaveLength(2);
  });

  test("somebody else's bot is not overheard", async () => {
    // The same category `classifyInbound` drops. Applied at capture too, because that runs long
    // before there is a verdict to consult — and a channel with a CI bot in it would otherwise spend
    // the whole window on build notifications.
    const h = await harness({ turns: [{ text: "answered" }], configOverrides: inAGroup });

    h.gateway.receive(said("c1", "soal tiket tadi", AT + 1_000, { senderName: "Jordan" }));
    h.gateway.receive(
      said("c2", "build #4812 failed", AT + 2_000, { senderName: "CI", senderIsBot: true }),
    );
    h.gateway.receive(said("t1", "ini gimana?", AT + 3_000, { mentions: ["nouva"] }));
    await h.pipeline.idle();

    const sent = question(h);
    expect(sent).toContain("Jordan: soal tiket tadi");
    expect(sent).not.toContain("build #4812");
  });

  test("a DM carries no room context", async () => {
    // A DM in its entirety is already the agent's own session, so a block over it would be the
    // conversation restated in front of itself.
    const h = await harness({ turns: [{ text: "answered" }], configOverrides: inAGroup });

    h.gateway.receive(envelope({ id: "d1", text: "halo", timestamp: AT + 1_000 }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "d2", text: "masih di sana?", timestamp: AT + 2_000 }));
    await h.pipeline.idle();

    expect(question(h, 1)).not.toContain("do not answer");
    expect(h.pipeline.groupContextRooms()).toBe(0);
  });

  test("switched off, nothing is kept and nothing is replayed", async () => {
    const h = await harness({
      turns: [{ text: "answered" }],
      configOverrides: { agents: { groups_require_mention: true, group_context_messages: 0 } },
    });

    h.gateway.receive(said("c1", "udah pesen tiket belum?", AT + 1_000, { senderName: "Jordan" }));
    h.gateway.receive(said("t1", "ini gimana?", AT + 2_000, { mentions: ["nouva"] }));
    await h.pipeline.idle();

    expect(question(h)).not.toContain("Jordan");
    // Off means nothing is held either — a buffer that fills while the setting is 0 is a record of a
    // room the operator asked the daemon not to keep.
    expect(h.pipeline.groupContextRooms()).toBe(0);
  });

  test("a connection can switch it off while the daemon leaves it on", async () => {
    // The per-connection override, through the real loader. This is the form the dashboard writes.
    const h = await harness({
      turns: [{ text: "answered" }],
      configOverrides: {
        agents: { groups_require_mention: true, group_context_messages: 20 },
        gateways: {
          telegram: {
            main: { enabled: false, token: "telegram-main", agent: "nouva", group_context_messages: 0 },
          },
        },
      },
    });

    h.gateway.receive(said("c1", "udah pesen tiket belum?", AT + 1_000, { senderName: "Jordan" }));
    h.gateway.receive(said("t1", "ini gimana?", AT + 2_000, { mentions: ["nouva"] }));
    await h.pipeline.idle();

    expect(question(h)).not.toContain("Jordan");
  });

  test("only as many messages as the window allows", async () => {
    const h = await harness({
      turns: [{ text: "answered" }],
      configOverrides: { agents: { groups_require_mention: true, group_context_messages: 2 } },
    });

    for (let index = 0; index < 5; index += 1) {
      h.gateway.receive(said(`c${index}`, `line ${index}`, AT + 1_000 + index, { senderName: "Jordan" }));
    }
    h.gateway.receive(said("t1", "ini gimana?", AT + 9_000, { mentions: ["nouva"] }));
    await h.pipeline.idle();

    const sent = question(h);
    expect(sent).toContain("line 3");
    expect(sent).toContain("line 4");
    expect(sent).not.toContain("line 2");
  });
});

/**
 * Being tagged with no words at all.
 *
 * `@Nouva` on its own is how a person points at the message above, and it is the most common way
 * anyone addresses a bot in a busy channel. On Discord it did nothing: the adapter strips its own tag
 * off the front of the text so the model does not read its own name as every message's first token,
 * which left the text empty, which dropped the envelope on the "no text, no attachments" rule.
 * Observed live, twice, and indistinguishable from the bot being down.
 */
describe("a bare tag", () => {
  // A minute ago: fresh, so the inbox lets the messages through.
  const AT = Date.now() - 60_000;
  const inAGroup = { agents: { groups_require_mention: true } };

  test("starts a turn, with the room replayed as what the tag points at", async () => {
    const h = await harness({ turns: [{ text: "soal tiket ya" }], configOverrides: inAGroup });

    h.gateway.receive(
      envelope({
        id: "c1",
        text: "udah pesen tiket belum?",
        chatType: "group",
        chatId: "group-1",
        timestamp: AT + 1_000,
        senderName: "Jordan",
      }),
    );
    // No text at all — the adapter took the tag off the front and there was nothing behind it.
    h.gateway.receive(
      envelope({
        id: "t1",
        text: "",
        chatType: "group",
        chatId: "group-1",
        timestamp: AT + 2_000,
        mentions: ["nouva"],
        mentionsSelf: true,
      }),
    );
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    const sent = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content as string;
    expect(sent).toContain("Jordan: udah pesen tiket belum?");
    // And the room block's own "do not answer these" is overridden, because here they are all it has.
    expect(sent).toContain("tagged with no words");
    expect(sent).toContain("pointing at the messages above");
    expect(h.gateway.sent[0]?.text).toContain("soal tiket ya");
  });

  test("never sends an empty user message, even with nothing to go on", async () => {
    // A provider rejects empty content, and a model handed it has nothing to act on either. This is
    // the DM case: no room to replay, no words in the message.
    const h = await harness({ turns: [{ text: "halo, ada apa?" }] });

    h.gateway.receive(envelope({ id: "d1", text: "", mentions: ["nouva"], mentionsSelf: true }));
    await h.pipeline.idle();

    const sent = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content as string;
    expect(sent.trim().length).toBeGreaterThan(0);
    expect(sent).toContain("nothing before it to go on");
  });

  test("a tag with a photo and no caption is the photo, not a bare tag", async () => {
    // `attachmentNotice` already describes it, and that description *is* the message. A "you were
    // tagged with no words" note on top would be the harness contradicting itself.
    const h = await harness({ turns: [{ text: "keliatan kok" }] });

    h.gateway.receive(
      envelope({
        id: "d2",
        text: "",
        mentions: ["nouva"],
        mentionsSelf: true,
        attachments: [{ type: "image", url: "https://example.test/x.png", mimeType: "image/png" }],
      }),
    );
    await h.pipeline.idle();

    const sent = conversationOf(h.requests[0]?.messages ?? []).at(-1)?.content as string;
    expect(sent).not.toContain("tagged with no words");
  });
});

/**
 * The three numbers that decide how much room a turn actually has.
 *
 * All three were wrong or unbounded on a live install at the same time, and none of them failed
 * loudly: the window fell back to 32k for a million-token model, the system prompt had no ceiling at
 * all, and one tool result could be four hundred times the window. The visible symptom of all three
 * was the same — an agent that trimmed away its own tool output every iteration and eventually
 * answered nothing.
 */
describe("what a turn is allowed to spend", () => {
  /** The system prompt as it went out, which is the only place the ceiling is observable. */
  const systemPrompt = (h: Harness): string => {
    const first = h.requests[0]?.messages?.[0];
    return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
  };

  test("a persona bigger than its share of the window has sections dropped", async () => {
    // `buildSystemPrompt` has always had a trim order; the executor never passed it a budget, so the
    // loop was skipped and `prompt.trimmed` was always empty. The prompt had no upper bound and a
    // persona that grew took the conversation's room instead of losing its own least-recoverable
    // sections. `unlisted-model-v1` misses the window table on purpose: 32k, so the ceiling is small
    // enough for a test to exceed without writing megabytes.
    const h = await harness({
      turns: [{ text: "answered" }],
      agentConfigToml: '[llm]\nprovider = "test"\nmodel = "unlisted-model-v1"\n',
      agentMemory: `# MEMORY\n${"- a durable fact\n".repeat(6_000)}`,
    });
    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();

    // Identity survives and memory does not: memory can be re-read with a tool, identity cannot be
    // recovered from anywhere. That is what `TRIM_ORDER` encodes.
    expect(systemPrompt(h)).toContain("Nouva");
    expect(systemPrompt(h)).not.toContain("a durable fact");
  });

  test("a pack can declare the window the table does not know", async () => {
    // The escape hatch. Without it, an operator on a renamed model waits for a code change to stop
    // being budgeted at 32k — and the only symptom telling them to is an agent that forgets things.
    const h = await harness({
      turns: [{ text: "answered" }],
      agentConfigToml:
        '[llm]\nprovider = "test"\nmodel = "unlisted-model-v1"\ncontext_window = 1000000\n',
      agentMemory: `# MEMORY\n${"- a durable fact\n".repeat(6_000)}`,
    });
    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();

    // Same persona, same model id, declared window — now it fits and nothing is dropped.
    expect(systemPrompt(h)).toContain("a durable fact");
  });

  test("a pack can raise its own tool budget above the daemon's", async () => {
    /**
     * The per-agent override, seen where it actually matters: the prompt tells the model how many
     * round trips it has, and the loop enforces the same number. A prompt that promised one budget
     * while the loop enforced another would teach the model to plan against a lie.
     */
    const h = await harness({
      turns: [{ text: "answered" }],
      agentConfigToml: '[llm]\nprovider = "test"\nmodel = "test-model"\nmax_tool_iterations = 120\n',
    });
    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();

    expect(systemPrompt(h)).toContain("At most 120 tool round-trips");
  });

  test("a pack's own wall clock reaches the prompt too, in the same sentence", async () => {
    /**
     * The clock was daemon-wide when the round-trip cap already was not, so this sentence could
     * name a per-agent number beside a global one and read as though both were this agent's.
     */
    const h = await harness({
      turns: [{ text: "answered" }],
      agentConfigToml: '[llm]\nprovider = "test"\nmodel = "test-model"\nmax_turn_seconds = 90\n',
    });
    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();

    expect(systemPrompt(h)).toContain("90 seconds of wall clock");
  });

  test("and a pack that names none follows the daemon", async () => {
    const h = await harness({ turns: [{ text: "answered" }] });
    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();

    // 250 is what a fresh install ships with, and what the prompt must say when nothing overrides it.
    expect(systemPrompt(h)).toContain("At most 250 tool round-trips");
    // And 3600, which is the other half of the same sentence — an hour is what a fresh install
    // ships with, so a change to that default has to be seen here rather than discovered live.
    expect(systemPrompt(h)).toContain("3600 seconds of wall clock");
  });

  test("a tool result too big for the context is capped, and the rest is on disk", async () => {
    // The gap that mattered most: `tool_max_output_bytes` is 10MB — about 2.5M tokens — so a single
    // command's output could exceed any window by two orders of magnitude, and the only thing
    // downstream was a trimmer that cannot touch the newest results.
    const huge = Array.from({ length: 40_000 }, (_, i) => `log line ${i}`).join("\n");
    const h = await harness({
      turns: [{ toolCalls: [{ id: "call_1", name: "shout", args: {} }] }, { text: "read it" }],
      autoApprove: true,
      extraTools: new Map<string, Tool>([
        [
          "shout",
          {
            requiresApproval: false,
            definition: {
              name: "shout",
              description: "returns a great deal of text",
              parameters: { type: "object", properties: {} },
            },
            async execute() {
              return { content: huge, isError: false };
            },
          },
        ],
      ]),
      agentConfigToml: '[llm]\nprovider = "test"\n[tools]\nenabled = ["shout"]\n',
    });

    h.gateway.receive(envelope({ text: "run it" }));
    await h.pipeline.idle();

    const toolResult = h.requests[1]?.messages?.find((m: any) => m.role === "tool")?.content as string;
    expect(toolResult).toBeTruthy();
    // Nothing like the whole thing went to the provider.
    expect(toolResult.length).toBeLessThan(huge.length / 10);
    // The two ends the agent can act on, the measured size, and a path it can actually open.
    expect(toolResult).toContain("log line 0");
    expect(toolResult).toContain("log line 39999");
    expect(toolResult).toContain("40000 lines");
    expect(toolResult).toMatch(/Full output: \S+tool-output\S+\.txt/);

    // And the file holds all of it, byte for byte.
    const path = /Full output: (\S+)/.exec(toolResult)?.[1] ?? "";
    expect(await readTextFileIfExists(path)).toBe(huge);
  });

  test("an ordinary tool result is passed through untouched", async () => {
    // Most tool calls return a sentence, and the cap has to cost them nothing — not a wrapper, not a
    // file, not a rephrasing.
    const h = await harness({
      turns: [{ toolCalls: [{ id: "call_1", name: "quiet", args: {} }] }, { text: "ok" }],
      autoApprove: true,
      extraTools: new Map<string, Tool>([
        [
          "quiet",
          {
            requiresApproval: false,
            definition: {
              name: "quiet",
              description: "returns very little",
              parameters: { type: "object", properties: {} },
            },
            async execute() {
              return { content: "done", isError: false };
            },
          },
        ],
      ]),
      agentConfigToml: '[llm]\nprovider = "test"\n[tools]\nenabled = ["quiet"]\n',
    });

    h.gateway.receive(envelope({ text: "run it" }));
    await h.pipeline.idle();

    expect(h.requests[1]?.messages?.find((m: any) => m.role === "tool")?.content).toBe("done");
  });
});

/**
 * Every turn writes down what it did — see `modules/turns/turns.store.ts`.
 *
 * This is the pipeline half of `turn-records.test.ts`. What is proved here is that a *real* turn
 * populates the record, because the store being correct is worth nothing if nothing calls it: the
 * dashboard's steps, timings and streamed reply all read from these rows, and before this they were
 * assembled in a browser and lost on refresh.
 */
describe("a turn records what it did", () => {
  const sessionOf = (chatId = "chat-1") =>
    sessionIdFor({ agentId: "nouva", chatId, gatewayId: "telegram:main" });

  function slowTool(ms: number): Map<string, Tool> {
    return new Map<string, Tool>([
      [
        "slow",
        {
          requiresApproval: false,
          definition: { name: "slow", description: "takes a while", parameters: { type: "object", properties: {} } },
          async execute() {
            await sleep(ms);
            return { content: "done", isError: false };
          },
        },
      ],
    ]);
  }

  const toolTurn = (ms: number) => ({
    turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "finished the long thing" }],
    agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n',
    extraTools: slowTool(ms),
  });

  test("is readable while it is still running, with the step it is on", async () => {
    // The bug this ends: a page that reloaded mid-turn had no way to find the turn it had started, so
    // it re-sent the message. Nothing about that is fixable in the client — the turn was nowhere.
    const h = await harness(toolTurn(300));

    h.gateway.receive(envelope({ text: "do the slow thing" }));
    await sleep(120);

    const live = h.turns.latestForSession(sessionOf());
    expect(live?.status).toBe("running");
    expect(live?.prompt).toBe("do the slow thing");
    expect(h.turns.stepsSince(live!.id, 0).some((s) => s.text.startsWith("slow"))).toBe(true);

    await h.pipeline.idle();
    expect(h.turns.get(live!.id)?.status).toBe("done");
  });

  test("keeps the reply, the tool count and a real duration", async () => {
    const h = await harness(toolTurn(20));

    h.gateway.receive(envelope({ text: "do the slow thing" }));
    await h.pipeline.idle();

    const [view] = h.turns.forSession(sessionOf());
    expect(view?.status).toBe("done");
    expect(view?.reply).toBe("finished the long thing");
    expect(view?.toolCalls).toBe(1);
    expect(view?.model).toBe("test-model");
    // Not the client's stopwatch, which is what produced `1s` for every turn ever reloaded.
    expect(view!.endedAt! - view!.startedAt).toBeGreaterThan(0);
    // The tool call, in order, kept: `tool` when it started and `tool_done` when it ended.
    expect(view?.steps.map((s) => s.kind)).toContain("tool");
    expect(view?.steps.map((s) => s.kind)).toContain("tool_done");
  });

  test("records how many model round trips it took", async () => {
    /**
     * The number that decides what a turn cost, and the one nothing was recording.
     *
     * Two provider calls here: one that asks for a tool, one that answers. Five tool calls in one
     * round trip and five in five are the same work at very different prices — measured on the live
     * box as 63k input tokens against 151k — so this is the figure the step pill shows.
     */
    const h = await harness(toolTurn(20));

    h.gateway.receive(envelope({ text: "do the slow thing" }));
    await h.pipeline.idle();

    const [view] = h.turns.forSession(sessionOf());
    expect(view?.iterations).toBe(2);
    expect(view?.toolCalls).toBe(1);
  });

  test("the answer is written down as it streams, not only at the end", async () => {
    // The dashboard shows a reply being typed because the record grows. Nothing is sent to a chat
    // platform per delta — see `ExecutorDeps.onText`.
    const h = await harness({ turns: [{ text: "streamed answer" }] });

    h.gateway.receive(envelope({ text: "say something" }));
    await h.pipeline.idle();

    expect(h.turns.forSession(sessionOf())[0]?.reply).toBe("streamed answer");
  });

  test("a slash command is recorded too, so the transcript has no hole in it", async () => {
    const h = await harness({ turns: [{ text: "unused" }] });

    h.gateway.receive(envelope({ text: "/status" }));
    await h.pipeline.idle();

    const [view] = h.turns.forSession(sessionOf());
    expect(view?.prompt).toBe("/status");
    expect(view?.reply.length).toBeGreaterThan(0);
    // No provider call, so no steps and no model — the record says so rather than inventing either.
    expect(view?.steps).toEqual([]);
    expect(view?.toolCalls).toBe(0);
  });

  test("a stopped turn is recorded as cancelled, not as a failure", async () => {
    const h = await harness(toolTurn(400));

    h.gateway.receive(envelope({ text: "do the slow thing" }));
    await sleep(100);
    expect(h.pipeline.cancelTurnsInChat("telegram:main", "chat-1")).toBe(1);
    await h.pipeline.idle();

    // `failed` would put a turn somebody deliberately killed next to a turn that broke, and an
    // operator scanning for the second one has to be able to skip the first.
    expect(h.turns.forSession(sessionOf())[0]?.status).toBe("cancelled");
  });

  test("the conversation reports itself as running, then stops", async () => {
    // What draws the spinner in the session list. Derived from the rows, so it is true for a turn
    // started by another tab, by Telegram, or by a background job finishing.
    const h = await harness(toolTurn(250));

    h.gateway.receive(envelope({ text: "do the slow thing" }));
    await sleep(100);
    expect(h.turns.runningSessions().has(sessionOf())).toBe(true);

    await h.pipeline.idle();
    expect(h.turns.runningSessions().has(sessionOf())).toBe(false);
  });
});

/**
 * Work that outlives the turn that started it — from the chat's point of view.
 *
 * A background job answers immediately and reports back minutes later, by waking its agent with a
 * message the daemon wrote. That wake-up is a real turn and is recorded like one; what has to hold is
 * that it is not recorded as something the *operator* said. The dashboard draws a record's prompt as
 * the question, so an unmarked wake-up appears as the person asking about a job they never mentioned.
 */
describe("a background job reporting in", () => {
  const completion = (over: Partial<JobRecord> = {}) => ({
    job: {
      id: "job_1",
      agentId: "nouva",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      command: "bun test",
      cwd: "/w",
      status: "succeeded" as const,
      pid: null,
      exitCode: 0,
      logPath: "/w/job_1.log",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now(),
      onComplete: null,
      kind: "command" as const, brief: null, ask: null, report: null, turnId: null, senderId: null,
      ...over,
    },
    tail: "42 pass, 0 fail",
  });

  const sessionId = () =>
    sessionIdFor({ agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" });

  test("is a recorded turn, marked as the daemon's own doing", async () => {
    const h = await harness({ turns: [{ text: "the build passed — 42 tests, no failures" }] });

    h.pipeline.wakeForJob(completion());
    await h.pipeline.idle();

    const [view] = h.turns.forSession(sessionId());
    expect(view?.status).toBe("done");
    expect(view?.reply).toContain("42 tests");
    // What the payload marks `system: true` from. Without it the wake-up text is drawn as the
    // operator's message.
    expect(view?.senderId).toBe(SYSTEM_SENDER);
    expect(toTurnPayload(view!).system).toBe(true);
    // And it is the harness's words in the prompt, not a person's.
    expect(view?.prompt).toContain("bun test");
  });

  test("a failed job reaches the chat even when the agent never mentions it", async () => {
    /**
     * The test that would have caught it. Twice the prompt asked the model to report a failure, and
     * twice the live answer was an unrelated progress line — the second time with the instruction
     * plainly in front of it.
     *
     * So this asserts the guarantee rather than the request: whatever the model says, the person is
     * told. The scripted reply below is the exact shape of the answer that hid the failure.
     */
    const h = await harness({
      turns: [{ text: "Lagi ngejalanin test voice cloning, gw kabarin hasilnya begitu selesai." }],
    });

    h.pipeline.wakeForJob(completion({ status: "failed", exitCode: 1 }));
    await h.pipeline.idle();

    // The agent said nothing about it, exactly as it did live.
    expect(h.gateway.lastText()).not.toMatch(/fail|gagal/i);
    // And the failure is in the conversation anyway, with the exit code and the command.
    const posted = h.notices.chat.map((notice) => notice.text).join("\n");
    expect(posted).toContain("failed with exit code 1");
    expect(posted).toContain("bun test");
  });

  test("the report survives a turn that starts a job of its own", async () => {
    /**
     * The bug that three rewordings of the opening prompt could not reach.
     *
     * Starting a background job returns `finishTurn: "background_started"`, and the executor then makes
     * one final call with `wrapUpPrompt` appended — "confirm what is now running in the background…
     * say you will follow up when it finishes". Written at the *tail*, it replaced a reporting
     * instruction sitting hundreds of tool-result tokens back, and the measurement on a live box was
     * 17 failures out of 18 announced as fresh progress. The one exception called no tools.
     *
     * So the requirement is delivered at the tail as well. Both instructions are kept — one asks what
     * finished, the other what is now running, and the person needs both.
     */
    const launch: [string, Tool] = [
      "launch",
      {
        requiresApproval: false,
        definition: {
          name: "launch",
          description: "starts something in the background",
          parameters: { type: "object", properties: {} },
        },
        async execute() {
          return {
            content: "job started",
            isError: false,
            metadata: { control: { finishTurn: "wrap_up", note: "background_started" } },
          };
        },
      },
    ];

    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "launch", args: {} }] },
        { text: "gagal karena X, jadi gw jalanin Y — sekarang Y lagi jalan" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["launch"]\n',
      extraTools: new Map<string, Tool>([launch]),
    });

    h.pipeline.wakeForJob(completion({ status: "failed", exitCode: 1 }));
    await h.pipeline.idle();

    // The wake-up's own message: what follows it is who is speaking (`conversationOf`).
    const last = conversationOf(h.requests.at(-1)!.messages as any[]).at(-1);
    expect(last.role).toBe("user");

    // Both are there.
    expect(last.content).toContain("running in the background");
    expect(last.content).toContain("WHY it failed");
    // And the owed report is last, which is the position that decides this.
    expect(last.content.indexOf("running in the background")).toBeLessThan(
      last.content.indexOf("WHY it failed"),
    );
    expect(last.content).toContain("takes precedence");
  });

  test("and survives a turn that answers without starting anything", async () => {
    /**
     * The other shape, and the one `wrapUp` does not cover. A wake-up that reads a file and then
     * simply answers never reaches `wrapUp`, so the requirement would only have been in the opening
     * prompt — the position that already lost 17 times out of 18.
     *
     * So it is re-stated at the tail of every round, appended to the last tool result. What is asserted
     * is that it is *there*, after the tool output, in the request the answer is generated from.
     */
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "read", args: { path: "/etc/hostname" } }] },
        { text: "gagal karena file config-nya gak ada — gw bikin dulu" },
      ],
    });

    h.pipeline.wakeForJob(completion({ status: "failed", exitCode: 1 }));
    await h.pipeline.idle();

    const messages = h.requests.at(-1)!.messages as any[];
    const toolResult = messages.filter((m) => m.role === "tool").at(-1);
    expect(toolResult.content).toContain("[harness]");
    expect(toolResult.content).toContain("WHY it failed");

    // Once, not once per round: a note re-appended every iteration would grow the context it rides on.
    expect(toolResult.content.match(/\[harness\]/g)).toHaveLength(1);
  });

  test("a turn started by a person owes nothing at the end", async () => {
    // The requirement rides on a synthesized wake-up only. An ordinary question that happens to start
    // a background job must still get the plain confirmation, with no report bolted onto it.
    const h = await harness({ turns: [{ text: "ok" }] });

    h.gateway.receive(envelope({ text: "build it" }));
    await h.pipeline.idle();

    const sent = h.requests.map((r) => JSON.stringify(r.messages)).join("");
    expect(sent).not.toContain("takes precedence");
  });

  test("the notice waits for its own turn instead of jumping the queue", async () => {
    /**
     * The first version of this sent the notice the moment the job finished, from `wakeForJob`. The
     * wake-up it belongs to goes through the queue, so on a busy chat the two came apart: watched
     * live, the ⚠️ line landed at 22:06 and the turn explaining it began at 22:07:56, with the answer
     * to an unrelated question sitting between them.
     *
     * A failure notice eighty seconds from its own explanation is not a report. So it rides on the
     * envelope and the turn posts it — later, and next to the thing that makes sense of it.
     */
    const h = await harness({ turns: [{ text: "gagal karena X, gw benerin dulu" }] });

    h.pipeline.wakeForJob(completion({ status: "failed", exitCode: 1 }));
    // Nothing yet. This is the assertion that fails if it is ever sent from the wake again.
    expect(h.notices.chat).toEqual([]);

    await h.pipeline.idle();

    const notice = h.notices.chat.find((entry) => entry.text.includes("failed with exit code"));
    expect(notice).toBeDefined();
    // And it went out before anything else reached the chat: before the reply, before the progress
    // bubble. It is what both of those are about.
    expect(notice?.sentCount).toBe(0);
  });

  test("a successful job posts no notice — that is what the agent's report is for", async () => {
    // A line per finished job is the noise that gets a channel muted, and success is not news the
    // daemon has to guarantee.
    const h = await harness({ turns: [{ text: "done" }] });

    h.pipeline.wakeForJob(completion());
    await h.pipeline.idle();

    expect(h.notices.chat.map((n) => n.text).join("\n")).not.toContain("Background job");
  });

  test("on a summary-style platform the closing line comes before the answer", async () => {
    /**
     * Wired at the reply, not in the `finally` block, and this is the test for the wiring rather than
     * for the class.
     *
     * It went out under the reply the first time — `[nouva] ✓ 1 step · 17s` beneath a finished answer,
     * reading as a footnote to it. `finish` runs in `finally`, which is harmless for a live bubble
     * created on the first tool and already sitting above, and wrong for a line that does not exist
     * until then.
     *
     * Removing `beforeAnswer` from `turn.ts` was caught by nothing, so: this.
     */
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "read", args: { path: "/etc/hostname" } }] },
        { text: "isinya nama host lu" },
      ],
      progressIntervalMs: 1,
    });
    h.gateway.progressStyle = "summary";

    h.gateway.receive(envelope({ text: "isi /etc/hostname apa?" }));
    await h.pipeline.idle();

    const texts = h.gateway.sent.map((m) => m.text ?? "");
    const summary = texts.findIndex((text) => text.includes("step"));
    const answer = texts.findIndex((text) => text.includes("nama host"));

    expect(summary).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(summary).toBeLessThan(answer);
    // One line, not a bubble per step: the quiet platform stays quiet while the turn runs.
    expect(texts.filter((text) => text.includes("⏳"))).toEqual([]);
  });

  test("an ordinary turn is not marked that way", async () => {
    const h = await harness({ turns: [{ text: "hello" }] });

    h.gateway.receive(envelope({ text: "hi" }));
    await h.pipeline.idle();

    expect(toTurnPayload(h.turns.forSession(sessionId())[0]!).system).toBeUndefined();
  });

  test("a job that was interrupted by a restart still reports, and is still marked", async () => {
    // The path added when interrupted jobs were found to fix their own row and tell nobody.
    const h = await harness({ turns: [{ text: "that build died with the daemon" }] });

    h.pipeline.wakeForJob(completion({ status: "interrupted", exitCode: null }));
    await h.pipeline.idle();

    const [view] = h.turns.forSession(sessionId());
    expect(toTurnPayload(view!).system).toBe(true);
    expect(view?.prompt).toMatch(/interrupted/i);
  });
});

/**
 * Whether the agent is told who is talking, in a one-to-one chat.
 *
 * The rule is not "DMs get no name" — it is "a name nobody checked gets no standing". A dashboard
 * message carries an account this daemon authenticated, and withholding *that* left the agent knowing
 * nothing about the person sitting in its own UI while `USER.md` in the same prompt described somebody
 * else with total confidence.
 */
describe("a verified sender", () => {
  // What the agent is told about who is speaking: the system prompt, and the tail after the conversation, where it is said.
  const systemPrompt = (h: Harness) => `${String(h.requests[0]?.messages?.[0]?.content ?? "")}\n\n${String(h.requests[0]?.messages?.at(-1)?.content ?? "")}`;

  test("is named to the model even in a one-to-one chat", async () => {
    const h = await harness({ turns: [{ text: "hi Gading" }] });

    h.gateway.receive(
      envelope({ text: "who am i?", chatType: "dm", senderName: "Gading", senderVerified: true }),
    );
    await h.pipeline.idle();

    expect(systemPrompt(h)).toContain("Gading");
    expect(systemPrompt(h)).toContain("signed in");
  });

  test("and an unverified one is still withheld there", async () => {
    // A platform display name in a DM is a string the sender chose, with nobody else in the room to
    // need it. It stays out.
    const h = await harness({ turns: [{ text: "hello" }] });

    h.gateway.receive(envelope({ text: "who am i?", chatType: "dm", senderName: "Definitely Gading" }));
    await h.pipeline.idle();

    expect(systemPrompt(h)).not.toContain("Definitely Gading");
  });

  test("the id the agent is told to record is the platform-qualified one", async () => {
    /**
     * End-to-end through `prepare.ts`, because the two id forms are computed there and the prompt only
     * renders what it is handed. The connection-qualified form would teach the daemon a name that
     * stops working the moment the person tags a different one of our bots.
     */
    const h = await harness({
      turns: [{ text: "hello" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["nouride"]\n',
      // A stand-in for the CLI tool: the instruction is gated on the agent actually holding it, and
      // the bench does not build the real one (it needs a live control API).
      extraTools: new Map<string, Tool>([
        [
          "nouride",
          {
            requiresApproval: false,
            definition: {
              name: "nouride",
              description: "this daemon's CLI",
              parameters: { type: "object", properties: {} },
            },
            async execute() {
              return { content: "ok", isError: false };
            },
          },
        ],
      ]),
      configOverrides: {
        ...PROVIDER_TOML,
        people: [{ ids: ["telegram:999"], name: "Somebody Else" }],
      },
    });

    h.gateway.receive(envelope({ text: "hi", chatType: "group", senderId: "5550001111" }));
    await h.pipeline.idle();

    const prompt = systemPrompt(h);
    expect(prompt).toContain("nouride people set telegram:5550001111 --name");
    expect(prompt).not.toContain("telegram:main:5550001111 --name");
  });

  test("an unverified name still reaches a group, as before", async () => {
    const h = await harness({ turns: [{ text: "hello" }] });

    h.gateway.receive(envelope({ text: "hi", chatType: "group", senderName: "Sam" }));
    await h.pipeline.idle();

    expect(systemPrompt(h)).toContain("Sam");
  });
});

describe("memory, end to end", () => {
  test("a conversation is cut, filed by the nightly pass, and recalled in the next one — on another agent too", async () => {
    const h = await harness({
      memory: true,
      turns: [{ text: "Dicatat." }, { text: "Sebelum tanggal 20." }],
      configOverrides: {
        memory: { pass: true, facts: "auto" },
        people: [{ ids: ["telegram:user-1"], name: "Gading", key: "gading" }],
      },
    });

    // 1. The owner says something worth keeping, then ends the conversation.
    h.gateway.receive(envelope({ id: "m1", text: "Aku mau liburan ke Bali Desember, sebelum tanggal 20." }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", text: "/new" }));
    await h.pipeline.idle();
    const memory = h.memory!;
    const [raw] = memory.episodes({}, 10);
    // Who it was with comes from the turns the pipeline recorded, named the way memory names people.
    expect(raw).toMatchObject({ status: "raw", participants: ["gading"] });

    // 2. The nightly pass files it.
    const report = await memory.pass(async () =>
      JSON.stringify({
        summary: "Gading is planning a holiday to Bali in December, before the 20th.",
        tags: ["holiday", "bali"],
        importance: 4,
        facts: [{ person: "gading", op: "add", section: "Plans", text: "Going on holiday to Bali in December, before the 20th." }],
      }),
    );
    expect(report).toMatchObject({ filed: 1, applied: 1, failed: [] });
    const profile = await memory.readDocument("gading");
    expect("content" in profile && profile.content).toContain(`- Going on holiday to Bali in December, before the 20th. ([[${raw!.id}]]) {gading}`);

    // 3. The next conversation starts knowing it: the fact, and the summary.
    h.gateway.receive(envelope({ id: "m3", text: "Kapan aku ke Bali?" }));
    await h.pipeline.idle();
    const prompt = JSON.stringify(h.requests[h.requests.length - 1]);
    expect(prompt).toContain("RECALL");
    expect(prompt).toContain("Going on holiday to Bali in December, before the 20th.");
    expect(prompt).toContain("Gading is planning a holiday to Bali");
    expect(prompt).toContain('"name":"memory_search"');
    expect(h.gateway.lastText()).toContain("Sebelum tanggal 20.");
  });
});

/**
 * The turn's id on what it did (D2): its model calls in `llm_usage`, and the context every tool call is handed —
 * which is where the `tool_exec` audit row and a helper's or peer's usage take it from.
 */
describe("a turn's id", () => {
  test("is on every model call it made, and in the context of every tool it ran", async () => {
    const handed: (string | undefined)[] = [];
    const h = await harness({
      turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "done" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe"]\n',
      usage: true,
      extraTools: new Map<string, Tool>([
        [
          "probe",
          {
            requiresApproval: false,
            definition: { name: "probe", description: "notes what it was handed", parameters: { type: "object", properties: {} } },
            async execute(_args, ctx) {
              handed.push(ctx.turnId);
              return { content: "ok", isError: false };
            },
          },
        ],
      ]),
    });

    h.gateway.receive(envelope({ text: "probe it" }));
    await h.pipeline.idle();

    const turnId = h.db.prepare<{ id: string }>("SELECT id FROM turn_records").get()!.id;
    const calls = h.db.prepare<{ turn_id: string | null; attempts: number | null }>("SELECT turn_id, attempts FROM llm_usage").all();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.turn_id === turnId)).toBe(true);
    expect(calls.every((call) => call.attempts === 1)).toBe(true);
    expect(handed).toEqual([turnId]);
  });

  test("a helper's model calls are charged to the turn that delegated — its agent's, under that turn's id", async () => {
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [{ goal: "look", context: "a test", deliverable: "what you found" }] } }] },
        { text: "looked" },
        { text: "done" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["delegate"]\n',
      usage: true,
    });

    h.gateway.receive(envelope({ text: "delegate it" }));
    await h.pipeline.idle();

    const turnId = h.db.prepare<{ id: string }>("SELECT id FROM turn_records").get()!.id;
    const calls = h.db.prepare<{ turn_id: string | null }>("SELECT turn_id FROM llm_usage ORDER BY timestamp").all();
    // The lead's two calls and the helper's one, all of them this turn's cost.
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.turn_id)).toEqual([turnId, turnId, turnId]);
  });

  test("and a peer's, asked with ask_agent — under the asking turn's id, with the peer's own name on them", async () => {
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c1", name: "ask_agent", args: { agent: "nox", task: "benerin build" } }] },
        { text: "build gw benerin, PR #12" },
        { text: "udah kelar — PR #12" },
      ],
      secondAgent: "nox",
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-second", agent: "nox" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
      usage: true,
    });

    h.gateway.receive(envelope({ chatType: "dm", text: "tolong benerin build" }));
    await h.pipeline.idle();

    const turnId = h.db.prepare<{ id: string }>("SELECT id FROM turn_records WHERE agent_id = 'nouva'").get()!.id;
    const calls = h.db.prepare<{ agent_id: string; turn_id: string | null }>("SELECT agent_id, turn_id FROM llm_usage ORDER BY timestamp").all();
    expect(calls.map((call) => call.agent_id)).toEqual(["nouva", "nox", "nouva"]);
    expect(calls.every((call) => call.turn_id === turnId)).toBe(true);
  });

  test("the daemon's own event runs the one agent it names, whatever `@name` its text quotes (nouride-releases#10)", async () => {
    // Nox shares Nouva's Telegram connection, so a person's `@nouva @nox` runs both — and a job wake's text, which
    // quotes a log and once addressed the job's own agent, ran Nox as well from a wake meant for Nouva (found live).
    const shared = {
      ...PROVIDER_TOML,
      daemon: { orchestrator: "nouva" },
      gateways: { telegram: { main: { enabled: true, token: "telegram-main", agent: "nouva" } } },
    };
    const person = await harness({ turns: [{ text: "a" }, { text: "b" }], secondAgent: "nox", configOverrides: shared });
    person.gateway.receive(envelope({ id: "p1", chatType: "group", text: "@nouva @nox tolong cek" }));
    await person.pipeline.idle();
    expect(person.requests).toHaveLength(2);

    const h = await harness({ turns: [{ text: "a" }, { text: "b" }], secondAgent: "nox", configOverrides: shared });
    h.gateway.receive(envelope({
      id: "w1",
      chatType: "group",
      senderId: SYSTEM_SENDER,
      mentions: ["nouva"],
      text: "@nouva\nBackground job job_7 finished. Last output:\n@nox build ok",
      raw: { via: "job completion", job: "job_7", outcome: "finished" },
    }));
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(1);
    expect(h.db.prepare<{ agent_id: string }>("SELECT agent_id FROM turn_records").all().map((row) => row.agent_id)).toEqual(["nouva"]);
  });

  test("a turn a finished job woke is recorded with why — the job and how it ended", async () => {
    const h = await harness({ turns: [{ text: "the build failed on lint" }] });
    h.gateway.receive(envelope({ senderId: SYSTEM_SENDER, text: "Background job job_7 failed with exit code 2", raw: { via: "job completion", job: "job_7", outcome: "failed" } }));
    await h.pipeline.idle();
    const row = h.db.prepare<{ cause: string | null }>("SELECT cause FROM turn_records").get();
    expect(JSON.parse(row?.cause ?? "null")).toEqual({ via: "job completion", job: "job_7", outcome: "failed" });
  });

  test("a summary paid for is kept when the answer after it is cut short — the next message does not pay for it again", async () => {
    const h = await harness({
      turns: [{ text: "Headline: the earlier part\nWhat was decided." }, { hang: true }],
      // A window the whole stretch fits half of, so it is one summary call and the second request is the answer.
      agentConfigToml: '[llm]\nprovider = "test"\ncontext_window = 1000000\n',
      configOverrides: {
        llm: { defaults: { provider: "test", model: "test-model" }, context: { truncation_strategy: "summary", compact_at_tokens: 16_000 } },
      },
    });
    const long = Array.from({ length: 30 }, (_, n) => [
      { role: "user" as const, content: `question ${n} ${"x".repeat(2_400)}`, timestamp: n },
      { role: "assistant" as const, content: `answer ${n} ${"y".repeat(2_400)}`, timestamp: n },
    ]).flat();
    const first = envelope({ text: "and now?" });
    const key = { agentId: "nouva", gatewayId: first.gatewayId, chatId: first.chatId };
    h.sessions.save(key, long, 40_000);

    h.gateway.receive(first);
    for (let i = 0; i < 200 && h.requests.length < 2; i += 1) await sleep(10);
    expect(h.requests).toHaveLength(2);
    await stopTurns({ pipeline: h.pipeline, pauseMs: 50, abortMs: 1_000 });
    await h.pipeline.idle();

    const kept = h.sessions.load(key).messages;
    expect(kept.length).toBeLessThan(long.length);
    expect(JSON.stringify(kept)).toContain("What was decided.");
  });

  test("`/compact` past today's cap says so, and asks the provider nothing", async () => {
    const h = await harness({
      turns: [{ text: "Headline: x" }],
      configOverrides: { llm: { defaults: { provider: "test", model: "test-model" }, limits: { max_daily_tokens: 1_000 } } },
      usage: true,
    });
    const first = envelope({ text: "/compact" });
    const history = Array.from({ length: 6 }, (_, n) => ({ role: n % 2 ? ("assistant" as const) : ("user" as const), content: `turn ${n}`, timestamp: n }));
    h.sessions.save({ agentId: "nouva", gatewayId: first.gatewayId, chatId: first.chatId }, history, 100);
    h.db.prepare("INSERT INTO llm_usage (id, agent_id, model, provider, input_tokens, output_tokens, timestamp) VALUES ('u1', 'nouva', 'm', 'test', 5000, 0, ?)").run(Date.now());

    h.gateway.receive(first);
    await h.pipeline.idle();

    expect(h.gateway.sent.at(-1)?.text).toStartWith("Not compacting now: Today's usage has reached the 1,000 token cap");
    expect(h.requests).toHaveLength(0);
  });

  test("every call the provider got is a row — the compaction before the answer too, charged to the turn as one", async () => {
    const h = await harness({
      turns: [{ text: "Headline: the earlier part\nWhat was decided." }, { text: "answered" }],
      configOverrides: {
        llm: { defaults: { provider: "test", model: "test-model" }, context: { truncation_strategy: "summary", compact_at_tokens: 16_000 } },
      },
      usage: true,
    });
    // A long conversation already: past the line, so the turn compacts before it answers.
    const long = Array.from({ length: 30 }, (_, n) => [
      { role: "user" as const, content: `question ${n} ${"x".repeat(2_400)}`, timestamp: n },
      { role: "assistant" as const, content: `answer ${n} ${"y".repeat(2_400)}`, timestamp: n },
    ]).flat();
    const first = envelope({ text: "and now?" });
    h.sessions.save({ agentId: "nouva", gatewayId: first.gatewayId, chatId: first.chatId }, long, 40_000);

    h.gateway.receive(first);
    await h.pipeline.idle();

    const turnId = h.db.prepare<{ id: string }>("SELECT id FROM turn_records").get()!.id;
    const rows = h.db.prepare<{ purpose: string | null; turn_id: string | null }>("SELECT purpose, turn_id FROM llm_usage ORDER BY timestamp, rowid").all();
    expect(rows).toHaveLength(h.requests.length);
    expect(rows.map((row) => row.purpose)).toEqual([...Array(h.requests.length - 1).fill("compaction"), "turn"]);
    expect(rows.every((row) => row.turn_id === turnId)).toBe(true);
  });
});

/**
 * A scheduled turn and a person's, in one daemon (P1). The cron turn took no slot and checked no busy guard: a
 * `session: "chat"` job due while a person talked to the agent there overwrote that turn's `ActiveTurn`, and N due
 * jobs were N provider turns beside the ceiling.
 */
describe("a scheduled turn beside a person's", () => {
  const slow = (): Map<string, Tool> =>
    new Map<string, Tool>([
      [
        "slow",
        {
          requiresApproval: false,
          definition: { name: "slow", description: "takes a while", parameters: { type: "object", properties: {} } },
          async execute() {
            await sleep(150);
            return { content: "done", isError: false };
          },
        },
      ],
    ]);
  const job = (chatId: string) =>
    ({
      id: "job_report",
      name: "report",
      agentId: "nouva",
      session: chatId === "chat-1" ? "chat" : "isolated",
      trigger: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "send the daily report" },
      target: { gatewayId: "telegram:main", chatId },
      delivery: { mode: "none" },
      enabled: true,
    }) as unknown as Job;
  const run = (h: Harness, chatId: string) =>
    h.pipeline.cronExecutors().runTurn({
      job: job(chatId),
      session: { gatewayId: "telegram:main", chatId },
      message: "send the daily report",
      signal: new AbortController().signal,
    });

  test("a reply the platform refuses is not delivered, and the run is told why", async () => {
    // Buffered and dropped, a refused reply was a run recorded `success` with its text as the result.
    const h = await harness({ turns: [] });
    const target = { gatewayId: "telegram:main", chatId: "chat-1" };
    expect(await h.pipeline.cronExecutors().deliver(target, "the report")).toEqual({ ok: true });
    h.gateway.failSend = new UndeliverableError("telegram:main", "Forbidden: bot was blocked by the user");
    expect(await h.pipeline.cronExecutors().deliver(target, "the report")).toEqual({ ok: false, reason: "Forbidden: bot was blocked by the user" });
  });

  test("a job whose chat will not take it is reported through the daemon's alert channel", async () => {
    // Its own chat refused the run, so the scheduler reports there no more (`reportFailure`): this is the way it is heard.
    const h = await harness({ turns: [] });
    await h.pipeline.cronExecutors().alert?.("cron_unreachable:job_report", 'Scheduled job "report" failed: Forbidden: bot was blocked by the user');
    expect(h.notices.alerts).toEqual(['Scheduled job "report" failed: Forbidden: bot was blocked by the user']);
  });

  test("a file the platform refuses comes back not delivered, with the platform's words — not as a throw", async () => {
    const h = await harness({ turns: [] });
    h.gateway.failSend = new UndeliverableError("telegram:main", "Forbidden: bot was kicked from the group chat");
    const ctx = { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1", senderId: "op" } as ToolContext;
    const file = { type: "file" as const, buffer: new Uint8Array([1]), mimeType: "application/pdf", filename: "report.pdf", size: 1 };
    expect(await h.pipeline.sendAttachment(ctx, file)).toEqual({ ids: [], delivered: false, refused: "Forbidden: bot was kicked from the group chat" });
  });

  test("is skipped in a chat where its agent is answering a person — not run over them", async () => {
    const h = await harness({
      turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "finished" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n',
      extraTools: slow(),
    });
    h.gateway.receive(envelope({ text: "start the slow thing" }));
    await sleep(30);

    expect(await run(h, "chat-1")).toEqual({ text: "", skipped: "agent busy: nouva was in a turn in that chat" });
    await h.pipeline.idle();
    // The person's turn had both its model calls, and the job none.
    expect(h.requests).toHaveLength(2);
    expect(h.gateway.lastText()).toBe("finished");
  });

  test("stopped at a step by a shutdown, it is interrupted — not an error the scheduler reports as a failure (P11)", async () => {
    const h = await harness({
      turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "never asked" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n',
      extraTools: slow(),
    });

    const report = run(h, "cron:job_report");
    await sleep(30);
    h.pipeline.pause();

    expect(await report).toEqual({ text: "", interrupted: "interrupted by a daemon restart" });
  });

  test("cut off in the middle of a model call by the shutdown's abort, it is interrupted as well — and no provider fault", async () => {
    // Found live: a model answering for twenty seconds never reached a step in the fifteen the shutdown waits, was
    // aborted, and the run was recorded as failed — "The model is not responding right now".
    const providerErrors = new Map<string, number>();
    const h = await harness({ turns: [{ hang: true }], providerErrors });

    const report = run(h, "cron:job_report");
    await sleep(30);
    expect(await stopTurns({ pipeline: h.pipeline, pauseMs: 100, abortMs: 2_000 })).toEqual({ paused: 0, aborted: 1 });

    expect(await report).toEqual({ text: "", interrupted: "interrupted by a daemon restart" });
    expect(providerErrors.get("test") ?? 0).toBe(0);
  });

  test("waits for a slot under max_concurrent_turns, as a chat turn does, then runs", async () => {
    const h = await harness({
      turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "finished" }, { text: "the report" }],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n',
      extraTools: slow(),
      configOverrides: { ...PROVIDER_TOML, queue: { max_concurrent_turns: 1 } },
    });
    h.gateway.receive(envelope({ text: "start the slow thing" }));
    await sleep(30);

    // Another chat, so only the ceiling stands between them: had it run at once it would have taken the person's
    // second scripted answer, and the person the report.
    const report = await run(h, "cron:job_report");
    await h.pipeline.idle();

    expect(report).toEqual({ text: "the report" });
    expect(h.gateway.lastText()).toBe("finished");
  });
});

/**
 * A helper's executor was wired thinner than a peer's (P5): no approval level, so a person on `balanced` was asked again
 * for every write a helper made, and no deadline, so a helper never wrapped up and died on the parent's abort with
 * nothing to hand back.
 */
describe("a delegate helper", () => {
  test("runs under the parent's approval level, and finishes a wrap-up reserve before the parent's deadline", async () => {
    const auto = new AutoApprove({ db: (await import("@nouride/runtime")).openDatabase(":memory:") });
    await (await import("@/db/index.ts")).migrate((auto as never as { options: { db: never } }).options.db);
    auto.enable("telegram:main", "user-1", "user-1");
    const deadlines: (number | undefined)[] = [];
    const h = await harness({
      turns: [
        { toolCalls: [{ id: "c0", name: "probe", args: {} }] },
        { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [{ goal: "write the file", context: "a test", deliverable: "what you found" }] } }] },
        // The helper: a gated write, then the probe, then its summary.
        { toolCalls: [{ id: "c1", name: "write", args: { path: "b.md", content: "x" } }] },
        { toolCalls: [{ id: "c2", name: "probe", args: {} }] },
        { text: "wrote it" },
        { text: "done" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["write", "delegate", "probe"]\napproval_required = ["write"]\n',
      autoApproveStore: auto,
      extraTools: new Map<string, Tool>([
        [
          "probe",
          {
            requiresApproval: false,
            definition: { name: "probe", description: "notes the turn's deadline", parameters: { type: "object", properties: {} } },
            async execute(_args, ctx) {
              deadlines.push(ctx.deadlineAt);
              return { content: "ok", isError: false };
            },
          },
        ],
      ]),
    });

    h.gateway.receive(envelope({ text: "delegate it", senderId: "user-1" }));
    await h.pipeline.idle();

    // Asked of nobody: the person is on `balanced`, and the helper is theirs as much as the turn is.
    expect(JSON.stringify(h.requests)).not.toContain("no approval gate");
    expect(h.gateway.lastText()).toBe("done");
    const [parent, helper] = deadlines;
    expect(parent).toBeDefined();
    expect(helper).toBeDefined();
    // One wrap-up reserve earlier — between 20 s and 60 s — so the parent still has its own to answer in.
    expect(parent! - helper!).toBeGreaterThanOrEqual(20_000);
    expect(parent! - helper!).toBeLessThanOrEqual(60_000);
  });
});

/**
 * A peer resolves its own level, not the asking person's (S14).
 *
 * The peer turn read the caller's person: somebody on `balanced` in their chat with Nouva had it apply to whatever Nox
 * did when Nouva asked — though nobody talked to Nox, and Nox's task was written by Nouva's model. So Nouva, holding
 * no write tool at all, could have a write done unasked by handing it over. A helper is different, and keeps its
 * parent's level (P5): it is the same agent, with the same tools, on an errand of the same turn.
 */
describe("an agent asked by another", () => {
  async function askedToWrite(peerToml: string) {
    const auto = new AutoApprove({ db: (await import("@nouride/runtime")).openDatabase(":memory:") });
    await (await import("@/db/index.ts")).migrate((auto as never as { options: { db: never } }).options.db);
    // The person said "stop asking me" — to Nouva, in this chat.
    auto.enable("telegram:main", "user-1", "user-1");
    const h = await harness({
      turns: [
        // Nouva, who cannot write, hands it over.
        { toolCalls: [{ id: "c1", name: "ask_agent", args: { agent: "nox", task: "write the file" } }] },
        // Nox's turn: a write its pack gates.
        { toolCalls: [{ id: "c2", name: "write", args: { path: "b.md", content: "x" } }] },
        { text: "the write was refused" },
        { text: "done" },
      ],
      agentConfigToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["read"]\n',
      secondAgent: "nox",
      secondAgentConfigToml: peerToml,
      autoApproveStore: auto,
      configOverrides: {
        ...PROVIDER_TOML,
        gateways: {
          telegram: {
            main: { enabled: true, token: "telegram-main", agent: "nouva" },
            second: { enabled: true, token: "telegram-second", agent: "nox" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 4 },
      },
    });
    h.gateway.receive(envelope({ chatType: "dm", text: "write it", senderId: "user-1" }));
    await h.pipeline.idle();
    return h;
  }

  test("asks for what its own pack gates, though the person who asked the caller is on /auto", async () => {
    const h = await askedToWrite('[llm]\nprovider = "test"\n\n[tools]\nenabled = ["write"]\napproval_required = ["write"]\n');
    // Asked, and with no gate wired on this bench, refused: the person's level did not carry over to Nox.
    expect(JSON.stringify(h.requests)).toContain("no approval gate");
    expect(h.gateway.lastText()).toBe("done");
  });

  test("and runs it unasked when its own posture says so — the peer's level is the one that counts", async () => {
    const h = await askedToWrite('[agent]\napprovals = "balanced"\n\n[llm]\nprovider = "test"\n\n[tools]\nenabled = ["write"]\napproval_required = ["write"]\n');
    expect(JSON.stringify(h.requests)).not.toContain("no approval gate");
  });
});
