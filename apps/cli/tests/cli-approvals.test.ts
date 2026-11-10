/**
 * `nouride approvals <answer>`, run by a person and run by an agent (2026-10-15).
 *
 * The CLI reads the control token off disk and a bare token is admin, so an agent's `nouride` tool
 * reached the same answer route the operator's terminal does — and with no id, `pending[0]` is
 * whatever happens to be first, which with two `delegate` helpers at once can be the agent's own
 * `rm -rf`. The classifier makes a person see the call; these hold the two rules that make what they
 * see mean something. What is asserted is what was *posted*: an answer is the side effect, and a
 * refusal that printed the right words and posted anyway would look identical in a terminal.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { approvals } from "../src/commands/approvals.ts";

const PENDING = [
  { id: "apr_mine", agentId: "nouva", chatId: "c", gateway: "telegram", tool: "exec", params: {}, status: "pending", requestedAt: 0 },
  { id: "apr_other", agentId: "nox", chatId: "c", gateway: "telegram", tool: "exec", params: {}, status: "pending", requestedAt: 0 },
  { id: "apr_persona", agentId: "nox", chatId: "c", gateway: "telegram", tool: "persona", params: {}, status: "pending", requestedAt: 0, hardlineClass: "persona" },
  { id: "apr_people", agentId: "nox", chatId: "c", gateway: "telegram", tool: "nouride", params: { args: ["access", "approve", "ABC123", "--as", "gading"] }, status: "pending", requestedAt: 0, hardlineClass: "people" },
];
/** Not in the pending list — settled meanwhile, or listed elsewhere — and so looked up by id. */
const ELSEWHERE = { id: "apr_elsewhere", agentId: "nox", chatId: "c", gateway: "telegram", tool: "persona", params: {}, status: "pending", requestedAt: 0, hardlineClass: "persona" };

function fakeClient(): Client & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    get: async <T>(path: string) => (path === "/approvals/apr_elsewhere" ? { approval: ELSEWHERE } : { pending: PENDING }) as T,
    post: async <T>(path: string) => {
      posts.push(path);
      return { decision: path.split("/").pop() } as T;
    },
  } as unknown as Client & { posts: string[] };
}

/** Run as an agent's tool would (`NOURIDE_AGENT_ID` set) or as a person (unset), and put it back. */
async function as(agent: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env.NOURIDE_AGENT_ID;
  if (agent === undefined) delete process.env.NOURIDE_AGENT_ID;
  else process.env.NOURIDE_AGENT_ID = agent;
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await run();
  } finally {
    log.mockRestore();
    if (saved === undefined) delete process.env.NOURIDE_AGENT_ID;
    else process.env.NOURIDE_AGENT_ID = saved;
  }
}

/** `fail` exits the process; here it throws, so a refusal is something a test can await. */
async function refused(run: () => Promise<void>): Promise<string> {
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  const lines: string[] = [];
  const error = spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
  try {
    await expect(run()).rejects.toThrow("exit 1");
    return lines.join("\n");
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
}

describe("nouride approvals <answer>", () => {
  test("a person with no id still answers the first pending request", async () => {
    // Unchanged on purpose: at a terminal, `nouride approvals allow-once` after reading the list is the
    // whole workflow, and the person is the one the question was put to.
    const client = fakeClient();
    await as(undefined, () => approvals(client, ["allow-once"]));
    expect(client.posts).toEqual(["/approvals/apr_mine/allow-once"]);
  });

  test("an agent with no id is refused, and nothing is answered", async () => {
    const client = fakeClient();
    await as("nox", async () => {
      expect(await refused(() => approvals(client, ["allow-always"]))).toContain("name the approval");
    });
    expect(client.posts).toEqual([]);
  });

  test("an agent cannot answer its own agent's request, even by id", async () => {
    const client = fakeClient();
    await as("nouva", async () => {
      expect(await refused(() => approvals(client, ["allow-always", "apr_mine"]))).toContain("its own approval request");
    });
    expect(client.posts).toEqual([]);
  });

  test("an agent cannot answer another agent's persona change or change to People — listed or looked up — while a person still can (0.8.8, 0.8.9)", async () => {
    // An orchestrator at `trusted` ran `nouride approvals allow-once` on another agent's persona request,
    // and the change was written with no admin having seen it.
    const client = fakeClient();
    await as("nouva", async () => {
      for (const id of ["apr_persona", "apr_elsewhere", "apr_people"]) expect(await refused(() => approvals(client, ["allow-once", id]))).toContain("only an admin answers");
    });
    expect(client.posts).toEqual([]);
    await as(undefined, () => approvals(client, ["allow-once", "apr_persona"]));
    expect(client.posts).toEqual(["/approvals/apr_persona/allow-once"]);
  });

  test("an agent naming another agent's request reaches the daemon", async () => {
    // Still in front of a person first — the classifier asks before this ever runs. This rule is only
    // about whose request it is.
    const client = fakeClient();
    await as("nouva", () => approvals(client, ["deny", "apr_other"]));
    expect(client.posts).toEqual(["/approvals/apr_other/deny"]);
  });
});
