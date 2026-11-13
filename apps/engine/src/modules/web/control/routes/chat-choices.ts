/**
 * A one-to-one conversation's model and effort, picked on its page: what `/model` and `/effort` do, with no message.
 *
 * The two commands were the only way, and nobody finds a command: somebody asked whether an agent's model could be
 * set from the chat at all. The page's picker keeps a choice where the commands keep theirs (the conversation's row,
 * through the pipeline), so the two never disagree: a choice is the conversation's alone, the agent's own answers every
 * other, and it ends where the conversation does.
 *
 * A message typed as `/model` would have done it too, and left a command and its answer in every conversation that
 * changed its mind. Here the choice is a fact of the conversation the page reads back, and the message stays the
 * person's.
 */

import type { ChatChoices } from "@nouride/wire";
import { effortRefusal, isLlmEffort, LLM_EFFORTS, sessionIdFor, type LlmEffort, type LoadedAgent, type Session, type SessionKey } from "@nouride/shared";
import { atLeast, type Principal } from "@/modules/users/auth.ts";
import { conversationNamed } from "../conversation.ts";
import { jsonBody } from "../payloads.ts";
import { INCOMPLETE } from "../plain.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { mayOpen, readerOf } from "../whose.ts";

const NOT_THERE = { error: "no such conversation", plain: "That conversation is not there any more." } as const;
/** A model's name as a provider or a CLI takes it: one word. `/model` takes the first word of what is typed. */
const MODEL_MAX = 200;

/** What a request asks a conversation to choose: a value, null for the agent's own back, absent for as it is. */
interface Choice {
  model?: string | null;
  effort?: LlmEffort | null;
}

/** The levels this agent's conversations can choose: its coding CLI's own where it has listed any, else every level. */
function effortsOf(deps: ControlDeps, agent: LoadedAgent): { offered: string[]; all: string[] } {
  const offered = agent.config.external ? (deps.externalAgents?.efforts.of(agent.config.id).map((entry) => entry.value) ?? []) : [];
  return { offered, all: offered.length > 0 ? offered : [...LLM_EFFORTS] };
}

/**
 * A request's `model` and `effort`, read as the commands read theirs: a model is a name never checked against a list
 * (a wrong one meets the provider's own answer at the next message), and a level is one of the levels, and one its
 * CLI offers where a CLI answers. Empty and `default` are the agent's own back.
 */
function readChoice(deps: ControlDeps, agent: LoadedAgent, body: Record<string, unknown>): Choice | { error: string; plain: string } {
  const choice: Choice = {};
  if (body.model !== undefined) {
    if (body.model !== null && typeof body.model !== "string") return { error: "`model` is a model's name, or null for the agent's own", plain: INCOMPLETE };
    const model = (body.model ?? "").trim();
    if (model.length > MODEL_MAX || /\s/.test(model)) return { error: "`model` is one word: a model's name as its provider takes it", plain: "A model's name is one word, with no spaces." };
    choice.model = model === "" || model === "default" || model === "reset" ? null : model;
  }
  if (body.effort !== undefined) {
    if (body.effort !== null && typeof body.effort !== "string") return { error: "`effort` is a level, or null for the agent's own", plain: INCOMPLETE };
    const level = (body.effort ?? "").trim().toLowerCase();
    if (level === "" || level === "default" || level === "reset") choice.effort = null;
    else {
      const { offered } = effortsOf(deps, agent);
      const refusal = effortRefusal(level, offered);
      if (refusal === "no-level" || !isLlmEffort(level)) return { error: `\`${level}\` is not a level: ${LLM_EFFORTS.join(", ")}, or default`, plain: INCOMPLETE };
      if (refusal === "not-offered") return { error: `its CLI does not offer \`${level}\` for the model it is on (it offers: ${offered.join(", ")})`, plain: "That level is not offered for the model it is on. Pick another." };
      choice.effort = level;
    }
  }
  return choice;
}

/**
 * A choice made on the page before a conversation's first message, which it comes with (`/chat/send`): kept before the
 * turn starts, so the first answer is the chosen model's. A refusal where it is no choice, and then nothing is sent.
 */
export function keepFirstChoice(deps: ControlDeps, agent: LoadedAgent, chatId: string, body: { model?: unknown; effort?: unknown }): { error: string; plain: string } | null {
  if (!deps.local || (body.model === undefined && body.effort === undefined)) return null;
  const choice = readChoice(deps, agent, { ...(body.model !== undefined ? { model: body.model } : {}), ...(body.effort !== undefined ? { effort: body.effort } : {}) });
  if ("error" in choice) return choice;
  deps.pipeline.chooseInChat({ agentId: agent.config.id, gatewayId: deps.local.id, chatId }, choice);
  return null;
}

