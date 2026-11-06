/**
 * What a model call made beside the conversation is shown of it: `/btw`'s answer (`side-question.ts`) and the line a
 * steered message gets in the agent's words (`steer-reply.ts`).
 *
 * Both are the agent speaking inside the conversation, so both see it as the agent does: its persona, what was said so
 * far, and the work in flight (the owner, 2026-11-05, v0.8.20_RFC item 1). What differs is what they may do. A side
 * question does nothing and is kept out of the conversation; a steered message goes into the turn and may change its
 * work. Each saw less before: the steer line was written from the message and four steps, and read an Armbian question
 * as one about Nouride's own OS (live, 2026-11-05), the turn correcting it a step later; a side question on a coding
 * CLI's turn saw the turn's prompt and none of its steps.
 */

import { messageText, type ChatMessage } from "@nouride/shared";
import type { JournalEntry } from "@/modules/turns/journal.store.ts";
import type { PipelineDeps } from "./deps.ts";

/** Characters of one message in the conversation: a long report says what it was about in its first lines. */
const PER_MESSAGE = 1_500;
/** Characters of the running turn's steps, its newest kept first. A design value (RFC_SIDE_QUESTIONS §5.1). */
const STEPS_BUDGET = 6_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Lines, the newest kept first within `budget` characters, in the order they happened. */
function newestWithin(lines: readonly string[], budget: number): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of [...lines].reverse()) {
    if (size + line.length > budget) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept.reverse().join("\n");
}

/**
 * The conversation so far as lines, the newest kept within `budget` characters. Words only: what was said, not the
 * tool calls between, which a finished turn's answer already speaks for. A conversation just reset or rolled over has
 * none, as the agent's next turn has none.
 */
export function conversationSoFar(messages: readonly ChatMessage[], budget: number): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    // One line a message, so where one ends and the next begins is never in doubt.
    const text = messageText(message.content).replace(/\s+/g, " ").trim();
    if (text) lines.push(`${message.role === "user" ? "They said" : "You said"}: ${clip(text, PER_MESSAGE)}`);
  }
  return newestWithin(lines, budget);
}

/** A running turn's journal as lines: what it was asked, what it said, what it called and what came back. */
export function stepsOf(entries: JournalEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!("message" in entry)) continue;
    const message: ChatMessage = entry.message;
    const text = messageText(message.content).trim();
    if (message.role === "user" && text) lines.push(`Asked: ${clip(text, 400)}`);
    if (message.role === "assistant") {
      if (text) lines.push(`You said: ${clip(text, 400)}`);
      for (const call of message.toolCalls ?? []) lines.push(`You called ${call.name} ${clip(JSON.stringify(call.arguments), 300)}`);
    }
    if (message.role === "tool") lines.push(`It answered: ${clip(text, 500)}`);
  }
  return newestWithin(lines, STEPS_BUDGET);
}

/**
 * The work this agent has in flight in this chat, as lines, or "" when none runs. An agent on its own model journals
 * every step it takes (`stepsOf`); a coding CLI's journal holds only its prompt, and what it does is in the turn's
 * recorded steps, the ones the dashboard shows. Found live (2026-11-05): a side question on Nix's turn, fifteen tool
 * calls into it, was shown one line, the prompt.
 */
export function workInFlight(deps: Pick<PipelineDeps, "turns" | "journal">, agentId: string, gatewayId: string, chatId: string): string {
  const running = deps.turns?.runningFor(agentId, gatewayId, chatId) ?? null;
  if (!running) return "";
  const entries = deps.journal?.read(running)?.entries ?? [];
  const journaled = entries.some((entry) => "message" in entry && entry.message.role !== "user");
  if (journaled) return stepsOf(entries);
  const recorded = (deps.turns?.stepsSince(running) ?? [])
    .filter((step) => step.kind === "tool" || step.kind === "tool_done" || step.kind === "note")
    .map((step) => `- ${clip(step.text.replace(/\s+/g, " ").trim(), 300)}`);
  return newestWithin([...stepsOf(entries).split("\n").filter(Boolean), ...recorded], STEPS_BUDGET);
}
