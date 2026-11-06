/**
 * Approve and Deny buttons on an approval's prompt (G11, `modules/tools/approval-prompts.ts`).
 *
 * The prompt carries them where the connection does (`Gateway.buttons`), and Always only where `/approve always` would
 * be honoured; it still says how to answer by command. A press is the command's answer — the same `resolve`, the same
 * rule for who may answer (S8) — and anybody else's press is refused to them alone and changes nothing. Once settled,
 * however it was, the prompt says how and by whom and its buttons go; a press after that — a second one, one after the
 * dashboard or the CLI answered, after it expired, or after a restart — says it is settled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { addLogSink, type ChatType, type Tool } from "@nouride/shared";
import { approvalPrompt, Notifier } from "@/commons/notify.ts";
import { openAndMigrate } from "@/db/index.ts";
import { approvalButtons, approvalPressed, ApprovalPrompts } from "@/modules/tools/approval-prompts.ts";
import { routePresses } from "@/modules/gateways/presses.ts";
import type { ApprovalAsk, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { envelope, eventually, FakeGateway, tempDir } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

let dir: string;
let db: SqliteDb;
const gates: SqliteApprovalGate[] = [];

beforeEach(async () => {
  dir = tempDir("approval-buttons");
  db = await openAndMigrate(join(dir, "test.db"));
});

afterEach(() => {
  for (const gate of gates.splice(0)) gate.shutDown();
  db.close();
  removePath(dir);
});

/** One process's gate and prompts over the test's database, posting through `gateway`, as `index.ts` wires them. */
function process(gateway: FakeGateway, o: { timeoutMs?: number; admins?: string[] } = {}) {
  const gateways = new Map([[gateway.id, gateway]]);
  let gate!: SqliteApprovalGate;
  const prompts = new ApprovalPrompts({
    gateways,
    notifier: new Notifier({ gateways }),
    approvals: () => gate,
    voice: (_agentId, gatewayId) => gatewayId,
    isAdmin: (who) => (o.admins ?? []).includes(who.senderId),
  });
  gate = new SqliteApprovalGate({
    db,
    timeoutMs: o.timeoutMs ?? 60_000,
    onRequest: (notice) => void prompts.post(notice),
    onSettled: (request, settlement) => prompts.settled(request, settlement),
  });
  gates.push(gate);
  routePresses(gateways.values(), [prompts]);
  return { gate, prompts };
}

const ROOM = { gatewayId: "telegram:main", chatId: "room-1" } as const;

function ask(over: Partial<ApprovalAsk> = {}): ApprovalAsk {
  return {
    agentId: "nouva",
    ...ROOM,
    gateway: "telegram",
    senderId: "alice",
    tool: "exec",
    params: { command: ["make", "deploy"] },
    grantable: true,
    autoCoverable: true,
    reason: "first time",
    ...over,
  };
}

/** Asked, and its prompt in the chat: the request's id, the prompt's message id, and the answer the call will get. */
async function asked(gateway: FakeGateway, gate: SqliteApprovalGate, over: Partial<ApprovalAsk> = {}) {
  const before = gateway.sent.length;
  const outcome: Promise<ApprovalOutcome> = gate.request(ask(over));
  await eventually(() => gateway.sent.length > before, 2_000, "the prompt posted");
  const id = gate.pending().at(-1)!.id;
  return { id, messageId: `${gateway.id}#${gateway.sent.length}`, prompt: gateway.sent.at(-1)!, outcome };
}

const press = (gateway: FakeGateway, messageId: string, data: string, senderId: string, chatType: ChatType = "group", chatId: string = ROOM.chatId) =>
  gateway.press({ chatId, chatType, messageId, data, senderId, senderName: senderId[0]!.toUpperCase() + senderId.slice(1) });

const status = (id: string) => db.prepare<{ status: string; resolved_by: string | null; decision: string | null }>("SELECT status, resolved_by, decision FROM approvals WHERE id = ?").get(id)!;