/** What a conversation of this agent is answered with; `sessionId` absent for one that has not begun. */
function choicesOf(deps: ControlDeps, agent: LoadedAgent, sessionId?: string): ChatChoices {
  const chosen = sessionId ? deps.pipeline.chatChoice(sessionId) : {};
  const external = agent.config.external;
  const ops = external ? deps.externalAgents : undefined;
  // A coding CLI's agent runs on the CLI's model, never its pack's `[llm]`: the one its pack names, else the one its
  // last session opened on. Empty where neither says, and the CLI chooses.
  const own = external ? (external.model ?? ops?.models.runsOn(agent.config.id) ?? "") : agent.config.llm.model;
  const ownEffort = agent.config.llm.effort;
  return {
    model: { own, ...(chosen.model ? { chosen: chosen.model } : {}) },
    effort: {
      ...(ownEffort ? { own: ownEffort } : {}),
      ...(chosen.effort ? { chosen: chosen.effort } : {}),
      ...(chosen.effort && chosen.refused?.effort === chosen.effort ? { refusedBy: chosen.refused.model } : {}),
    },
    efforts: effortsOf(deps, agent).all,
    ...(external ? { cli: { id: external.cli, name: ops?.row(external.cli)?.name ?? external.cli, models: ops?.models.of(agent.config.id).map(({ value, name }) => ({ value, ...(name ? { name } : {}) })) ?? [] } } : {}),
  };
}

/** Whether a conversation's choice can be made from the dashboard: one of its own, with one agent. */
function pickedHere(deps: ControlDeps, session: Pick<Session, "gatewayId" | "chatId">): boolean {
  return deps.local !== undefined && session.gatewayId === deps.local.id && !deps.rooms?.get(deps.local.id, session.chatId);
}

export function registerChatChoiceRoutes(control: ControlApp, deps: ControlDeps): void {
  const readerIn = (c: { get(key: "principal"): Principal }) => readerOf(c.get("principal"), deps.ctx.config.people);

  /** What a conversation is answered with, or what a new one with this agent would be. */
  control.get("/chat/choices", (c) => {
    const named = c.req.query("session")?.trim();
    const session = named ? conversationNamed(deps, named) : null;
    if (named && (!session || !mayOpen(deps, readerIn(c), session))) return c.json(NOT_THERE, 404);
    const agent = deps.registry.get(session?.agentId ?? c.req.query("agent")?.trim() ?? "");
    if (!agent) return c.json({ error: "no such agent", plain: "That agent is not there any more. Reload the page." }, 404);
    // The conversation's id by its key: one whose first turn is still running has no row yet, and is found by that turn.
    return c.json(choicesOf(deps, agent, session ? sessionIdFor(session) : undefined) satisfies ChatChoices);
  });

  /** Choose for a conversation that has begun. One that has not takes its choice with its first message (`/chat/send`). */
  control.post("/chat/choices", async (c) => {
    // Whoever may write in the conversation: a viewer reads, and a choice changes what the next message costs.
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const session = typeof body.sessionId === "string" ? conversationNamed(deps, body.sessionId.trim()) : null;
    if (!session || !mayOpen(deps, readerIn(c), session)) return c.json(NOT_THERE, 404);
    const agent = deps.registry.get(session.agentId);
    if (!agent) return c.json({ error: "no such agent", plain: "That agent is not there any more. Reload the page." }, 404);
    // A room's agents each have a conversation of their own there, and a chat app's is written in its app: both keep
    // the commands, which say who they are for.
    if (!pickedHere(deps, session)) {
      return c.json({ error: "a choice is made here for a one-to-one conversation of the dashboard's own: elsewhere, `/model` and `/effort` in the chat", plain: "This is set in the chat itself, with /model and /effort." }, 409);
    }
    const choice = readChoice(deps, agent, body);
    if ("error" in choice) return c.json(choice, 400);
    const key: SessionKey = { agentId: session.agentId, gatewayId: session.gatewayId, chatId: session.chatId };
    deps.pipeline.chooseInChat(key, choice);
    deps.audit.record({ action: "chat_choice", actor: c.get("principal").actor, agentId: session.agentId, chatId: session.chatId, details: { ...("model" in choice ? { model: choice.model } : {}), ...("effort" in choice ? { effort: choice.effort } : {}) } });
    return c.json(choicesOf(deps, agent, sessionIdFor(key)) satisfies ChatChoices);
  });

  /**
   * The models to suggest for an agent's conversations: its provider's own list, read with the profile's credential
   * here. For whoever may write in a chat, where the list of a profile by its name is an admin's: this names no
   * profile and answers with names alone. An agent a coding CLI answers has its list in `choices`.
   */
  control.get("/chat/models", async (c) => {
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const agent = deps.registry.get(c.req.query("agent")?.trim() ?? "");
    if (!agent) return c.json({ error: "no such agent", plain: "That agent is not there any more. Reload the page." }, 404);
    if (agent.config.external || !deps.setup) return c.json({ models: [] } satisfies { models: string[] });
    let endpoint: ReturnType<ControlDeps["providers"]["endpointFor"]>;
    try {
      endpoint = deps.providers.endpointFor(agent.config.llm.provider);
    } catch {
      return c.json({ models: [] } satisfies { models: string[] });
    }
    const listed = await deps.setup.probe(endpoint);
    // A list that could not be had is no list: the field still takes a name typed, and why is the admin's to read
    // on the Models page.
    return c.json({ models: listed.ok ? listed.models : [] } satisfies { models: string[] });
  });
}
