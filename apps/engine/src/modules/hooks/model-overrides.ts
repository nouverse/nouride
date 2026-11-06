/**
 * A conversation's `/model` and `/effort`: set in its chat, dropped by `/model default`, `/effort default` and the endings
 * `ENDS` in `pipeline/conversation-end.ts` names (`/reset`, a rollover, a delete); `/new` keeps them, as §9.4 SPEC has it.
 *
 * Per conversation on purpose: a thing somebody asked for in this conversation, not a change to the agent's pack. Kept on
 * the conversation's row (076) and read from it each time, rather than held in memory: the daemon restarts at every
 * update, and each restart dropped them. Whatever takes the row away (a delete, the retention sweep) takes them with it.
 *
 * A stored value goes where a fresh one goes, so one the agent can no longer use breaks no turn: a model is a name never
 * checked against a list (`/model`), so one no longer served meets the provider's error or a fallback; a level its model
 * refuses meets `EffortGuard`, and one its CLI does not offer leaves the CLI's own. Only an effort that is no level at all
 * (written by a later release, or by hand) is read as none, since nothing downstream would know what to send.
 */

import { isLlmEffort, sessionIdFor, type LlmEffort, type SessionKey } from "@nouride/shared";
import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";

/** Where the choices are kept: the conversation's row (`SessionStore`). */
type ChoiceStore = Pick<SessionsPort, "choices" | "keepModel" | "keepEffort" | "dropModel" | "dropEffort">;

export class ModelOverrides {
  constructor(private readonly store: ChoiceStore) {}

  get(sessionId: string): string | undefined {
    return this.store.choices(sessionId).model ?? undefined;
  }

  /** By the conversation's key, not only its id: one with no row yet is given one to keep it on. */
  set(session: SessionKey, model: string): void {
    this.store.keepModel(session, model);
    this.refusals.delete(sessionIdFor(session));
  }

  clear(sessionId: string): void {
    this.store.dropModel(sessionId);
    this.refusals.delete(sessionId);
  }

  /**
   * The model that refused this chat's level, and the level, once the chat was told (0.8.17): told with the answer that
   * met it, and not again at every message after. A level or a model chosen since is told afresh. In memory: after a
   * restart the chat is told once more, which costs a line.
   */
  private refusals = new Map<string, { effort: LlmEffort; model: string }>();

  /**
   * `/effort` (0.8.16): how long a coding CLI thinks in this chat, and (0.8.17) what an agent's own model is sent. Beside
   * the model's, and dropped by the same endings, because it is the same kind of thing: asked for in this conversation,
   * not a change to the agent.
   */
  effortOf(sessionId: string): LlmEffort | undefined {
    const stored = this.store.choices(sessionId).effort;
    return stored !== null && isLlmEffort(stored) ? stored : undefined;
  }

  setEffort(session: SessionKey, effort: LlmEffort): void {
    this.store.keepEffort(session, effort);
    this.refusals.delete(sessionIdFor(session));
  }

  clearEffort(sessionId: string): void {
    this.store.dropEffort(sessionId);
    this.refusals.delete(sessionId);
  }

  /** What the chat was told its model refused, for `/effort` to say: the level and the model. */
  refusalOf(sessionId: string): { effort: LlmEffort; model: string } | undefined {
    return this.refusals.get(sessionId);
  }

  /** A refusal a turn met: true when the chat has not been told of it yet, and is to be now. */
  refused(sessionId: string, refusal: { effort: LlmEffort; model: string }): boolean {
    const told = this.refusals.get(sessionId);
    if (told && told.effort === refusal.effort && told.model === refusal.model) return false;
    this.refusals.set(sessionId, refusal);
    return true;
  }
}