describe("the prompt", () => {
  test("carries Approve, Always and Deny where the connection carries buttons — and still says how to answer by command", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const { id, prompt } = await asked(gateway, gate);

    expect(prompt.buttons?.map((button) => button.label)).toEqual(["Approve", "Always", "Deny"]);
    expect(prompt.buttons?.map((button) => approvalPressed(button.data))).toEqual([
      { id, decision: "allow-once", similar: false },
      { id, decision: "allow-always", similar: false },
      { id, decision: "deny", similar: false },
    ]);
    expect(prompt.text).toContain("Tap a button below");
    expect(prompt.text).toContain("`/approve`");
    expect(prompt.text).toContain("`/deny`");
  });

  test("one of a job's guards offers Always for this job — and that answer is written on the job, not the agent (0.8.0)", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const allowed: unknown[] = [];
    const gateways = new Map([[gateway.id, gateway]]);
    let gate!: SqliteApprovalGate;
    const prompts = new ApprovalPrompts({ gateways, notifier: new Notifier({ gateways }), approvals: () => gate, voice: (_agentId, gatewayId) => gatewayId, isAdmin: () => false });
    gate = new SqliteApprovalGate({
      db,
      timeoutMs: 60_000,
      jobGrants: { allow: (grant, by) => void allowed.push({ grant, by }) },
      onRequest: (notice) => void prompts.post(notice),
      onSettled: (request, settlement) => prompts.settled(request, settlement),
    });
    gates.push(gate);
    routePresses(gateways.values(), [prompts]);
    const jobGrant = { jobId: "cron_1", keys: ["chat:telegram:main:555"], label: "sends a message to the telegram one-to-one with Mira" };
    const { id, prompt, messageId, outcome } = await asked(gateway, gate, { tool: "send_message", grantable: true, jobGrant });

    expect(prompt.buttons?.map((button) => button.label)).toEqual(["Approve", "Always for this job", "Deny"]);
    expect(prompt.text).toContain("**Always for this job** lets this job's runs send there without asking");
    const answer = await press(gateway, messageId, `approval:always:${id}`, "alice");
    expect((await outcome).status).toBe("approved");
    expect(allowed).toEqual([{ grant: jobGrant, by: "alice" }]);
    expect(answer?.notice).toContain("this job's runs send there from now on without asking");
    expect(answer?.settled).toContain("Approved for this job by Alice");
  });

  test("offers no Always where `/approve always` would not be honoured", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const { prompt } = await asked(gateway, gate, { grantable: false });
    expect(prompt.buttons?.map((button) => button.label)).toEqual(["Approve", "Deny"]);
    expect(prompt.text).toContain("cannot be granted permanently");
  });

  test("a connection with no buttons gets the prompt as it was: the text, the commands", async () => {
    const gateway = new FakeGateway("whatsapp:main", "whatsapp");
    const { gate } = process(gateway);
    const { prompt } = await asked(gateway, gate, { gatewayId: "whatsapp:main", gateway: "whatsapp" });
    expect(prompt.buttons).toBeUndefined();
    expect(prompt.text).not.toContain("Tap a button");
    expect(prompt.text).toContain("`/approve` · `/approve always` to stop asking for this exact command · `/deny`");
  });
});

describe("the journal", () => {
  // Live on 0.7.17 a prompt never reached the chat, and the journal said only "approval waiting for a human": the same
  // line a prompt nobody answered leaves. Whether it arrived is a line of its own now.
  const said: { message: string; approval?: unknown }[] = [];
  addLogSink((entry) => void said.push({ message: entry.message, approval: entry.data?.approval }));

  test("says the prompt was sent, by the request's id", async () => {
    const gateway = new FakeGateway("telegram:main");
    const { gate } = process(gateway);
    const { id } = await asked(gateway, gate);
    await eventually(() => said.some((line) => line.message === "approval prompt sent" && line.approval === id), 2_000, "the sent line");
  });

  test("and says so when it could not be: the chat refused it", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), {
      send: async () => {
        throw new Error("bot was blocked by the user");
      },
    });
    const { gate } = process(gateway);
    void gate.request(ask());
    await eventually(() => said.some((line) => line.message.startsWith("approval prompt not delivered")), 2_000, "the not-delivered line");
  });
});

