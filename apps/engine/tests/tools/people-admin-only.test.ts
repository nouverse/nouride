/**
 * Who People says a person is, changed by an agent, is an admin's to answer (0.8.9).
 *
 * A sender is an admin when the person in `[[people]]` holding their chat id also holds an admin's dashboard account
 * (`senderIsAdmin`). `nouride access approve <code> --as <key>` links the sender of a pairing code to that person, and
 * `people set|remove` change who a person is — all of class `access`, which `trusted` let through. So an agent at
 * `trusted`, asked to or talked into it, could make any chat an admin's, and that chat then answered what only an admin
 * may. Now they are `people`: asked at every level, and answered by an admin only — in a chat, on the dashboard, and
 * never by another agent's `nouride approvals`.
 *
 * Wired as the daemon wires it where it can be: the agent's own `nouride` tool over `exec`'s gate through the executor's
 * caller, the real approval gate on a migrated database, the real chat hooks and the real control routes.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { ApprovalRequest, ChatType, Tool, ToolCall, ToolContext } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { approvals as approvalsCommand } from "@/cli/commands/approvals.ts";
import type { Client } from "@/cli/client.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { answerAllApprovals, answerApproval } from "@/modules/hooks/pending.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";
import { ToolCaller } from "@/modules/llm/executor/tool-caller.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { adminOnlyNotice, mayAnswer } from "@/modules/tools/approval-answerers.ts";
import { createExecTool } from "@/modules/tools/builtins/exec.ts";
import { createNourideCliTool } from "@/modules/tools/builtins/nouride-cli.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { cheapPasswords, eventually, fakeAgent } from "../helpers.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "people-admin-only-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for the CLI that leaves a mark when it runs, so "not run" is something a test can see. */
function stubCli(): { binary: string; ran: () => boolean } {
  const binary = join(dir, "nouride");
  const mark = join(dir, "ran");
  writeFileSync(binary, `#!/bin/sh\necho "$*" > "${mark}"\n`);
  chmodSync(binary, 0o755);
  return { binary, ran: () => existsSync(mark) };
}

/** An agent's `nouride` call through the executor's own caller, at `level`, with every question answered `answer`. */
async function agentRuns(args: string[], level: "careful" | "balanced" | "trusted", answer: "approved" | "denied" = "denied") {
  const { binary, ran } = stubCli();
  const exec = createExecTool({ timeoutMs: 15_000, maxOutputBytes: 200_000, blocked: [], policy: { blocked: [] } });
  const tool = createNourideCliTool({ exec, installDir: dir, command: binary });
  const asks: ApprovalAsk[] = [];
  const toolset = {
    definitions: [tool.definition],
    get: (name: string): Tool | undefined => (name === "nouride" ? tool : undefined),
    requiresApproval: () => true,
    parallelSafe: () => false,
    gate: (_name: string, callArgs: Record<string, unknown>, callCtx: ToolContext) => tool.gate!(callArgs, callCtx),
  };
  const approvals = {
    available: true,
    request: async (ask: ApprovalAsk) => {
      asks.push(ask);
      return answer === "approved" ? { status: "approved", by: "gading", decision: "allow-once" } : { status: "denied" };
    },
  };
  const caller = new ToolCaller({ approvalLevel: () => level, approvals } as unknown as ExecutorDeps);
  const workspace = join(dir, "workspace");
  const req = {
    toolset,
    agent: fakeAgent({ config: { id: "nouva" } as never, dir: workspace }),
    sessionId: "ses_1",
    chatId: "555",
    gateway: "telegram",
    gatewayId: "telegram:nouva",
    senderId: "555",
    chatType: "dm",
    workspaceRoots: [dir],
  } as unknown as TurnRequest;
  const call: ToolCall = { id: "c1", name: "nouride", arguments: { args } };
  const result = await caller.run(req, call, 8_000);
  return { result, asks, ran: ran() };
}

const LINKS = [
  ["access approve --as", ["access", "approve", "K7Q2MX", "--as", "gading"]],
  ["access approve --as=", ["access", "approve", "K7Q2MX", "--as=gading"]],
  ["access approve --me", ["access", "approve", "K7Q2MX", "--me"]],
  ["access approve --new", ["access", "approve", "K7Q2MX", "--new", "Sam"]],
  ["--json access approve --as", ["--json", "access", "approve", "K7Q2MX", "--as", "gading"]],
  ["people set by key", ["people", "set", "gading", "--name", "Gading"]],
  ["people set by account", ["people", "set", "web:acc_admin", "--name", "Sam"]],
  ["people remove", ["people", "remove", "gading"]],
] as const;

