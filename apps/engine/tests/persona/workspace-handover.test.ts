/**
 * Two agents in one channel have to be able to hand work over, and still keep something to themselves.
 *
 * The mention feature shipped with a workspace per agent, which meant it could pass an *instruction*
 * and never the work: Nouva writes `@nox benerin build ini`, and the build sits at a path outside
 * every root Nox has, so the sandbox refuses it however it is spelled. Nothing reports this as a
 * failure of the feature — Nox simply answers that the file does not exist.
 *
 * So the workspace splits in two. `shared/` is reachable by everyone and is where the prompt sends
 * ordinary work; `private/<id>/` is reachable by its owner alone. These tests are that split holding
 * in both directions, which is the only reason it is worth having two directories rather than one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTextFileAtomic } from "@nouride/runtime";
import { toUserMessage, type Tool, type ToolContext } from "@nouride/shared";
import { writeTool, createReadTool } from "@/modules/tools/builtins/files.ts";

const readTool = createReadTool();

/**
 * Run a tool the way the executor does.
 *
 * A sandbox refusal is thrown, and the turn loop converts it into a tool *result* the model reads and
 * adapts to (invariant 8). Asserting on the throw would test a surface the agent never sees; this is
 * the shape it actually gets back.
 */
async function attempt(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: unknown; isError: boolean }> {
  return await tool
    .execute(args, ctx)
    .then((result) => ({ content: result.content, isError: Boolean(result.isError) }))
    .catch((err: unknown) => ({ content: toUserMessage(err), isError: true }));
}

let root: string;
let shared: string;
let nouvaPrivate: string;
let noxPrivate: string;

beforeEach(async () => {
  root = join(tmpdir(), `nouride-handover-${Math.floor(performance.now() * 1000)}`);
  shared = join(root, "shared");
  nouvaPrivate = join(root, "private", "nouva");
  noxPrivate = join(root, "private", "nox");
  for (const dir of [shared, nouvaPrivate, noxPrivate]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The context the pipeline builds: shared first, then this agent's own directory. */
function ctxFor(agentId: string, own: string): ToolContext {
  return {
    agentId,
    sessionId: "s",
    chatId: "c",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "u",
    workspaceDir: shared,
    agentDir: join(root, "agents", agentId),
    workspaceRoots: [shared, own],
    signal: new AbortController().signal,
  } as ToolContext;
}

const nouva = () => ctxFor("nouva", nouvaPrivate);
const nox = () => ctxFor("nox", noxPrivate);

describe("handover through the shared workspace", () => {
  test("one agent reads what another wrote there", async () => {
    // The exact exchange the mention feature is for, at the only level where it can actually fail.
    const written = await attempt(writeTool, { path: "build/output.txt", content: "built by nouva\n" }, nouva());
    expect(written.isError).toBeFalsy();

    const read = await attempt(readTool, { path: "build/output.txt" }, nox());
    expect(read.isError).toBeFalsy();
    expect(JSON.stringify(read.content)).toContain("built by nouva");
  });

  test("a relative path from either agent lands in the same directory", async () => {
    // Both resolve `notes.md` against `workspaceDir`. If the two ever resolved somewhere different,
    // handover would fail while every individual call still succeeded — the failure that is hardest
    // to see, because nothing errors.
    await attempt(writeTool, { path: "notes.md", content: "from nouva\n" }, nouva());
    const read = await attempt(readTool, { path: "notes.md" }, nox());

    expect(read.isError).toBeFalsy();
    expect(JSON.stringify(read.content)).toContain("from nouva");
  });
});

describe("private directories stay private", () => {
  test("an agent cannot read another agent's private file", async () => {
    await writeTextFileAtomic(join(nouvaPrivate, "draft.md"), "half-formed thought\n");

    // Absolute, because there is no relative spelling that reaches it — which is the point.
    const read = await attempt(readTool, { path: join(nouvaPrivate, "draft.md") }, nox());

    expect(read.isError).toBe(true);
    expect(JSON.stringify(read.content)).not.toContain("half-formed thought");
  });

  test("an agent cannot write into another agent's private directory", async () => {
    const written = await attempt(writeTool, { path: join(noxPrivate, "planted.md"), content: "not mine to leave\n" }, nouva());

    expect(written.isError).toBe(true);
  });

  test("but its own private directory is reachable", async () => {
    // The refusals above must come from the *boundary*, not from private directories being unusable.
    // A test suite that only proves things are refused passes just as well when nothing works at all.
    const written = await attempt(writeTool, { path: join(nouvaPrivate, "draft.md"), content: "mine\n" }, nouva());
    expect(written.isError).toBeFalsy();

    const read = await attempt(readTool, { path: join(nouvaPrivate, "draft.md") }, nouva());
    expect(read.isError).toBeFalsy();
    expect(JSON.stringify(read.content)).toContain("mine");
  });

  test("`private/` as a whole is not a root", async () => {
    // `private/nouva` being reachable must not make its parent reachable — otherwise every agent
    // reaches every other one through `../`, and the split is decorative.
    const read = await attempt(readTool, { path: join(root, "private") }, nouva());
    expect(read.isError).toBe(true);
  });
});
