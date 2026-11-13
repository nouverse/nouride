/**
 * No prompt text names a human language to reply or report in. An agent works in English and says what reaches a
 * person in that person's language (`WORKING_LANGUAGE`): a harness that said "answer in Indonesian" would be wrong for
 * every household that speaks something else, and one that said "reply in English" wrong for most of them.
 *
 * Rendered, not grepped: what is checked is what an agent is given — the global harness of an internal agent with every
 * built-in tool and its definitions, in a group, a DM, a helper's turn and a mission's turn; a coding CLI's instruction
 * block; and a mission's page. Not rendered here: wake texts, the brief a helper receives, and the memory, reflection
 * and compaction prompts. Code comments, the stemmer and `memory/english.ts`'s word lists name languages and are not
 * prompt text.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, type HarnessFacts } from "@/modules/llm/prompt/index.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { writeInstruction } from "@/modules/external-agents/instruction.ts";
import type { CliConnection } from "@/modules/external-agents/connection.ts";
import { missionPage } from "@/modules/missions/page.ts";
import { newMission } from "@/modules/missions/start.ts";
import { fakeAgent } from "../helpers.ts";

/** Human languages by their English names, and the ones people write in their own. Capitalised: "polish" is a verb. */
const LANGUAGES = [
  "Indonesian", "Bahasa", "Malay", "Javanese", "Sundanese", "Balinese", "Tagalog", "Filipino", "Vietnamese", "Thai",
  "Chinese", "Mandarin", "Cantonese", "Japanese", "Korean", "Hindi", "Urdu", "Bengali", "Tamil", "Arabic", "Hebrew",
  "Persian", "Farsi", "Turkish", "Russian", "Ukrainian", "Polish", "Czech", "Romanian", "Greek", "German", "Deutsch",
  "Dutch", "French", "Français", "Spanish", "Español", "Portuguese", "Italian", "Swedish", "Norwegian", "Danish",
  "Finnish", "Swahili",
];
const NAMED = new RegExp(`\\b(?:${LANGUAGES.join("|")})\\b`, "g");
/** The household's own, in any case: "reply in bahasa", "Indonesia's language" (either apostrophe) — not the country. */
const NAMED_ANY_CASE = /\b(?:bahasa|indonesian|indonesia['’]s language)\b/gi;
/** English named as the language of what reaches a person — not of the work. */
const ENGLISH_TO_A_PERSON = [
  /\b(?:reply|replies|respond|answer|answers|report|reports|talk|speak|say|tell|write to|messages? to (?:the|a) person|message (?:the|a) person|question|questions)\b[^.\n]{0,60}\bin English\b/gi,
  /\bEnglish is the language of (?:your |the )?(?:replies|answers|messages|reports)\b/gi,
];

/** Every built-in tool, as `tool-schema-budget.test.ts` builds them: each optional dependency present. */
function allTools() {
  const stub = new Proxy({}, { get: () => () => ({}) });
  const tools = createBuiltinTools({
    security: DEFAULT_CONFIG.security,
    startJob: (() => ({})) as never,
    memory: stub as never,
    sendFile: stub as never,
    attachmentRead: stub as never,
    nourideCli: { binary: "/bin/nouride", installDir: "/srv/nouride" } as never,
    update: stub as never,
    people: stub as never,
    sessionStatus: stub as never,
    runSubagent: stub as never,
    askAgent: stub as never,
    harness: stub as never,
    reflection: stub as never,
    mcpCatalog: { catalog: stub as never, linkFor: () => null },
    notes: stub as never,
  });
  tools.set("mission", createMissionTools(stub as never).chat);
  tools.set("work", createWorkTool(stub as never));
  tools.set("schedule", createScheduleTool({ chats: () => ({ chats: [], othersGateways: [] }), store: stub as never, timezone: () => "UTC", agentExists: () => true, post: async () => true }));
  return [...tools.values()].map((tool) => tool.definition);
}

const HARNESS: HarnessFacts = {
  approvalRequired: ["exec"],
  approvalAvailable: true,
  execPolicy: { grantsHeld: 2 },
  maxToolIterations: 25,
  maxTurnDurationMs: 300_000,
  commands: ["/help", "/new", "/status"],
  truncates: true,
  workspace: { dir: "/srv/agents/nouva", privateDir: "/srv/agents/nouva/private", roots: ["/srv/agents/nouva"] },
  otherAgents: { names: ["nox", "nero"], maxHops: 3, channel: "bus" },
  startsMissions: true,
  backgroundHelpers: 2,
  modelTiers: { small: "small-model", default: "default-model", high: "high-model" },
};

/** The global harness of an internal agent — in a group, a DM, a helper's turn, a mission's — with every tool's definition. */
function harnessTexts(): string[] {
  const definitions = allTools();
  const turns: { chatType: "group" | "dm"; facts: Partial<HarnessFacts> }[] = [
    { chatType: "group", facts: {} },
    { chatType: "dm", facts: {} },
    { chatType: "dm", facts: { helper: true, startsMissions: false } },
    { chatType: "dm", facts: { unattended: true, startsMissions: false } },
  ];
  return turns.map(({ chatType, facts }) => {
    const built = buildSystemPrompt({
      agent: fakeAgent(),
      tools: definitions,
      harness: { ...HARNESS, ...facts },
      gateway: "telegram",
      chatId: "chat-1",
      chatType,
      sessionId: "ses_1",
      model: "default-model",
      now: new Date("2026-10-29T00:00:00Z"),
      timezone: "UTC",
    });
    return [built.text, built.situation ?? "", JSON.stringify(definitions)].join("\n");
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function cliInstruction(): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), "prompt-languages-"));
  dirs.push(folder);
  const connection = { row: { name: "Claude Code", instructionFile: "CLAUDE.md" }, launch: {} } as unknown as CliConnection;
  await writeInstruction(fakeAgent(), connection, folder, { missions: true, work: true });
  return readFileSync(join(folder, "CLAUDE.md"), "utf8");
}

/** A mission's page with every optional line it can carry. */
function page(): string {
  const mission = {
    ...newMission(
      { agentId: "nouva", goal: "Every parser test passes", checks: ["bun test"], review: "The diff only touches the parser.", workdir: "/srv/repo", branch: "fix/parser", startedBy: "Mira", gatewayId: "telegram", chatId: "1", byAgent: "nouva", jobId: "job_1", request: "{}" },
      { id: "msn_0123456789", settings: DEFAULT_CONFIG.missions, privateDir: "/srv/agents/nouva/private", now: 0 },
    ),
    lastCheck: "`bun test` failed: 2 fail",
    answers: [{ question: "Which branch?", answer: "fix/parser", at: 0 }],
  };
  return missionPage({
    mission: mission as never,
    why: "the mission starts.",
    plan: undefined,
    parked: [{ id: "apr_1", what: "exec git push" }],
    handedOut: [{ id: "msn_9876543210", agentId: "nox", status: "done", report: "Reviewed.", reason: null }],
    personSaid: "tolong cek semua parser-nya ya",
    now: 0,
  });
}

function judge(text: string) {
  return {
    named: [...new Set([...(text.match(NAMED) ?? []), ...(text.match(NAMED_ANY_CASE) ?? [])])],
    englishToAPerson: ENGLISH_TO_A_PERSON.flatMap((pattern) => text.match(pattern) ?? []),
  };
}

describe("no prompt text names a language to reply or report in", () => {
  test("the global harness of an internal agent, with its tools", () => {
    for (const text of harnessTexts()) {
      expect(judge(text)).toEqual({ named: [], englishToAPerson: [] });
      expect(text).toContain("that person's language");
    }
  });

  test("a coding CLI's instruction block", async () => {
    const text = await cliInstruction();
    expect(judge(text)).toEqual({ named: [], englishToAPerson: [] });
    expect(text).toContain("that person's language");
  });

  test("a mission's page", () => {
    const text = page();
    expect(judge(text)).toEqual({ named: [], englishToAPerson: [] });
    expect(text).toContain("Only what reaches the person is in their language");
  });

  test("the guard sees what it is there for", () => {
    // Without these, a regex that matched nothing would pass every text above.
    expect(judge("- Answer in Indonesian unless they write in Bahasa Jawa.").named).toEqual(["Indonesian", "Bahasa"]);
    expect(judge("- Always reply to the person in English.").englishToAPerson).toEqual(["reply to the person in English"]);
    // The phrasings the first version missed.
    for (const said of ["reply in bahasa", "Use Indonesia's language with them", "Use Indonesia’s language with them"]) expect(judge(said).named).not.toEqual([]);
    for (const said of [
      "Write to the person in English.",
      "Messages to the person are in English.",
      "Ask your ask question in English.",
      "Tell the person, in English, what you did.",
      "English is the language of your replies.",
      // The guard had stopped catching this one.
      "Message the person in English.",
    ]) {
      expect([said, judge(said).englishToAPerson.length]).toEqual([said, 1]);
    }
    // Fine lines it must not fail on: the country, and English for what goes to another agent.
    for (const fine of ["Plans and notes are written in English; polish the draft.", "Times are Asia/Jakarta (Indonesia).", "A message to another agent is in English."]) {
      expect([fine, judge(fine)]).toEqual([fine, { named: [], englishToAPerson: [] }]);
    }
  });
});