describe("an agent's change to People, at trusted", () => {
  test.each(LINKS)("%s — asked, the class kept with the question, not run on a no", async (_label, args) => {
    const { result, asks, ran } = await agentRuns([...args], "trusted");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ tool: "nouride", hardlineClass: "people", autoCoverable: false, grantable: false });
    expect(result.isError).toBe(true);
    expect(ran).toBe(false);
  });

  test("approved by a person, it runs", async () => {
    const { asks, ran } = await agentRuns(["access", "approve", "K7Q2MX", "--as", "gading"], "trusted", "approved");
    expect(asks).toHaveLength(1);
    expect(ran).toBe(true);
  });

  test("and what names nobody stays where it was: trusted runs a plain pairing or a block without asking", async () => {
    for (const args of [["access", "approve", "K7Q2MX"], ["access", "block", "telegram:nouva:42"]]) {
      const { asks, ran } = await agentRuns(args, "trusted");
      expect({ args, asked: asks.length, ran }).toEqual({ args, asked: 0, ran: true });
    }
  });

  test("balanced asks it too", async () => {
    const { asks, ran } = await agentRuns(["people", "remove", "gading"], "balanced");
    expect(asks.map((ask) => ask.hardlineClass)).toEqual(["people"]);
    expect(ran).toBe(false);
  });
});