describe("a press", () => {
  test("is /approve's answer: the call runs, the gate records who pressed, and the prompt says so with its buttons gone", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const { id, messageId, outcome } = await asked(gateway, gate);

    const answer = await press(gateway, messageId, `approval:once:${id}`, "alice");
    expect(answer.notice).toBe("Approved.");
    expect(await outcome).toMatchObject({ status: "approved", by: "alice", decision: "allow-once" });
    expect(status(id)).toEqual({ status: "approved", resolved_by: "alice", decision: "allow-once" });
    expect(gateway.settled).toEqual([{ messageId, text: "✅ Approved by Alice: **nouva** may run **exec**\n`make deploy`" }]);
    expect(gateway.sent.at(-1)?.buttons).toBeUndefined();
  });

  test("Always is `/approve always` — a standing grant where one is on offer — and Deny is `/deny`", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const always = await asked(gateway, gate);
    expect((await press(gateway, always.messageId, `approval:always:${always.id}`, "alice")).notice).toContain("won't ask again");
    expect(status(always.id).decision).toBe("allow-always");
    expect(gateway.settled.at(-1)?.text).toContain("Approved for good by Alice");

    const deny = await asked(gateway, gate);
    expect((await press(gateway, deny.messageId, `approval:deny:${deny.id}`, "alice")).notice).toBe("Denied.");
    expect(await deny.outcome).toMatchObject({ status: "denied", by: "alice" });
    expect(gateway.settled.at(-1)?.text).toContain("🚫 Denied by Alice");
  });

  test("in a room, anybody but the person who asked or an admin is refused — to them alone — and nothing changes", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway, { admins: ["operator"] });
    const first = await asked(gateway, gate);

    const refused = await press(gateway, first.messageId, `approval:always:${first.id}`, "bob");
    expect(refused).toEqual({ notice: "Only the person who asked, or an admin, can answer this one." });
    expect(status(first.id).status).toBe("pending");
    expect(gateway.settled).toEqual([]);
    // An admin may.
    expect((await press(gateway, first.messageId, `approval:once:${first.id}`, "operator")).notice).toBe("Approved.");
    expect(status(first.id).resolved_by).toBe("operator");

    // And the person who asked.
    const second = await asked(gateway, gate);
    expect((await press(gateway, second.messageId, `approval:deny:${second.id}`, "alice")).notice).toBe("Denied.");
  });

  test("in a one-to-one chat, the person in it answers", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const dm = await asked(gateway, gate, { chatId: "814", senderId: "814" });
    expect((await press(gateway, dm.messageId, `approval:once:${dm.id}`, "gading", "dm", "814")).notice).toBe("Approved.");
  });

  test("a second press says it is settled and changes nothing", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const { id, messageId } = await asked(gateway, gate);
    await press(gateway, messageId, `approval:once:${id}`, "alice");

    const again = await press(gateway, messageId, `approval:deny:${id}`, "alice");
    expect(again.notice).toBe("Already settled: approved by Alice.");
    expect(again.settled).toContain("✅ Approved by Alice");
    expect(status(id).status).toBe("approved");
    // Whoever presses it now — one who could never have answered it too — is told it is settled, not refused.
    expect((await press(gateway, messageId, `approval:deny:${id}`, "bob")).notice).toBe("Already settled: approved by Alice.");
  });

  test("a request answered while its prompt was being posted has that prompt settled, its buttons gone", async () => {
    let answerAsItPosts: (() => void) | undefined;
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const send = gateway.send.bind(gateway);
    gateway.send = async (message) => {
      const ids = await send(message);
      // The dashboard lists a request at once, and is answered there before the chat's prompt is back.
      answerAsItPosts?.();
      return ids;
    };
    const { gate } = process(gateway);
    answerAsItPosts = () => void gate.resolve(gate.pending().at(-1)!.id, "allow-once", { id: "gading", name: "gading, on the dashboard" });
    expect(await gate.request(ask())).toMatchObject({ status: "approved", by: "gading" });
    await eventually(() => gateway.settled.length === 1, 2_000, "the prompt settled");
    expect(gateway.settled[0]).toEqual({ messageId: `${gateway.id}#1`, text: expect.stringContaining("✅ Approved by gading, on the dashboard") });
    expect(gateway.sent[0]?.buttons).toBeUndefined();
  });

  test("answered elsewhere — the CLI, the dashboard, `/approve` — the prompt says so and loses its buttons; a press after is told", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const { id, messageId } = await asked(gateway, gate);

    expect(gate.resolve(id, "deny", { id: "cli", name: "the operator, from the command line" })).toBe(true);
    await eventually(() => gateway.settled.length === 1, 2_000, "the prompt settled");
    expect(gateway.settled[0]).toEqual({ messageId, text: "🚫 Denied by the operator, from the command line: **nouva** will not run **exec**\n`make deploy`" });

    const late = await press(gateway, messageId, `approval:once:${id}`, "alice");
    expect(late.notice).toBe("Already settled: denied by the operator, from the command line.");
    expect(status(id).status).toBe("denied");
  });

  test("after the request expired, the prompt says nobody answered, and a press says it expired", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway, { timeoutMs: 40 });
    const { id, messageId, outcome } = await asked(gateway, gate);
    expect(await outcome).toMatchObject({ status: "expired" });
    await eventually(() => gateway.settled.length === 1, 2_000, "the prompt settled");
    expect(gateway.settled[0]?.text).toContain("⌛ Nobody answered in time");

    expect((await press(gateway, messageId, `approval:once:${id}`, "alice")).notice).toBe("Already settled: it expired.");
  });

  test("after a restart, a press on the prompt the last process posted answers the request it kept", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const first = process(gateway);
    const { id, messageId } = await asked(gateway, first.gate);
    first.gate.handOver();
    first.gate.shutDown();

    // The next process: the request is kept, with who asked; nothing it posted yet — the old prompt is still in the chat.
    const next = process(gateway);
    expect(next.gate.carryOver().kept.map((request) => request.id)).toEqual([id]);
    const answer = await press(gateway, messageId, `approval:once:${id}`, "alice");
    expect(answer.notice).toBe("Approved.");
    expect(status(id)).toMatchObject({ status: "approved", resolved_by: "alice" });
    expect(gateway.settled.at(-1)).toEqual({ messageId, text: expect.stringContaining("✅ Approved by Alice") });
  });

  test("after a restart that could not keep it, a press says it is no longer waiting", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const first = process(gateway, { timeoutMs: 1_000 });
    const { id, messageId } = await asked(gateway, first.gate);
    first.gate.handOver();
    first.gate.shutDown();

    // Too little of its window left to be kept: the next process expires it as it starts.
    const next = process(gateway, { timeoutMs: 1_000 });
    expect(next.gate.carryOver().lapsed.map((request) => request.id)).toEqual([id]);
    const answer = await press(gateway, messageId, `approval:once:${id}`, "alice");
    expect(answer.notice).toBe("Already settled: it is no longer waiting.");
    expect(answer.settled).toContain("⌛ No longer waiting");
    expect(status(id).status).toBe("expired");
  });

  test("a press from a chat that was not asked is refused, and a button that is not an approval's says so", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const { id, messageId } = await asked(gateway, gate);
    expect((await press(gateway, messageId, `approval:once:${id}`, "alice", "group", "room-2")).notice).toBe("That request was not asked here.");
    expect((await press(gateway, messageId, "approval:maybe:apr_1", "alice")).notice).toBe("That button is not one I know any more.");
    expect((await press(gateway, messageId, "approval:once:apr_00000000000000000000", "alice")).notice).toBe("That request is no longer on record.");
    expect(status(id).status).toBe("pending");
  });
});

