/**
 * `/model` for an agent a coding CLI answers, against what its CLI offers.
 *
 * The command took any word: `/model fable` answered "Model for this chat is now `fable`." without saying that `fable`
 * was Fable 5.1 on the Claude Code installed, and a name the CLI does not have was only found out by the next message
 * failing. A CLI says which models it offers as a session opens, so a name is held to that list here, as `/effort` holds
 * a level to the CLI's levels, and each name is said with what it stands for. Before the CLI has said its list the name
 * is taken unchecked, and the reply says so. An agent its own model answers is not held to any list: its provider's
 * address can point anywhere.
 */

/** A model as the CLI offered it: the word it takes, and what it calls it where that is something else. */
export interface OfferedModel {
  value: string;
  name?: string;
}

/** A model as a chat reads it: the word to type, and what it stands for. */
export function named(value: string, offered: readonly OfferedModel[]): string {
  const name = offered.find((model) => model.value === value)?.name;
  return name && name !== value ? `\`${value}\` (${name})` : `\`${value}\``;
}

/** Every model the CLI offers, as `named` says each; empty where it has not said. */
export function offers(cli: string, offered: readonly OfferedModel[]): string {
  return offered.length === 0 ? "" : ` ${cli} offers: ${offered.map((model) => named(model.value, offered)).join(", ")}.`;
}

/**
 * The model a chat asked for, against the CLI's list: the word the CLI takes for it, or why not. Matched by the word,
 * whatever its case; with no list yet, taken as written and marked unchecked.
 */
export function picked(requested: string, cli: string, offered: readonly OfferedModel[]): { model: string; reply: string } | { refused: string } {
  if (offered.length === 0) {
    return { model: requested, reply: `Model for this chat is now \`${requested}\`. Not checked yet: ${cli} says which models it offers when its next message opens a session.` };
  }
  const match = offered.find((model) => model.value === requested) ?? offered.find((model) => model.value.toLowerCase() === requested.toLowerCase());
  if (!match) return { refused: `\`${requested}\` is not a model ${cli} offers here.${offers(cli, offered)}` };
  return { model: match.value, reply: `Model for this chat is now ${named(match.value, offered)}.` };
}