describe("only an admin answers it", () => {
  let db: SqliteDb;
  let gate: SqliteApprovalGate;
  const DM = { gatewayId: "telegram:bot", chatId: "dm-alice" };

  beforeEach(async () => {
    db = openDatabase(join(dir, "t.db"));
    await migrate(db);
    gate = new SqliteApprovalGate({ db, timeoutMs: 60_000 });
  });
  afterEach(() => {
    gate.shutDown();
    db.close();
  });

  /** The question an agent's `nouride access approve … --as <person>` puts, left waiting in Alice's DM. */
  async function asked(): Promise<ApprovalRequest> {
    void gate
      .request({
        agentId: "nouva",
        ...DM,
        gateway: "telegram",
        senderId: "alice",
        tool: "nouride",
        params: { args: ["access", "approve", "K7Q2MX", "--as", "gading"] },
        grantable: false,
        autoCoverable: false,
        hardlineClass: "people",
        reason: "links whoever sent this code to a person in People",
      })
      .catch(() => {});
    await eventually(() => gate.pendingForChat("nouva", DM.gatewayId, DM.chatId).length > 0, 4_000, "the question asked");
    return gate.pendingForChat("nouva", DM.gatewayId, DM.chatId).at(-1)!;
  }

  function said(senderId: string, admin = false, chatType: ChatType = "dm"): HookContext {
    return {
      gatewayId: DM.gatewayId,
      chatId: DM.chatId,
      senderId,
      agent: { config: { id: "nouva" } },
      envelope: { chatType, gatewayId: DM.gatewayId, chatId: DM.chatId, senderId },
      deps: {
        approvals: gate,
        registry: { enabled: () => [{ config: { id: "nouva" } }] },
        isAdmin: () => admin,
      },
    } as unknown as HookContext;
  }

  test("the class is stored with the row, so a restart or another reader still knows it", async () => {
    const request = await asked();
    expect(request.hardlineClass).toBe("people");
    expect(gate.get(request.id)?.hardlineClass).toBe("people");
  });

  test("in a one-to-one chat the person in it is told so — their own request too — and an admin answers it", async () => {
    const request = await asked();
    expect((await answerApproval(said("alice"), "allow-once")).reply).toBe("Only an admin can answer this one: it changes who People says a person is, and an admin is one.");
    expect((await answerAllApprovals(said("alice"), "allow-once")).reply).toBe(
      "The request waiting is an admin's alone to answer: it changes who People says a person is, and an admin is one.",
    );
    expect(gate.get(request.id)?.status).toBe("pending");
    expect((await answerApproval(said("alice", true), "deny")).reply).toBe(`Denied \`${request.id}\`.`);
    expect(gate.get(request.id)?.status).toBe("denied");
  });

  test("another agent's `nouride approvals` is refused before it reaches the daemon; a person at the terminal answers", async () => {
    const request = await asked();
    const posts: string[] = [];
    const client = {
      get: async <T>() => ({ pending: gate.pending() }) as T,
      post: async <T>(path: string) => {
        posts.push(path);
        return { decision: "allow-once" } as T;
      },
    } as unknown as Client;
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
    const log = spyOn(console, "log").mockImplementation(() => {});
    const saved = process.env.NOURIDE_AGENT_ID;
    try {
      process.env.NOURIDE_AGENT_ID = "nox";
      await expect(approvalsCommand(client, ["allow-once", request.id])).rejects.toThrow("exit");
      expect(errors.join("\n")).toContain("only an admin answers");
      expect(errors.join("\n")).toContain("It changes who People says a person is");
      expect(posts).toEqual([]);
      delete process.env.NOURIDE_AGENT_ID;
      await approvalsCommand(client, ["allow-once", request.id]);
      expect(posts).toEqual([`/approvals/${request.id}/allow-once`]);
    } finally {
      if (saved === undefined) delete process.env.NOURIDE_AGENT_ID;
      else process.env.NOURIDE_AGENT_ID = saved;
      exit.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });

  test("on the dashboard an operator's account is refused and an admin's answers", async () => {
    const request = await asked();
    const other = await (async () => {
      void gate
        .request({ agentId: "nouva", ...DM, gateway: "telegram", senderId: "alice", tool: "exec", params: { command: ["ls"] }, grantable: true, autoCoverable: true, reason: "first time" })
        .catch(() => {});
      await eventually(() => gate.pendingForChat("nouva", DM.gatewayId, DM.chatId).length > 1, 4_000, "the second question asked");
      return gate.pendingForChat("nouva", DM.gatewayId, DM.chatId).find((one) => one.id !== request.id)!;
    })();
    const { post, cookieOf } = await dashboard();

    const operator = await cookieOf("opal", "operator-password-1");
    expect((await post(`/approvals/${request.id}/allow-once`, undefined, operator)).status).toBe(403);
    expect(gate.get(request.id)?.status).toBe("pending");
    // The rest are still an operator's to answer.
    expect((await post(`/approvals/${other.id}/deny`, undefined, operator)).status).toBe(200);

    const admin = await cookieOf("ada", "admin-password-1");
    expect((await post(`/approvals/${request.id}/deny`, undefined, admin)).status).toBe(200);
    expect(gate.get(request.id)?.status).toBe("denied");
  });

  test("and a dashboard account cannot write `/approve` as the admin through POST /message — it is the command line's (Nox, B1)", async () => {
    // An operator read the admin's account id off /users, and sent `/approve <id>` with the admin as `senderId`: the
    // chat hook took the body's sender, and `senderIsAdmin` matched it. No account's message reaches the gateway here.
    const request = await asked();
    const sent: Record<string, unknown>[] = [];
    const { post, cookieOf, token } = await dashboard({
      local: { ask: async (body: Record<string, unknown>) => (sent.push(body), { replies: [], answered: true }) },
      pipeline: { idle: async () => {} },
    });
    const forged = { chatId: DM.chatId, senderId: "acc_admin", text: `/approve ${request.id}` };
    for (const [username, password] of [["opal", "operator-password-1"], ["ada", "admin-password-1"]] as const) {
      expect((await post("/message", forged, await cookieOf(username, password))).status).toBe(403);
    }
    expect(sent).toEqual([]);
    // The command line's token still says who speaks — but never the daemon's own sender.
    expect((await post("/message", { ...forged, senderId: "nouride:system" }, undefined, token)).status).toBe(400);
    expect((await post("/message", forged, undefined, token)).status).toBe(200);
    expect(sent).toEqual([forged]);
    expect(gate.get(request.id)?.status).toBe("pending");
  });

  /** The control routes on this gate, with an operator's and an admin's dashboard account. */
  async function dashboard(more: Record<string, unknown> = {}) {
    const users = new UserStore({ db, passwords: cheapPasswords });
    await users.create({ username: "opal", password: "operator-password-1", role: "operator", createdBy: "test" });
    await users.create({ username: "ada", password: "admin-password-1", role: "admin", createdBy: "test" });
    const token = "control-token-for-tests-0000000000";
    const app = new Hono();
    mountControlRoutes(app, {
      ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
      token,
      audit: new AuditLog(db),
      users,
      approvals: gate,
      ...more,
    } as unknown as ControlDeps);
    const post = (path: string, body?: unknown, cookie?: string, bearer?: string) =>
      app.request(
        `/api/control${path}`,
        { method: "POST", headers: { ...(cookie ? { cookie } : {}), ...(bearer ? { "x-nouride-token": bearer } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
        { clientAddress: "203.0.113.10" },
      );
    const cookieOf = async (username: string, password: string) =>
      ((await post("/auth/login", { username, password })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return { post, cookieOf, token };
  }
});

describe("a program installed for every agent (Nox's review, N7)", () => {
  test("is an admin's to answer too, in a one-to-one chat as well: it installs as the daemon's user, which reaches People", () => {
    const request = { requestedBy: "555", hardlineClass: "shared-tools" as const };
    expect(mayAnswer({ chatType: "dm", senderId: "555", isAdmin: () => false }, request)).toBe(false);
    expect(mayAnswer({ chatType: "dm", senderId: "555", isAdmin: () => true }, request)).toBe(true);
    expect(adminOnlyNotice(request)).toBe("Only an admin can answer this one: it changes a program every agent runs, installed as the daemon's user.");
  });
});

describe("this machine's packages changed as root (0.8.15)", () => {
  test("are an admin's to answer, in a one-to-one chat as well: nouride-pkg changes them as root", () => {
    const request = { requestedBy: "555", hardlineClass: "system-packages" as const };
    expect(mayAnswer({ chatType: "dm", senderId: "555", isAdmin: () => false }, request)).toBe(false);
    expect(mayAnswer({ chatType: "group", senderId: "555", isAdmin: () => false }, request)).toBe(false);
    expect(mayAnswer({ chatType: "dm", senderId: "555", isAdmin: () => true }, request)).toBe(true);
    expect(adminOnlyNotice(request)).toBe("Only an admin can answer this one: it changes this machine's system packages, as root.");
  });
});

describe("a persona change waiting across the upgrade", () => {
  test("keeps 0.8.8's rule: 071 gives it its class, so only an admin answers it still — and a change to People waiting too", async () => {
    const db = openDatabase(join(dir, "up.db"));
    try {
      // As 0.8.8 left it: the chain to 070, no class column, a persona change pending.
      await migrate(db, {}, MIGRATIONS.filter((migration) => migration.version <= 70));
      db.prepare("INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, requested_at) VALUES ('apr_p', 'nix', 'c', 'telegram', 'persona', '{}', 1)").run();
      db.prepare("INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, requested_at) VALUES ('apr_e', 'nix', 'c', 'telegram', 'exec', '{}', 1)").run();
      // Asked under `access` by 0.8.8, still waiting — and the same answered, and another verb.
      const row = db.prepare("INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, status, requested_at) VALUES (?, 'nix', 'c', 'telegram', 'nouride', ?, ?, 1)");
      row.run("apr_link", JSON.stringify({ args: ["access", "approve", "K7Q2MX", "--as=gading"] }), "pending");
      row.run("apr_set", JSON.stringify({ args: ["--json", "people", "set", "gading", "--name", "G"] }), "pending");
      row.run("apr_done", JSON.stringify({ args: ["people", "remove", "gading"] }), "approved");
      row.run("apr_gw", JSON.stringify({ args: ["gateway", "add", "--platform", "telegram"] }), "pending");
      row.run("apr_bad", "{not json", "pending");
      // A program for every agent, waiting too: an admin's from 0.8.9.
      row.run("apr_tools", JSON.stringify({ args: ["tools", "run", "--", "npm", "i", "-g", "cowsay"] }), "pending");
      await migrate(db);
      const rows = db.prepare<{ id: string; hardline_class: string | null }>("SELECT id, hardline_class FROM approvals ORDER BY id").all();
      expect(rows).toEqual([
        { id: "apr_bad", hardline_class: null },
        { id: "apr_done", hardline_class: null },
        { id: "apr_e", hardline_class: null },
        { id: "apr_gw", hardline_class: null },
        { id: "apr_link", hardline_class: "people" },
        { id: "apr_p", hardline_class: "persona" },
        { id: "apr_set", hardline_class: "people" },
        { id: "apr_tools", hardline_class: "shared-tools" },
      ]);
    } finally {
      db.close();
    }
  });
});
