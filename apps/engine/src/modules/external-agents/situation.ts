/**
 * Who a coding CLI is talking to, and what is remembered about them (0.8.5): the lines a model's prompt has as DYNAMIC
 * and RECALL, worded by the same functions. Before, a CLI was given the sender's name in a group and nothing in a DM —
 * where a platform's display name is withheld — so Nix, asked whether it knew who it was talking to, guessed from one
 * message a steer had labelled.
 *
 * A model is told these on every request, in a system prompt it does not keep. A CLI keeps its own context, so it is
 * told them where they changed since its session was last told: a session's first turn, a new person speaking, a fact
 * learned. The conversations of the last days, filed or waiting, are left out: they change with every conversation the
 * household has, the CLI keeps its own of this chat, and `memory_search` reaches the rest.
 *
 * And how to write where its words go (0.8.10): the platform's line a model's prompt has — Telegram's "usually read on a
 * phone, so do not use tables". A CLI wrote tables there, and the gateway flattened them into lines it did not choose.
 *
 * And the other agents (0.8.11, RFC Part C §C.3): the OTHER AGENTS lines a model's prompt has, by the same two functions.
 * A CLI had their names alone, after `ask_agent:` in its first line: in a room it did not know the token that tags one —
 * on Discord the id, not the name — so it handed work over through `ask_agent`, which nobody in the room saw, and it was
 * not told the hop limit. Never the front desk's lines: a CLI is never the orchestrator.
 */

import { renderRecall } from "@/modules/llm/prompt/recall.ts";
import { busConventionLines, mentionConventionLines } from "@/modules/router/agent-mentions.ts";
import { renderDynamic, writingLine } from "@/modules/llm/prompt/sections.ts";
import type { TurnRequest } from "@/modules/llm/executor/types.ts";
import { idFormsFor } from "@/modules/people/match.ts";

/**
 * What a session was told: who is speaking, what is remembered here, how to write here, and the other agents and how to
 * reach them. Empty where there is none.
 */
export interface Situation {
  who: string;
  recall: string;
  writing: string;
  agents: string;
}

/**
 * The other agents as a model's OTHER AGENTS section has them, from what the turn carries (`TurnRequest.otherAgents`):
 * in a room each one's tag and the hop limit, in a DM `ask_agent` — and, where the agent's switches leave it out, that
 * nothing reaches them. Both tools are lent (`lent-tools.ts`), so what the turn holds is what the CLI can call.
 */
function agentsOf(req: TurnRequest): string {
  const others = req.otherAgents;
  if (!others || others.names.length === 0) return "";
  const has = (name: string) => req.toolset.definitions.some((definition) => definition.name === name);
  const lines =
    others.channel === "bus"
      ? busConventionLines({ others: others.names, ...(others.about ? { about: others.about } : {}), hasTool: has("ask_agent"), hasDelegate: has("delegate") })
      : mentionConventionLines({ others: others.names, ...(others.about ? { about: others.about } : {}), ...(others.mentions ? { mentions: others.mentions } : {}), maxHops: others.maxHops });
  return lines.join("\n").trim();
}

/**
 * This turn's situation. In a turn the daemon started nobody is speaking: who is here and what is remembered stand as the
 * session was told them. How to write does not — a scheduled job's words go to Telegram as a person's do, and a job's
 * session, which no person opened, was told nothing and wrote the tables the line is there to stop.
 */
export function situationOf(req: TurnRequest, told?: Situation): Situation {
  // Who else is here is the room's, not the speaker's: a job's turn is told it as a person's is, and keeps what was told.
  if (req.systemEvent) return { who: told?.who ?? "", recall: told?.recall ?? "", writing: writingLine(req.formatting), agents: agentsOf(req) || (told?.agents ?? "") };
  const [personRef, personRefPlatform] = req.gatewayId && req.senderId ? idFormsFor({ gatewayId: req.gatewayId, senderId: req.senderId }) : [];
  const who = renderDynamic({
    tools: req.toolset.definitions,
    gateway: req.gateway,
    ...(req.person ? { person: req.person } : {}),
    ...(req.senderName ? { senderName: req.senderName } : {}),
    ...(req.senderVerified ? { senderVerified: true } : {}),
    ...(req.peopleConfigured ? { peopleConfigured: true } : {}),
    ...(personRef ? { personRef } : {}),
    ...(personRefPlatform ? { personRefPlatform } : {}),
  });
  const recall = req.recall ? (renderRecall({ recall: { ...req.recall, recent: [], waiting: [] } }) ?? "") : "";
  return { who, recall, writing: writingLine(req.formatting), agents: agentsOf(req) };
}

/**
 * What of `now` the session was not told yet, as the first prompt's opening; empty where it was told all of it. The
 * other agents are said again when the room's agents change — a third one added — not on every turn.
 */
export function untold(now: Situation, told: Situation | undefined): string {
  const parts = [now.who !== told?.who ? now.who : "", now.recall !== told?.recall ? now.recall : "", now.writing !== told?.writing ? now.writing : "", now.agents !== told?.agents ? now.agents : ""].filter(Boolean);
  return parts.length ? `[Nouride: who is here, the other agents and how to write here, said again only when it changes]\n${parts.join("\n\n")}\n\n` : "";
}
