/**
 * A credential's way into one command, and the question that comes with it.
 *
 * `@nouride/policy`'s `secretsFor` says which of an agent's secrets a command's argv is bound to. Binding alone does
 * not close the leak: `twine upload --repository-url https://elsewhere` is a bound command, and so is a bound script
 * the agent rewrote a minute ago. So a command handed any secret asks — a credential leaving, which `balanced` asks too
 * and only `trusted` answers, whatever else let it run — unless a grant names those secrets and every file it runs. The approval card says which
 * variables it is handed, never their values, and the audit row keeps the names.
 */

import { autoApprovable, type PolicyAsk, type PolicyOutcome } from "@nouride/policy";
import { clip } from "@nouride/shared";

/** What one command is handed: its environment's secrets, and their names. */
export interface CommandSecrets {
  env: Record<string, string>;
  /** Every secret's name it is handed, for the audit row to keep. */
  secrets: string[];
  /**
   * Of those, the ones handed because the command is bound to them — what the gate asks about and a grant names. Not
   * a secret bound to `*`: every command holds that one, as every command did before secrets were scoped, and asking
   * for each would make an agent ask before every command, and void every grant it holds, on the day it upgraded.
   */
  bound: string[];
}

/**
 * An agent's credentials for its commands. Called, every value its commands could be handed — what their output is
 * masked with, whichever command printed it. `forCommand`, what one command receives: the secrets bound to its argv,
 * and only those; `null` is an interactive session, which only a secret bound to `*` reaches.
 */
export type ChildEnv = ((agentId: string) => Record<string, string>) & {
  forCommand(agentId: string, argv: readonly string[] | null): CommandSecrets;
};

/**
 * What a command is handed, less the secrets bound to its program — a mission's check (`ToolContext.checkOnly`): it reads,
 * and handed one it asks a person nobody is there to be. Those bound to every command it keeps, as every command does.
 */
export function withoutBound(handed: CommandSecrets): CommandSecrets {
  if (handed.bound.length === 0) return handed;
  const withheld = new Set(handed.bound.map(variableOf));
  return {
    env: Object.fromEntries(Object.entries(handed.env).filter(([name]) => !withheld.has(name))),
    secrets: handed.secrets.filter((name) => !handed.bound.includes(name)),
    bound: [],
  };
}

/** The variable a secret arrives as — `twit_auth_token` is `$TWIT_AUTH_TOKEN`. */
export function variableOf(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

let fieldsOf: (name: string) => Readonly<Record<string, string>> | undefined = () => undefined;

/**
 * What is said about each stored secret (0.8.19, its fields), read where an agent is told its credentials' names: the
 * store's, set once at boot, as the data folder is for the commands that name it (`credential-files.ts`).
 */
export function setSecretFields(read: (name: string) => Readonly<Record<string, string>> | undefined): void {
  fieldsOf = read;
}

/** The fields shown with a credential's name: at most six, each cut to a line's length, so no field fills a prompt. */
export function secretFieldsLine(name: string): string {
  const fields = Object.entries(fieldsOf(name) ?? {}).slice(0, 6);
  return fields.map(([field, text]) => `${field}: ${clip(text, 120)}`).join(", ");
}

/**
 * The decision for a command handed secrets: whatever let it run, it asks, unless a grant for these secrets did — its
 * key carries their names, so a grant from before they were bound does not match. Marked as a credential leaving, which
 * `balanced` does not answer by itself; a class `balanced` asks already on it stays. A refusal stays one, and the
 * question it stands in for is asked the same way.
 */
export function secretGate(outcome: PolicyOutcome, secrets: readonly string[], pinned: boolean): PolicyOutcome {
  if (secrets.length === 0) return outcome;
  if (outcome.action === "refuse") return outcome.unasked ? { ...outcome, unasked: credentialAsk(outcome.unasked, secrets, pinned) } : outcome;
  if (outcome.action === "run" && outcome.via === "grant") return outcome;
  return credentialAsk(outcome.action === "ask" ? outcome : null, secrets, pinned);
}

function credentialAsk(ask: PolicyAsk | null, secrets: readonly string[], pinned: boolean): PolicyAsk {
  const handed = `handed ${secrets.map((name) => `$${variableOf(name)}`).join(", ")}`;
  return {
    action: "ask",
    grantable: pinned && (ask?.grantable ?? true),
    reason: ask ? `${ask.reason}, and it is ${handed}` : `It is ${handed}.`,
    hardline: true,
    hardlineClass: ask?.hardlineClass && !autoApprovable(ask.hardlineClass) ? ask.hardlineClass : "credential-out",
  };
}
