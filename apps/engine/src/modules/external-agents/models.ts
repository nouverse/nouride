/**
 * The models each external agent's CLI offered when its last session opened (0.8.1), kept by agent id: the Brain tab
 * suggests them, and the one it opened on says what the agent runs where its pack sets none. Lists showed the agent's
 * Nouride model there — its `[llm]`, which answers nothing of a CLI agent's (seen on the agent picker).
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
  const standsFor = on ? stoodFor(on, option.options) : undefined;
  return option.options.map(({ value, name }) => ({
    value,
    ...(name && name !== value ? { name } : {}),
    ...(on && value === on.value ? { current: standsFor?.name ?? value } : {}),
  }));
}

type Offered = NonNullable<SessionConfigOption["options"]>[number];

/**
 * The option an alias stands for, where the CLI says so by describing the alias with another option's name. Three ways
 * it has been said, each read from a real session: the name itself ("Opus 5.5"); the name at the head of a longer line
 * ("Opus 5.5 · Best for everyday, complex tasks"); and the one word the name begins with ("Opus", where "Opus 5.5" is
 * offered). The last stopped matching when only the first was read, and every list said `default` for what the default
 * was. A word that several names begin with names none of them: nothing is guessed, and the alias is shown as itself.
 */
function stoodFor(on: Offered, options: readonly Offered[]): Offered | undefined {
  const said = on.description?.trim();
  if (!said) return undefined;
  const others = options.filter((entry) => entry !== on && entry.name);
  const exact = others.find((entry) => entry.name === said);
  if (exact) return exact;
  // The head of a longer line, ended by a space: "Opus 5" is not the head of "Opus 5.5 · …".
  const heads = others.filter((entry) => said.startsWith(`${entry.name} `)).sort((a, b) => b.name!.length - a.name!.length);
  if (heads[0]) return heads[0];
  const family = others.filter((entry) => entry.name!.startsWith(`${said} `));
  return family.length === 1 ? family[0] : undefined;
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

/**
 * What a chat is on, and the way back, said under a message that failed on a model picked in that chat. The failure
 * alone ("You've reached your Fable limit") did not say the chat would keep asking that model: a person had to recall
 * having picked it, and how to undo that. Said whatever the CLI's words were, which are not read.
 */
export function pickedNote(model: string, cli: string, offered: readonly CliModel[]): string {
  const name = offered.find((entry) => entry.value === model)?.name;
  return `This chat is on \`${model}\`${name && name !== model ? ` (${name})` : ""}, picked here. \`/model default\` goes back to ${cli}'s own.`;
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
