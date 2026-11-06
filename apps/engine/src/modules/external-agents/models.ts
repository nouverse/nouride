/**
 * The models each external agent's CLI offered when its last session opened (0.8.1), kept by agent id: the Brain tab
 * suggests them, and the one it opened on says what the agent runs where its pack sets none. Lists showed the agent's
 * Nouride model there — its `[llm]`, which answers nothing of a CLI agent's (the owner, on the agent picker).
 */

import type { NewSessionResult, SessionConfigOption } from "@nouride/acp";
import type { CliModel } from "@/commons/daemon-state.ts";

/**
 * The models a session's `model` option offers, as the Brain tab suggests them; null where it offers none. The one it
 * opened on carries `current`, as lists name it: an alias by the model it stands for, where the CLI describes it with
 * another option's name — Claude Code's `default` describes itself as "Opus 5.5", which says more than "default".
 */
export function offeredModels(opened: NewSessionResult | null): CliModel[] | null {
  const option = opened?.configOptions?.find((entry) => entry.id === "model");
  if (!option?.options?.length) return null;
  const on = option.options.find((entry) => entry.value === option.currentValue);
  const standsFor = on?.description ? option.options.find((entry) => entry !== on && entry.name === on.description) : undefined;
  return option.options.map(({ value, name }) => ({
    value,
    ...(name && name !== value ? { name } : {}),
    ...(on && value === on.value ? { current: standsFor?.name ?? value } : {}),
  }));
}

/**
 * A session's effort option: the one ACP files under `thought_level`, whatever the CLI calls it — Claude Code's is
 * `effort`, Codex's another id. Found by its category alone, so no CLI is named here.
 */
export function thoughtLevel(options: readonly SessionConfigOption[] | null | undefined): SessionConfigOption | undefined {
  return options?.find((option) => option.category === "thought_level");
}

/**
 * The efforts a session offers for the model it is on now, as the Brain tab shows them beside the model, the one it is
 * set to carrying `current`; empty where it offers none. Claude Code's follow its model: read after the model is set.
 */
export function offeredEfforts(options: readonly SessionConfigOption[] | null | undefined): CliModel[] {
  const option = thoughtLevel(options);
  return (option?.options ?? []).map(({ value, name }) => ({
    value,
    ...(name && name !== value ? { name } : {}),
    ...(value === option?.currentValue ? { current: value } : {}),
  }));
}

/** The kept models — or efforts — read once and written as a session changes them. */
export class OfferedModels {
  private kept: Record<string, CliModel[]>;

  constructor(private readonly file?: { load(): Record<string, CliModel[]>; save(models: Record<string, CliModel[]>): void }) {
    this.kept = file?.load() ?? {};
  }

  of(agentId: string): CliModel[] {
    return this.kept[agentId] ?? [];
  }

  keep(agentId: string, models: CliModel[]): void {
    if (!this.file || JSON.stringify(this.of(agentId)) === JSON.stringify(models)) return;
    this.kept = { ...this.kept, [agentId]: models };
    this.file.save(this.kept);
  }

  /** The model the agent's CLI opened its last session on, as lists name it; null before its first. */
  runsOn(agentId: string): string | null {
    return this.of(agentId).find((model) => model.current)?.current ?? null;
  }
}
