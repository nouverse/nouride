/**
 * What an external agent's CLI reads about itself: a block in the CLI's own instruction file
 * — in its profile folder where it reads one there in any folder (`profileInstructionFile`: Codex's), or else in the
 * agent's folder (`instructionFile`: Claude Code's) — between markers Nouride
 * owns — who it is, how a message reaches it, which CLI answers as it, and its persona pack: IDENTITY.md, SOUL.md,
 * AGENTS.md and MEMORY.md, in the order a model's prompt has them. One pack whoever answers: the person edits the same
 * files on the same tab, and the CLI reads them as its own (0.8.1 — a separate instruction field read as a second
 * persona). The person's own lines in that file, above or below, are kept as they are.
 *
 * Written before a session opens, which is when a CLI reads the file, and only when the block changed. What it says is
 * fingerprinted too (0.8.8): a session opened on other instructions is let go at its conversation's next turn
 * (`runner.ts`), so a persona change reaches a CLI already going.
 */

import { agentCommandsHaveOwnUsers, join, readPlainTextFile, sha256Text, writeFileAsAgent, writeTextFileAtomic } from "@nouride/runtime";
import type { LoadedAgent, PersonaFiles } from "@nouride/shared";
import { underHeading } from "@nouride/persona";
import { WHEN_TO_START, WHO_SIGNS } from "@/modules/tools/builtins/mission.ts";
import { DASHBOARD_LINKS, WORKING_LANGUAGE } from "@/modules/llm/prompt/harness-limits.ts";
import type { CliConnection } from "./connection.ts";

/** Which memory counts, said to a CLI that keeps one of its own (`instructionBlock`). */
const CLI_MEMORY =
  "Your coding CLI may keep a memory of its own; Nouride and the other agents do not read it. What should last goes in MEMORY.md with `memory_write` (about=agent), and what you learn about a person with about=person.";

/** Found by its start alone, so a block whose first line a person reworded is still the one replaced. */
const OPENS = "<!-- nouride:begin";
const BEGIN = `${OPENS} (Nouride writes this part from the agent's persona files; change them on its Files tab, not here) -->`;
const END = "<!-- nouride:end -->";

/**
 * The block itself: the CLI's own prompt stays; this says where it is, what it is called, and who it is. MEMORY.md is
 * as it stood when the session opened — the CLI keeps it with `memory_write`, lent like the rest. `missions`: this
 * agent's chat can start one, and is told when to (0.8.5) — Claude Code reads an MCP tool's description only once it
 * looks the tool up, so the rule would otherwise be where it never looks. `work`: the same, for where it sees its own
 * missions, jobs and approvals — not knowing, one tried the `nouride` CLI, whose config its own user cannot read.
 * `memory`: which memory counts (0.8.10) — a CLI may keep one of its own, and Claude Code's own prompt tells it to write
 * there; Nix kept five notes in its profile folder for four days that no other agent, nor Nouride, ever read.
 */
function instructionBlock(input: { name: string; cli: string; persona: PersonaFiles; missions: boolean; work: boolean; memory: boolean; links: boolean }): string {
  const lines = [
    BEGIN,
    // No version: the one a CLI's ACP side reports is its adapter's (claude-agent-acp 0.95.0), which the agent took for
    // Claude Code's own (0.8.1, the live box).
    `You are ${input.name}, an agent in Nouride, answered by ${input.cli}. People message you from chat; a message starts with where it came from (the platform, DM or a group, and the agents \`ask_agent\` reaches from there, as "[telegram · DM · ask_agent: nouva, nox]"), then who sent it ("Mira: …").`,
    // The persona's files are a Nouride agent's, and name its tools; the CLI has its own for most of them.
    "Nouride's own tools are the `nouride` MCP server's: other agents (`ask_agent`), what the household remembers, this conversation's plan and notes, schedules, sending a message or a file, a file sent earlier in this conversation (`attachment_read`), keeping a credential sent in chat (`secret_save`), skills in the household's pool, a new agent, and an MCP server to add. Where the files below name a tool you do not have (`exec`, `read`, `write`, `edit`, `web_fetch`), use your own that does it.",
    // The harness's rule, word for word: a CLI's own prompt sets no working language, and the persona pack is the person's.
    WORKING_LANGUAGE,
    ...(input.work ? ["The `work` tool shows your own missions, background jobs and approvals."] : []),
    ...(input.memory ? [CLI_MEMORY] : []),
    ...(input.links ? [DASHBOARD_LINKS] : []),
    ...(input.missions ? [`${WHEN_TO_START} With the \`mission\` tool: action "start" drafts it (a goal, a brief and checks that prove it done); "edit" changes the draft until the person starts it. ${WHO_SIGNS}`] : []),
  ];
  const files: [string, string | undefined][] = [["IDENTITY.md", input.persona.identity], ["SOUL.md", input.persona.soul], ["AGENTS.md", input.persona.agents], ["MEMORY.md", input.persona.memory]];
  for (const [name, file] of files) {
    // Each under a heading of its own — its own first line where that is one (`# IDENTITY.md - Nix`), else its name.
    if (file?.trim()) lines.push("", underHeading(name, file));
  }
  lines.push(END);
  return lines.join("\n");
}

