/**
 * The working language, one rule where every agent reads it: English for the work, the person's own language for what
 * reaches them. Before it only memory, a helper's brief and a mission's goal asked for English, and on mission msn_53b16d
 * 32 of 37 blocks of text between steps and 13 of 13 thinking blocks were in the person's language.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@nouride/shared";
import { buildSystemPrompt, type HarnessFacts } from "@/modules/llm/prompt/index.ts";
import { DASHBOARD_LINKS, renderLimits, WORKING_LANGUAGE } from "@/modules/llm/prompt/harness-limits.ts";
import type { HarnessView } from "@/modules/llm/prompt/types.ts";
import { writeInstruction } from "@/modules/external-agents/instruction.ts";
import type { CliConnection } from "@/modules/external-agents/connection.ts";
import { fakeAgent } from "../helpers.ts";

const HARNESS: HarnessFacts = { approvalRequired: [], approvalAvailable: true, maxToolIterations: 25, maxTurnDurationMs: 300_000, commands: ["/help"], truncates: true };
const tool = (name: string): ToolDefinition => ({ name, description: name, parameters: { type: "object" } });

function harness(toolNames: string[], facts: Partial<HarnessFacts> = {}): string {
  const built = buildSystemPrompt({
    agent: fakeAgent(),
    tools: toolNames.map(tool),
    harness: { ...HARNESS, ...facts },
    gateway: "telegram",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "ses_1",
    model: "claude-sonnet-4-20250514",
    now: new Date("2026-10-29T00:00:00Z"),
    timezone: "UTC",
  });
  return built.text;
}

const limits = (toolNames: string[], facts: Record<string, unknown> = {}) =>
  renderLimits({ ctx: { harness: facts }, toolNames, gated: [], free: toolNames } as unknown as HarnessView).join("\n");

const count = (text: string, part: string) => text.split(part).length - 1;

describe("the harness sets the working language", () => {
  test("in CONVERSATION, once, with the words that carry it", () => {
    const text = harness(["exec", "read", "write", "plan", "notes", "delegate", "ask_agent", "memory_write"]);
    expect(count(text, WORKING_LANGUAGE)).toBe(1);
    const conversation = text.slice(text.indexOf("\nCONVERSATION\n"));
    expect(conversation).toContain(`- ${WORKING_LANGUAGE}`);
    expect(WORKING_LANGUAGE).toContain("Your working language is English, whatever language the person speaks: your thinking, plans, notes, briefs to other agents");
    expect(WORKING_LANGUAGE).toContain("the text between your steps where nobody reads it");
    expect(WORKING_LANGUAGE).toContain("What reaches a person is in that person's language");
  });

  test("to a helper and to an agent with no tools as well", () => {
    expect(limits(["exec"], { helper: true })).toContain(WORKING_LANGUAGE);
    expect(limits([])).toContain(WORKING_LANGUAGE);
  });

  test("work nobody watches is not asked for words in the person's language beside its first tool call", () => {
    // A mission's turn, a job's or a webhook's run: no preamble is sent from them (`pipeline/turn.ts`), and the line
    // contradicted a mission page asking for everything in English.
    const opening = "start your first reply with one short sentence";
    expect(limits(["exec"])).toContain(opening);
    expect(limits(["exec"], { unattended: true })).not.toContain(opening);
    expect(limits(["exec"], { unattended: true })).toContain(WORKING_LANGUAGE);
    expect(WORKING_LANGUAGE).toContain("in a chat where a person is waiting on you, the words between your steps, which are sent there");
  });
});

describe("a coding CLI's instructions carry the same rule", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("word for word, once, in Nouride's block", async () => {
    const folder = mkdtempSync(join(tmpdir(), "working-language-"));
    dirs.push(folder);
    const connection = { row: { name: "Claude Code", instructionFile: "CLAUDE.md" }, launch: {} } as unknown as CliConnection;
    await writeInstruction(fakeAgent(), connection, folder);
    const written = readFileSync(join(folder, "CLAUDE.md"), "utf8");
    expect(count(written, WORKING_LANGUAGE)).toBe(1);
    expect(written.indexOf(WORKING_LANGUAGE)).toBeLessThan(written.indexOf("<!-- nouride:end -->"));
  });
});

describe("the dashboard links: the one a tool's result carries, never one written (0.8.11)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("its words: the link given, never an address written by pattern, and none where a result has none", () => {
    expect(DASHBOARD_LINKS).toBe(
      "When the person asks about a mission, a schedule, an approval or anything else with a page on the dashboard, give the link your tool's result carries. Never write a dashboard address yourself; when a result has no link, there is none.",
    );
  });

  test("in TOOLS, once, to an agent with `work`, `mission` or `schedule`; not to one with none of them", () => {
    for (const name of ["work", "mission", "schedule"]) expect(count(harness(["exec", name]), `- ${DASHBOARD_LINKS}`)).toBe(1);
    expect(count(harness(["exec", "work", "mission", "schedule"]), DASHBOARD_LINKS)).toBe(1);
    expect(harness(["exec", "read", "send_file"])).not.toContain(DASHBOARD_LINKS);
  });

  test("in a coding CLI's block when it is lent one of them; not when it is lent none", async () => {
    const connection = { row: { name: "Claude Code", instructionFile: "CLAUDE.md" }, launch: {} } as unknown as CliConnection;
    const written = async (can: { links?: boolean }) => {
      const folder = mkdtempSync(join(tmpdir(), "dashboard-links-"));
      dirs.push(folder);
      const fingerprint = await writeInstruction(fakeAgent(), connection, folder, can);
      return { text: readFileSync(join(folder, "CLAUDE.md"), "utf8"), fingerprint };
    };
    const lent = await written({ links: true });
    const not = await written({});
    expect(count(lent.text, DASHBOARD_LINKS)).toBe(1);
    expect(lent.text.indexOf(DASHBOARD_LINKS)).toBeLessThan(lent.text.indexOf("<!-- nouride:end -->"));
    expect(not.text).not.toContain(DASHBOARD_LINKS);
    // A per-turn line, as `work`'s: a job's turn without the chat's tools keeps that chat's session.
    expect(lent.fingerprint).toBe(not.fingerprint);
  });
});
