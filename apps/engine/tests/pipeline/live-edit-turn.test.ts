/**
 * Live edit through the real pipeline: a message written from an automation's page with its draft beside it, the turn
 * told what is open, the agent's `schedule` call with `replaces: "open"`, and the change held for the page with its id
 * on the call's `tool_done`.
 *
 * What each part alone cannot show: that the page's draft reaches the model on the message it came with, that the
 * tool is handed the same draft the turn was told of, that the id on the stream is the one the route answers, and that
 * a conversation is not told the same automation again with every message.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AutomationChange, LiveEdit, OpenPage } from "@nouride/shared";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { automationKind } from "@/modules/cron/open-automation.ts";
import { LiveEdits } from "@/modules/live-edit/index.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { conversationOf, envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

type Body = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
const lastUser = (body: Body) => textOf(conversationOf(body.messages).filter((one) => one.role === "user").at(-1)?.content);

const DRAFT = {
  agentId: "nouva",
  name: "Shop health check",
  start: "scheduled",
  every: "1h",
  payload: { kind: "steps", steps: [{ id: "s1", kind: "command", argv: ["sh", "-lc", "curl -fsS https://shop.test/health"], timeoutMs: 20_000 }, { id: "s2", kind: "agentTurn", message: "Say whether the shop is up.", model: "gemini-3.8-flash" }] },
  target: { gatewayId: "web:dashboard", chatId: "web-1" },
  delivery: { mode: "announce" },
  session: "fresh",
};
const page = (value: unknown = DRAFT): OpenPage => ({ path: "/dashboard/automations/cron_shop", title: "Automations", subject: "Shop health check", liveEdit: { kind: "automation", id: "cron_shop", value } as LiveEdit });
/** The agent's change: the automation whole, its two steps kept by their ids and a third added. */
const CHANGED = {
  name: "Shop health check",
  when: "every 1h",
  steps: [
    { id: "s1", command: "curl -fsS https://shop.test/health" },
    { id: "s2", prompt: "Say whether the shop is up, in one line." },
    { text: "Checked." },
  ],
  replaces: "open",
};

async function bench(turns: Parameters<typeof pipelineBench>[0] extends infer O ? (O extends { turns?: infer T } ? T : never) : never) {
  let liveEdits!: LiveEdits;
  let store!: CronStore;
  const made: Bench = await pipelineBench({
    turns,
    gateway: new FakeGateway("web:dashboard"),
    // `schedule` is the daemon's to give, to an agent that holds a tool at all: this one holds one.
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe"]\napproval_required = []\n',
    deps: ({ db, config }) => {
      store = new CronStore({ db, config: config.cron, timezone: config.daemon.timezone });
      liveEdits = new LiveEdits({ automation: automationKind });
      const scheduleTool = createScheduleTool({ store, timezone: () => config.daemon.timezone, agentExists: (id) => id === "nouva", post: async () => true, chats: () => ({ chats: [], othersGateways: [] }), proposeLiveEdit: (offer) => liveEdits.propose(offer) });
      return { liveEdits, scheduleTool };
    },
  });
  cleanup.push(made.dispose);
  made.pipeline.setTools(new Map([["probe", { requiresApproval: false, definition: { name: "probe", description: "checks one thing", parameters: { type: "object", properties: {} } }, execute: async () => ({ content: "checked", isError: false }) }]]));
  made.pipeline.attach();
  const say = (id: string, text: string, from?: OpenPage) =>
    made.gateway.receive(envelope({ id, gateway: "web", gatewayId: "web:dashboard", chatId: "web-1", senderId: "usr_gading", text, timestamp: Date.now(), ...(from ? { page: from } : {}) }));
  return { made, say, liveEdits: () => liveEdits, store: () => store, requests: () => made.requests as unknown as Body[] };
}