/** `current` with its Nouride block replaced by `block`, or the block added at the end; the person's lines unchanged. */
function withBlock(current: string, block: string): string {
  const start = current.indexOf(OPENS);
  const end = start >= 0 ? current.indexOf(END, start) : -1;
  if (start >= 0 && end >= 0) return `${current.slice(0, start)}${block}${current.slice(end + END.length)}`;
  if (!current.trim()) return `${block}\n`;
  return `${current.replace(/\n*$/, "")}\n\n${block}\n`;
}

/** The most an instruction file is read to: Nouride's block and a person's lines are a few kilobytes. */
const INSTRUCTION_MAX_BYTES = 1024 * 1024;

/** `current` without Nouride's block and the blank lines it was set apart by; the person's lines unchanged. */
function withoutBlock(current: string): string {
  const start = current.indexOf(OPENS);
  const end = start >= 0 ? current.indexOf(END, start) : -1;
  if (start < 0 || end < 0) return current;
  const before = current.slice(0, start).replace(/\n*$/, "");
  const after = current.slice(end + END.length).replace(/^\n*/, "");
  return before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
}

/** Rewrite one file of the agent's, as the agent, where the change is a change. */
async function rewrite(agent: LoadedAgent, path: string, change: (current: string) => string): Promise<void> {
  // The agent's own folders, which its CLI writes: read only as a plain file of its size (`readPlainTextFile`).
  const current = readPlainTextFile(path, INSTRUCTION_MAX_BYTES) ?? "";
  const next = change(current);
  if (next === current) return;
  if (agentCommandsHaveOwnUsers()) await writeFileAsAgent(agent.config.id, path, next);
  else await writeTextFileAtomic(path, next);
}

/**
 * Write the agent's block where its CLI reads it, as the agent, where it is not already what it says. `own` is the
 * agent's folder: where a CLI reads instructions from its profile in any folder, the block goes there, and leaves the
 * agent's folder — where 0.8.1–0.8.3 wrote it, and where it would be read a second time in every chat.
 *
 * Returns the block's fingerprint less MEMORY.md and the lines that follow the turn's tools, which a session is compared
 * by (0.8.8). MEMORY.md is the agent's own, written as it works and known to the session that wrote it; compared too,
 * every reload after a note would cost each conversation its CLI's context. A person's edit of it on the Files tab lets
 * the sessions go by itself (`renew`). The `mission` and `work` lines are there for a chat turn and not for a scheduled
 * job's or an `ask_agent` turn in the same chat: compared, a daily job dropped that chat's session twice a day (Nox's
 * review).
 */
export async function writeInstruction(agent: LoadedAgent, connection: CliConnection, own: string, can: { missions?: boolean; work?: boolean; memory?: boolean; links?: boolean } = {}): Promise<string> {
  const input = { name: agent.config.displayName, cli: connection.row.name, persona: agent.persona, missions: can.missions === true, work: can.work === true, memory: can.memory === true, links: can.links === true };
  const block = instructionBlock(input);
  const { row, launch } = connection;
  const profile = row.profileInstructionFile && launch.profileDir ? join(launch.profileDir, row.profileInstructionFile) : null;
  await rewrite(agent, profile ?? join(own, row.instructionFile), (current) => withBlock(current, block));
  if (profile) await rewrite(agent, join(own, row.instructionFile), withoutBlock);
  const { identity, soul, agents } = agent.persona;
  return sha256Text(instructionBlock({ ...input, missions: false, work: false, memory: false, links: false, persona: { identity, ...(soul ? { soul } : {}), ...(agents ? { agents } : {}) } }));
}
