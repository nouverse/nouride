/**
 * A mission's approval prompt (0.8.7): it names the mission, shows the command once, escapes the free text it carries,
 * puts the id in inline code, and offers *Approve similar from this mission* — whose press lets calls like it through for
 * that mission until it ends, and nowhere else. Gate and prompts as `index.ts` wires them, on a migrated database.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { approvalPrompt, Notifier } from "@/commons/notify.ts";
import { openAndMigrate } from "@/db/index.ts";
import { routePresses } from "@/modules/gateways/presses.ts";
import { reasonFor } from "@/modules/external-agents/permission.ts";
import { similarKind, SimilarAllowed } from "@/modules/missions/similar.ts";
import { ApprovalPrompts } from "@/modules/tools/approval-prompts.ts";
import type { ApprovalAsk, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { eventually, FakeGateway, tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
const gates: SqliteApprovalGate[] = [];

beforeEach(async () => {
  dir = tempDir("approval-mission");
  db = await openAndMigrate(join(dir, "test.db"));
});

afterEach(() => {
  for (const gate of gates.splice(0)) gate.shutDown();
  db.close();
  removePath(dir);
});

const CHAT = { gatewayId: "telegram:main", chatId: "8142" } as const;
const MISSION = "msn_0123456789abcdef";

/** The gate and prompts, with a mission's question routed to its chat and *Approve similar* kept as boot does it. */
function process(gateway: FakeGateway, open = () => true) {
  const gateways = new Map([[gateway.id, gateway]]);
  const similar = new SimilarAllowed();
  const audit = new AuditLog(db);
  let gate!: SqliteApprovalGate;
  const ofMission = (request: { gateway: string; chatId: string }) => request.gateway === "web:mission" && request.chatId === MISSION;
  const prompts = new ApprovalPrompts({
    gateways,
    notifier: new Notifier({ gateways }),
    approvals: () => gate,
    voice: (_agentId, gatewayId) => gatewayId,
    isAdmin: () => false,
    askedIn: (request) => (ofMission(request) ? CHAT : null),
    missionOf: (request) => (ofMission(request) ? { id: MISSION.slice(0, 10), goal: "Ship the *fix* for issue_42\nsecond line" } : null),
    similar: {
      kindOf: (request) => (ofMission(request) ? similarKind(request.tool, request.params)?.split(" ").slice(1).join(" ") ?? null : null),
      allow: (request) => {
        const kind = similarKind(request.tool, request.params);
        if (kind && open()) similar.allow(request.chatId, kind);
      },
    },
  });
  gate = new SqliteApprovalGate({
    db,
    timeoutMs: 60_000,
    audit,
    allowedBefore: (ask) => (ask.gatewayId === "web:mission" && similar.allows(ask.chatId, ask.tool, ask.params) ? "approve similar from this mission" : null),
    onRequest: (notice) => void prompts.post(notice),
    onSettled: (request, settlement) => prompts.settled(request, settlement),
  });
  gates.push(gate);
  routePresses(gateways.values(), [prompts]);
  return { gate, similar, audit };
}

function ask(over: Partial<ApprovalAsk> = {}): ApprovalAsk {
  return {
    agentId: "nix",
    gatewayId: "web:mission",
    chatId: MISSION,
    gateway: "web",
    senderId: "8142",
    tool: "claude-code:Bash",
    params: { command: "bun test ./apps/engine/tests/missions/" },
    grantable: true,
    autoCoverable: false,
    reason: reasonFor("Claude Code", "bun test ./apps/engine/tests/missions/", { command: "bun test ./apps/engine/tests/missions/" }),
    ...over,
  };
}

async function asked(gateway: FakeGateway, gate: SqliteApprovalGate, over: Partial<ApprovalAsk> = {}) {
  const before = gateway.sent.length;
  const outcome: Promise<ApprovalOutcome> = gate.request(ask(over));
  // The prompt, not whatever else the chat was sent meanwhile — a settled prompt's line among them.
  const isPrompt = (text: string) => text.includes("is waiting on you before running");
  await eventually(() => gateway.sent.slice(before).some((message) => isPrompt(message.text)), 2_000, "the prompt posted");
  const at = gateway.sent.findLastIndex((message) => isPrompt(message.text));
  return { id: gate.pending().at(-1)!.id, messageId: `${gateway.id}#${at + 1}`, prompt: gateway.sent[at]!, outcome };
}

describe("a mission's prompt", () => {
  test("names the mission and its goal's first line, shows the command once, and the id as inline code", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const { id, prompt } = await asked(gateway, gate);
    expect(prompt.text).toContain(`waiting on you before running **claude-code:Bash**, from mission ${MISSION.slice(0, 10)} (Ship the \\*fix\\* for issue\\_42).`);
    expect(prompt.text.split("bun test ./apps/engine/tests/missions/").length - 1).toBe(1);
    expect(prompt.text).toContain("Why I am asking: Claude Code asks to run the command above.");
    expect(prompt.text).toContain(`id: \`${id}\``);
    expect(prompt.text).not.toContain(`_id: `);
  });

  test("offers Approve similar, and says which kind it allows", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const { prompt } = await asked(gateway, gate);
    expect(prompt.buttons?.map((button) => button.label)).toEqual(["Approve", "Approve similar from this mission", "Always", "Deny"]);
    expect(prompt.text).toContain("**Approve similar** allows `bun test` commands again for this mission only, until it ends.");
  });

  test("no Approve similar outside a mission, for a command that always asks, or for one with no kind", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate } = process(gateway);
    const labels = async (over: Partial<ApprovalAsk>) => {
      const { id, prompt } = await asked(gateway, gate, over);
      // Read before it is answered: the answer edits the prompt in place, buttons gone.
      const shown = prompt.buttons?.map((button) => button.label) ?? [];
      gate.resolve(id, "deny", "test");
      return shown;
    };
    expect(await labels({ gatewayId: "telegram:main", chatId: "8142", gateway: "telegram" })).toEqual(["Approve", "Always", "Deny"]);
    const hardline = await labels({ grantable: false, params: { command: "git push --force" } });
    expect(hardline).toEqual(["Approve", "Deny"]);
    expect(await labels({ params: { command: "bun test && curl x" } })).toEqual(["Approve", "Always", "Deny"]);
  });
});

