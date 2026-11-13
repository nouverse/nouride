/**
 * Where a scheduled job's results go: the chat it was proposed in, or the one `to` names.
 *
 * Found on a live install. Asked from the dashboard for a news digest on a person's WhatsApp every morning, an agent
 * could only propose a job that reports to the dashboard's chat, so it wrote "send it with `send_message`" into the
 * job's prompt. Each run then looked the chat up again, sent the digest as a message of its own, and reported a second
 * time where it was made. `to` is resolved as `send_message` resolves its own, against the chats of the agent that
 * will run the job, and the card a person turns on says where the results go.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { Tool, ToolContext } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { ProposalCards } from "@/modules/cron/proposal-cards.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { describeAddress, type ReachableChat, type SendTargets } from "@/modules/tools/builtins/send-message.ts";

const here: ReachableChat = { gatewayId: "web:dashboard", chatId: "web-1", platform: "web", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 300 };
const whatsapp: ReachableChat = { gatewayId: "whatsapp:nouva", chatId: "2671@lid", platform: "whatsapp", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 200 };
const family: ReachableChat = { gatewayId: "whatsapp:nouva", chatId: "1203@g.us", platform: "whatsapp", kind: "group", title: "Keluarga Besar", people: [{ name: "Mira" }], lastActive: 100 };
const noxDm: ReachableChat = { gatewayId: "telegram:nox", chatId: "8142", platform: "telegram", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 50 };
/** Each agent's own chats: a result goes out on the connection of the agent that runs the job. */
const CHATS: Record<string, SendTargets> = {
  nouva: { chats: [here, whatsapp, family], othersGateways: ["telegram:nox"] },
  nox: { chats: [noxDm], othersGateways: ["whatsapp:nouva"] },
};
const chats = (agentId: string) => CHATS[agentId] ?? { chats: [], othersGateways: [] };

const DASHBOARD = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1", gateway: "web", senderId: "usr_1", workspaceRoots: [] } as unknown as ToolContext;

let dir = "";
let db: SqliteDb;
let store: CronStore;
let cardsSaid: string[];
let tool: Tool;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "results-elsewhere-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  store = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "Asia/Jakarta" });
  cardsSaid = [];
  const cards = new ProposalCards({
    store,
    notifier: { ask: async (_target, text) => (cardsSaid.push(text(true)), { ids: ["m1"], buttons: true }), settle: async () => true },
    voice: (_agentId, gatewayId) => gatewayId,
    isAdmin: () => false,
    isOwner: () => true,
    when: () => "every day at 07:00",
    // As the daemon wires it: the job's own chat for results, in the words of the agent that runs it.
    results: (job) => (job.delivery.gatewayId && job.delivery.chatId ? describeAddress(chats(job.agentId), { gatewayId: job.delivery.gatewayId, chatId: job.delivery.chatId }) : null),
  });
  tool = createScheduleTool({ store, timezone: () => "Asia/Jakarta", agentExists: (id) => id === "nouva" || id === "nox", post: (job) => cards.post(job), chats });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const propose = (args: Record<string, unknown>) => tool.execute({ name: "Berita pagi", when: "cron 0 7 * * *", prompt: "Write a digest of today's news in Indonesia.", ...args }, DASHBOARD);
const jobs = () => store.list({ includeDisabled: true });