describe("an agent asked to change the automation open on its page", () => {
  test("is told what is open on the message that came from the page, changes it with `schedule`, and the change is held for the page", async () => {
    const h = await bench([{ toolCalls: [{ id: "c1", name: "schedule", args: CHANGED }] }, { text: "I made its answer one line and added a closing message." }]);
    h.say("m1", "make its answer shorter and say when it is done", page());
    await h.made.pipeline.idle();

    // The turn read the draft, in the tool's own words, on the message it came with: after the page's own line.
    const first = lastUser(h.requests()[0]!);
    expect(first).toContain('(Written from the dashboard, with this page open: Automations, "Shop health check", at /dashboard/automations/cron_shop.)');
    expect(first).toContain("(On that page the person has this automation open and is changing it. It is NOT saved:");
    expect(first).toContain('call `schedule` with `replaces: "open"`');
    const said = JSON.parse(/```json\n([\s\S]*?)\n```\)/.exec(first)![1]!);
    expect(said).toEqual({
      name: "Shop health check",
      when: "every 1h",
      steps: [{ id: "s1", command: "curl -fsS https://shop.test/health" }, { id: "s2", prompt: "Say whether the shop is up." }],
    });
    // And the tool it is told to call is one this turn holds.
    expect(h.requests()[0]!.tools?.some((tool) => tool.function.name === "schedule")).toBe(true);

    // The call's result, as the model read it, and its row of the stream with the change's id.
    const answered = textOf(h.requests()[1]!.messages.filter((one) => one.role === "tool").at(-1)?.content);
    expect(answered).toStartWith("Drawn on the page they have open, over what they have there.");
    const session = h.made.sessions.load({ agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" }).id;
    const [turn] = h.made.turns.forSession(session);
    const done = h.made.turns.stepsSince(turn!.id).filter((step) => step.kind === "tool_done");
    expect(done).toHaveLength(1);
    expect(done[0]!.liveEdit).toMatch(/^edit_[0-9a-f]{20}$/);
    expect(done[0]!.page).toBeUndefined();

    // What the page fetches by that id: the automation with the change made, what the tool cannot say still on its step.
    const offer = h.liveEdits().offered(done[0]!.liveEdit!)!;
    expect(offer).toMatchObject({ kind: "automation", target: "cron_shop", by: "nouva", gatewayId: "web:dashboard", chatId: "web-1", senderId: "usr_gading" });
    const change = offer.value as AutomationChange;
    expect(change.payload).toEqual({
      kind: "steps",
      steps: [
        { id: "s1", kind: "command", argv: ["sh", "-lc", "curl -fsS https://shop.test/health"], timeoutMs: 20_000 },
        { id: "s2", kind: "agentTurn", message: "Say whether the shop is up, in one line.", model: "gemini-3.8-flash" },
        { id: "s3", kind: "systemEvent", text: "Checked." },
      ],
    });
    expect("starts" in change).toBe(false);
    // Nothing was made of it.
    expect(h.store().list({ includeDisabled: true })).toEqual([]);
  });

  test("a conversation is told the automation once for each form it takes, not with every message", async () => {
    const h = await bench([{ text: "It checks the shop each hour." }, { text: "Two steps." }, { text: "Three now." }]);
    h.say("m1", "what does it do?", page());
    await h.made.pipeline.idle();
    h.say("m2", "how many steps?", page());
    await h.made.pipeline.idle();
    const longer = { ...DRAFT, payload: { kind: "steps", steps: [...DRAFT.payload.steps, { id: "s3", kind: "systemEvent", text: "Checked." }] } };
    h.say("m3", "and now?", page(longer));
    await h.made.pipeline.idle();

    const [one, two, three] = h.requests().map(lastUser);
    expect(one).toContain("```json");
    // The same draft again: one line, which names the form it was shown in above.
    const print = /\[shown [0-9a-f]{10}\]/.exec(one!)![0];
    expect(two).toContain(`(On that page the person still has this automation open, as it was shown to you above ${print}.`);
    expect(two).not.toContain("```json");
    // Changed on the page since: said whole again.
    expect(three).toContain("```json");
    expect(three).toContain('"text": "Checked."');
    expect(three).not.toContain(print);
  });

  test("a message from a page that holds nothing open, or from a chat app, is told no automation, and its tool holds none", async () => {
    const h = await bench([{ toolCalls: [{ id: "c1", name: "schedule", args: CHANGED }] }, { text: "I could not." }]);
    h.say("m1", "change the one I have open", { path: "/dashboard/skills", title: "Skills" });
    await h.made.pipeline.idle();
    expect(lastUser(h.requests()[0]!)).not.toContain("On that page the person has");
    const refused = textOf(h.requests()[1]!.messages.filter((one) => one.role === "tool").at(-1)?.content);
    expect(refused).toStartWith("Nothing is open on a page to change:");
    expect(h.store().list({ includeDisabled: true })).toEqual([]);
  });
});