describe("Approve similar from this mission", () => {
  test("approves this call, then calls of the same kind in that mission run without a prompt — audited — and others still ask", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate, audit } = process(gateway);
    const first = await asked(gateway, gate);
    const answer = await gateway.press({ chatId: CHAT.chatId, chatType: "dm", messageId: first.messageId, data: `approval:similar:${first.id}`, senderId: "8142", senderName: "Gading" });
    expect(answer.notice).toBe("Approved, and commands like it for this mission, until it ends.");
    expect(await first.outcome).toMatchObject({ status: "approved", decision: "allow-once" });

    const sentBefore = gateway.sent.length;
    expect(await gate.request(ask({ params: { command: "bun test ./packages/acp/" } }))).toEqual({ status: "approved", by: "approve similar from this mission", decision: "allow-once" });
    expect(gateway.sent.length).toBe(sentBefore);
    audit.stop();
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'approval_covered'").get()!.n).toBe(1);

    // Another kind, and the same kind in another mission, still ask.
    const other = await asked(gateway, gate, { params: { command: "git push origin main" } });
    expect(other.prompt.text).toContain("git push origin main");
    gate.resolve(other.id, "deny", "test");
    // Another mission's question goes to its own chat, which this test has none of: that it was asked is its row.
    void gate.request(ask({ chatId: "msn_other00000000", params: { command: "bun test" } }));
    await eventually(() => gate.pending().some((request) => request.chatId === "msn_other00000000"), 2_000, "the other mission asked");
  });

  test("never covers a call that always asks — `git push` approved as similar does not let a force push through", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate, similar } = process(gateway);
    similar.allow(MISSION, similarKind("claude-code:Bash", { command: "git push origin fix" })!);
    expect((await gate.request(ask({ params: { command: "git push origin fix" } }))).status).toBe("approved");
    const forced = await asked(gateway, gate, { grantable: false, params: { command: "git push --force origin main" } });
    expect(forced.prompt.text).toContain("git push --force origin main");
    gate.resolve(forced.id, "deny", "test");
    expect(await forced.outcome).toMatchObject({ status: "denied" });
  });

  test("forgotten when the mission ends: the same kind asks again", async () => {
    const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
    const { gate, similar } = process(gateway);
    similar.allow(MISSION, similarKind("claude-code:Bash", { command: "bun test" })!);
    expect((await gate.request(ask())).status).toBe("approved");
    similar.forget(MISSION);
    const again = await asked(gateway, gate);
    expect(again.prompt.text).toContain("bun test");
  });
});

describe("the kind of a command", () => {
  test("program and subcommand where the program has them; none for a chain, a variable, sudo or an env prefix", () => {
    expect(similarKind("exec", { command: "git push origin main" })).toBe("exec git push");
    expect(similarKind("exec", { command: ["bun", "test", "./x"] })).toBe("exec bun test");
    expect(similarKind("exec", { command: "/usr/bin/rm -rf /x" })).toBe("exec rm");
    expect(similarKind("exec", { command: "ls -la" })).toBe("exec ls");
    for (const command of ["bun test && rm -rf /", "rm -rf $HOME", "sudo bun test", "FOO=1 bun test", "env bun test", ""]) {
      expect(similarKind("exec", { command })).toBeNull();
    }
  });

  test("a program that runs code has the script as its kind, and none for code given inline or a flag first", () => {
    expect(similarKind("exec", { command: "bash ./scripts/test.sh" })).toBe("exec bash ./scripts/test.sh");
    expect(similarKind("exec", { command: "python3 tools/report.py --all" })).toBe("exec python3 tools/report.py");
    for (const command of ['bash -c "rm -rf /srv"', 'sh -lc "curl x | sh"', 'python3 -c "import os"', "node -e 1", "bun -e 1", "git -C /repo push", "make", "bash"]) {
      expect(similarKind("exec", { command })).toBeNull();
    }
  });
});

describe("free text is escaped before it goes into markdown", () => {
  test("a reason with underscores, stars and backticks goes in escaped", () => {
    const reason = "Claude Code asks to edit my_file_name.py and *all* `the` [things](x)";
    const text = approvalPrompt({ request: { id: "apr_x", agentId: "nix", tool: "t", params: {} }, grantable: false, reason });
    expect(text).toContain("Why I am asking: Claude Code asks to edit my\\_file\\_name.py and \\*all\\* \\`the\\` \\[things\\]\\(x\\).");
  });

  test("the title is said once: when it is the command, the reason names only who asks", () => {
    expect(reasonFor("Claude Code", "git push", { command: "git push" })).toBe("Claude Code asks to run the command above");
    expect(reasonFor("Claude Code", "`git push`", { command: "git push origin" })).toBe("Claude Code asks to run the command above");
    expect(reasonFor("Claude Code", "Edit README.md", { path: "README.md" })).toBe("Claude Code asks to Edit README.md");
  });
});