describe("a job's results", () => {
  test("go to the chat `to` names: kept on the job, and said on its card and in the tool's answer, in words", async () => {
    const result = await propose({ to: "whatsapp:nouva:2671@lid" });
    expect(result.isError).toBe(false);
    const job = jobs()[0]!;
    expect(job.delivery).toEqual({ mode: "announce", gatewayId: "whatsapp:nouva", chatId: "2671@lid" });
    // Made here: its card is here, and so is who answers it.
    expect(job.target).toEqual({ gatewayId: "web:dashboard", chatId: "web-1" });
    expect(job.enabled).toBe(false);
    expect(cardsSaid[0]).toContain("Results: sent to the whatsapp one-to-one with Gading, not here");
    expect(result.content).toContain("Each run's result goes to the whatsapp one-to-one with Gading, not here.");
  });

  test("a group by its name, however it is cased", async () => {
    expect((await propose({ to: "keluarga besar" })).isError).toBe(false);
    expect(jobs()[0]!.delivery).toMatchObject({ gatewayId: "whatsapp:nouva", chatId: "1203@g.us" });
    expect(cardsSaid[0]).toContain('Results: sent to the whatsapp group "Keluarga Besar" (Mira), not here');
  });

  test("come here with no `to`, and with a `to` that names this chat: the card says here", async () => {
    await propose({});
    await propose({ name: "Kedua", to: "web:dashboard:web-1" });
    for (const job of jobs()) {
      expect(job.delivery.gatewayId).toBeUndefined();
      expect(job.delivery.chatId).toBeUndefined();
    }
    expect(cardsSaid).toHaveLength(2);
    for (const card of cardsSaid) expect(card).toContain("Results: here");
  });

  test("a person with several chats is not guessed at, and a name that is no chat is refused: nothing is proposed, and the chats are listed", async () => {
    const several = await propose({ to: "gading" });
    expect(several.isError).toBe(true);
    expect(several.content).toStartWith('`to` names no chat its results could go to. "gading" has 2 chats you can reach.');
    expect(several.content).toContain("`whatsapp:nouva:2671@lid`");
    const none = await propose({ to: "kantor" });
    expect(none.content).toStartWith('`to` names no chat its results could go to. No chat you can reach is "kantor".');
    expect(jobs()).toEqual([]);
    expect(cardsSaid).toEqual([]);
  });

  test("for a job another agent runs, `to` is one of that agent's chats: its own connection sends the result", async () => {
    // Nouva's WhatsApp is not Nox's to send through.
    const refused = await propose({ agent: "nox", to: "whatsapp:nouva:2671@lid" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("whatsapp:nouva is another agent's connection");
    expect((await propose({ agent: "nox", to: "telegram:nox:8142" })).isError).toBe(false);
    const job = jobs()[0]!;
    expect(job.agentId).toBe("nox");
    expect(job.delivery).toMatchObject({ gatewayId: "telegram:nox", chatId: "8142" });
    expect(cardsSaid[0]).toContain("Results: sent to the telegram one-to-one with Gading, not here");
  });

  test("with `once`, both are kept", async () => {
    await propose({ to: "whatsapp:nouva:2671@lid", once: true });
    expect(jobs()[0]!.delivery).toEqual({ mode: "announce", once: true, gatewayId: "whatsapp:nouva", chatId: "2671@lid" });
  });

  test("a change that says no `to` keeps where the job it replaces sends; one that says a `to` moves it", async () => {
    await propose({ to: "whatsapp:nouva:2671@lid" });
    const first = jobs()[0]!;
    store.settleProposal(first.id, "Gading");
    store.setEnabled(first.id, true, "Gading");
    cardsSaid = [];

    await propose({ replaces: first.id, when: "cron 0 6 * * *" });
    const sameChat = jobs().find((job) => job.proposal?.replaces === first.id)!;
    expect(sameChat.delivery).toMatchObject({ gatewayId: "whatsapp:nouva", chatId: "2671@lid" });
    expect(cardsSaid[0]).toContain("Results: sent to the whatsapp one-to-one with Gading, not here");
    store.delete(sameChat.id, "t");

    await propose({ replaces: first.id, to: "Keluarga Besar" });
    const moved = jobs().find((job) => job.proposal?.replaces === first.id)!;
    expect(moved.delivery).toMatchObject({ gatewayId: "whatsapp:nouva", chatId: "1203@g.us" });
  });

  test("the tool says it, in the words a model reads: where results go, and that a run needs no send_message for them", () => {
    expect(tool.definition.description).toContain("Each run's result comes to this chat; `to` sends it to another one instead, so no run needs `send_message` for its own result.");
    const fields = tool.definition.parameters.properties as Record<string, { description?: string }>;
    expect(fields.to?.description).toBe("Where each run's result is sent when not here: as `send_message`'s `to`.");
  });
});