describe("through the pipeline, as a turn asks", () => {
  test("the turn waits on its prompt, a press answers it, and the call runs", async () => {
    let runs = 0;
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    let gate!: SqliteApprovalGate;
    let prompts!: ApprovalPrompts;
    const bench = await pipelineBench({
      gateway,
      maxAttempts: 1,
      turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "done" }],
      agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe"]\n',
      config: { security: { approvals: "careful" } },
      deps: ({ db: benchDb, gateways }) => {
        prompts = new ApprovalPrompts({ gateways, notifier: new Notifier({ gateways }), approvals: () => gate, voice: (_agent, gatewayId) => gatewayId, isAdmin: (who) => bench.pipeline.isAdmin(who) });
        gate = new SqliteApprovalGate({ db: benchDb, timeoutMs: 60_000, onRequest: (notice) => void prompts.post(notice), onSettled: (request, settlement) => prompts.settled(request, settlement) });
        return { approvals: gate };
      },
    });
    try {
      const probe: Tool = {
        requiresApproval: true,
        definition: { name: "probe", description: "touches the box", parameters: { type: "object", properties: {} } },
        gate: () => ({ action: "ask", grantable: false, reason: "it touches the box" }),
        execute: async () => ((runs += 1), { content: "probed", isError: false }),
      };
      bench.pipeline.setTools(new Map([["probe", probe]]));
      bench.pipeline.attach();
      routePresses([gateway], [prompts]);
      gateway.receive(envelope({ id: "m1", gatewayId: "telegram:main", chatId: "814", senderId: "814", text: "probe it", timestamp: Date.now() }));
      await eventually(() => gateway.sent.some((message) => message.buttons?.length), 4_000, "the prompt with its buttons");
      const prompt = gateway.sent.findIndex((message) => message.buttons?.length);
      const id = approvalPressed(gateway.sent[prompt]!.buttons![0]!.data)!.id;

      expect((await press(gateway, `telegram:main#${prompt + 1}`, `approval:once:${id}`, "gading", "dm", "814")).notice).toBe("Approved.");
      await bench.pipeline.idle();
      expect(runs).toBe(1);
      expect(gateway.sent.map((message) => message.text)).toContain("done");
    } finally {
      gate.shutDown();
      bench.dispose();
    }
  });
});

describe("the parts, on their own", () => {
  test("what a button carries fits Telegram's 64 bytes, and only an approval's own reads as one", () => {
    const buttons = approvalButtons({ grantable: true, request: { id: "apr_0123456789abcdef0123" } });
    for (const button of buttons) expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64);
    expect(approvalPressed("approval:once:apr_0123456789abcdef0123")).toEqual({ id: "apr_0123456789abcdef0123", decision: "allow-once", similar: false });
    expect(approvalPressed("approval:once:apr_x; DROP")).toBeNull();
    expect(approvalPressed("other:once:apr_1")).toBeNull();
  });

  test("the prompt's words with buttons and without", () => {
    const notice = { request: { id: "apr_1", agentId: "nouva", tool: "exec", params: { command: "ls" } }, grantable: true, reason: "" };
    expect(approvalPrompt(notice, { buttons: true })).toContain("Tap a button below (**Always** stops asking for this exact command)");
    expect(approvalPrompt(notice)).not.toContain("Tap a button");
  });
});
