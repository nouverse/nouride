/**
 * A coding CLI's permission request, asked as a Nouride approval (0.8.1): the person answers it where they answer every
 * approval, and the CLI hears the option it offered for that answer.
 */

import { describe, expect, test } from "bun:test";
import type { PermissionOption, RequestPermissionParams } from "@nouride/acp";
import { askPermission, chosen } from "@/modules/external-agents/permission.ts";
import type { ApprovalAsk, ApprovalGate, ApprovalOutcome } from "@/modules/tools/approval.ts";

const OPTIONS: PermissionOption[] = [
  { optionId: "a1", name: "Allow", kind: "allow_once" },
  { optionId: "a2", name: "Always", kind: "allow_always" },
  { optionId: "r1", name: "Reject", kind: "reject_once" },
  { optionId: "r2", name: "Never", kind: "reject_always" },
];

const request = (options = OPTIONS): RequestPermissionParams => ({
  sessionId: "s1",
  toolCall: { toolCallId: "t1", name: "Bash", kind: "execute", title: "git push origin main", rawInput: { command: "git push origin main" } },
  options,
});

function gate(outcome: ApprovalOutcome) {
  const asks: ApprovalAsk[] = [];
  const approvals: ApprovalGate = {
    available: true,
    request: async (ask: ApprovalAsk) => {
      asks.push(ask);
      await ask.asking?.("apr_7");
      return outcome;
    },
  } as unknown as ApprovalGate;
  return { approvals, asks };
}

const ASKED = { agentId: "coder", chatId: "msn_1", gateway: "web" as const, gatewayId: "web:mission", senderId: "555", turnId: "turn_1", waitMs: 0, answerableMs: 86_400_000 };

describe("the question", () => {
  test("is the CLI's tool and arguments, stable, never coverable by a level, parked as the turn says, and says who asks", async () => {
    const { approvals, asks } = gate({ status: "approved", by: "555", decision: "allow-once" });
    const waited: string[] = [];
    await askPermission({ cli: "claude-code", cliName: "Claude Code", request: request(), asked: ASKED, approvals, waiting: (id, tool) => void waited.push(`${id} ${tool}`) });
    expect(asks[0]).toMatchObject({
      tool: "claude-code:Bash",
      params: { command: "git push origin main" },
      grantable: true,
      autoCoverable: false,
      reason: "Claude Code asks to run the command above",
      waitMs: 0,
      answerableMs: 86_400_000,
      gatewayId: "web:mission",
      chatId: "msn_1",
    });
    expect(waited).toEqual(["apr_7 claude-code:Bash"]);
  });

  test("asked while its turn was stopped, it is answered cancelled — as ACP asks — not a person's no (0.8.1)", async () => {
    const { approvals } = gate({ status: "expired" });
    const controller = new AbortController();
    controller.abort("stopped-by-person");
    const outcome = await askPermission({ cli: "claude-code", cliName: "Claude Code", request: request(), asked: { ...ASKED, signal: controller.signal }, approvals, waiting: () => {} });
    expect(outcome).toEqual({ outcome: "cancelled" });
  });

  test("offers Always only when the CLI has an always of its own", async () => {
    const { approvals, asks } = gate({ status: "approved", by: "555" });
    await askPermission({ cli: "omp", cliName: "omp", request: request(OPTIONS.filter((option) => option.kind !== "allow_always")), asked: ASKED, approvals, waiting: () => {} });
    expect(asks[0]?.grantable).toBe(false);
  });
});

describe("the answer, as the option the CLI offered", () => {
  test("allow once, always — and always where only once is offered, once", () => {
    expect(chosen({ status: "approved", by: "p", decision: "allow-once" }, OPTIONS)).toEqual({ outcome: "selected", optionId: "a1" });
    expect(chosen({ status: "approved", by: "p", decision: "allow-always" }, OPTIONS)).toEqual({ outcome: "selected", optionId: "a2" });
    expect(chosen({ status: "approved", by: "p", decision: "allow-always" }, OPTIONS.filter((o) => o.kind !== "allow_always"))).toEqual({ outcome: "selected", optionId: "a1" });
  });

  test("a no, a parked question and nobody to ask are this call refused — never refused for good", () => {
    for (const outcome of [{ status: "denied", by: "p" }, { status: "expired", stillAnswerable: true }, { status: "unavailable", reason: "no gate" }] as ApprovalOutcome[]) {
      expect(chosen(outcome, OPTIONS)).toEqual({ outcome: "selected", optionId: "r1" });
    }
    expect(chosen({ status: "denied", by: "p" }, OPTIONS.filter((o) => o.kind !== "reject_once"))).toEqual({ outcome: "cancelled" });
  });
});

describe("a delete inside the mission's folder (0.8.7)", () => {
  const own = "/";
  const deleting = (command: string): RequestPermissionParams => ({
    sessionId: "s1",
    toolCall: { toolCallId: "t2", name: "Bash", kind: "execute", title: command, rawInput: { command } },
    options: OPTIONS,
  });

  test("is allowed once, without the gate, and said where the turn's steps are", async () => {
    const dir = (await import("../helpers.ts")).tempDir("permission-delete");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${dir}/worktree/build`, { recursive: true });
    const { approvals, asks } = gate({ status: "approved", by: "555", decision: "allow-once" });
    const allowed: string[] = [];
    const outcome = await askPermission({
      cli: "claude-code", cliName: "Claude Code", request: deleting(`rm -rf ${dir}/worktree/build`), asked: ASKED, approvals, waiting: () => {},
      deleteScope: { roots: [dir], keep: [dir, `${dir}/worktree`] },
      allowedAlone: (tool, command, targets) => void allowed.push(`${tool} ${command} ${targets.join(",")}`),
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "a1" });
    expect(asks).toEqual([]);
    expect(allowed[0]).toStartWith("claude-code:Bash rm ");
  });

  test("anything it is unsure of goes to the person, as before — and with no scope, every delete does", async () => {
    const dir = (await import("../helpers.ts")).tempDir("permission-delete");
    const { approvals, asks } = gate({ status: "denied", by: "555" });
    const scope = { roots: [dir], keep: [dir] };
    await askPermission({ cli: "claude-code", cliName: "Claude Code", request: deleting(`rm -rf ${dir}/x && rm -rf ${own}`), asked: ASKED, approvals, waiting: () => {}, deleteScope: scope });
    await askPermission({ cli: "claude-code", cliName: "Claude Code", request: deleting(`rm -rf ${dir}/../elsewhere`), asked: ASKED, approvals, waiting: () => {}, deleteScope: scope });
    await askPermission({ cli: "claude-code", cliName: "Claude Code", request: deleting(`rm -rf ${dir}/x`), asked: ASKED, approvals, waiting: () => {} });
    expect(asks).toHaveLength(3);
  });
});
