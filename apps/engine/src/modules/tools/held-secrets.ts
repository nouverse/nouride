/**
 * The credentials people send in chat, as a tool meets them (0.7.17).
 *
 * `pipeline/chat-secrets.ts` takes one out of a message and holds it under a handle for the conversation it was sent
 * in. Here: a command that names a `$TMP_SECRET_…` handle is handed its value in its environment — the shell reads it,
 * the command line never holds it — and anything a tool hands back in that conversation is masked of every value it
 * holds. And the secret guard: once a turn has read something from outside the conversation, the first command in it
 * to use a handle asks, whatever the approval level and whatever grant would have let it run.
 */

import { type FieldChange, handlesIn, type TransientSecrets } from "@nouride/secrets";
import type { GateAsk, ToolContext } from "@nouride/shared";
import type { SaveResult } from "@/modules/config/settings/types.ts";

type Where = Pick<ToolContext, "gatewayId" | "chatId"> & Partial<Pick<ToolContext, "gateway" | "chatType">>;

/**
 * The conversation a credential sent in chat belongs to: where a command may be handed it.
 *
 * A one-to-one chat is one bot's: a token sent to Nouva privately is not Nestor's, though Telegram numbers both chats
 * by the person's own id. A room is the room's: every one of our bots there is handed the same message, and when the
 * scope was the connection each copy took it again — two notices in the group, from two bots, with two handles for one
 * token (2026-10-21). Now the first copy takes it, the others find it held, and whichever agent answers holds the handle
 * the person was told.
 */
export function secretScope(where: { gatewayId: string; chatId: string; gateway?: string; chatType?: string }): string {
  if (where.gateway && where.chatType && where.chatType !== "dm") return `${where.gateway}\u0000room\u0000${where.chatId}`;
  return `${where.gatewayId}\u0000${where.chatId}`;
}

/**
 * What keeps a credential for good: the secret store, for `secret_save` and `/secret set`, and an agent's pack, for its
 * guard. Supplied by boot (`boot/secret-keeping.ts`), where the store and the packs are.
 */
export interface SecretKeeping {
  has(name: string): boolean;
  keep(input: { name: string; value: string; actor: string; fields?: FieldChange }): Promise<SaveResult>;
  /** What is said about a stored secret, changed (0.8.19): its fields; the value untouched. */
  changeFields(input: { name: string; change: FieldChange; actor: string }): Promise<SaveResult & { fields?: Record<string, string> }>;
  /**
   * Hand a secret to every command of one agent — `[security.exec_secrets] <name> = ["*"]` in its pack — unless the pack
   * already names it. What keeping one from that agent's chat does next, so it works without anyone editing the pack;
   * narrowing it to some commands is a later edit of that line.
   */
  bind(agentId: string, name: string): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }>;
}

/** A handle a command names, and what it holds. */
export interface NamedHandle {
  handle: string;
  label: string;
}

/** What one command is handed of what its conversation holds, which handles it names, and those it names but are not held. */
export function heldForCommand(held: TransientSecrets | undefined, where: Where, argv: readonly string[]): { env: Record<string, string>; named: NamedHandle[]; missing: string[] } {
  const env: Record<string, string> = {};
  const named: NamedHandle[] = [];
  const missing: string[] = [];
  for (const handle of handlesIn(argv.join(" "))) {
    const secret = held?.get(handle, secretScope(where));
    if (!secret) {
      missing.push(handle);
      continue;
    }
    env[secret.name] = secret.value;
    named.push({ handle, label: secret.label });
  }
  return { env, named, missing };
}

/**
 * A command's stdin with every handle in it replaced by what it holds — for the one field the `nouride` tool feeds a
 * command, `gateway add --stdin`, `secret set --stdin`. No shell reads stdin, so a handle there reached the command as
 * the text `$TMP_SECRET_…` and was saved as two Telegram bots' tokens (2026-10-21). The handles it names are checked
 * and guarded with the command's own (`heldForCommand`), which refuses one this conversation does not hold.
 */
export function withHeldValues(held: TransientSecrets | undefined, where: Where, text: string): string {
  if (!held) return text;
  return text.replace(/\$\{?TMP_SECRET_[0-9A-F]{12}\}?(?![0-9A-Za-z_])/g, (found) => {
    const handle = `$${found.replace(/[${}]/g, "")}`;
    return held.get(handle, secretScope(where))?.value ?? found;
  });
}

/** Every value this conversation holds, by variable: what a tool's result here is masked against. */
export function heldValues(held: TransientSecrets | undefined, where: Where): Record<string, string> {
  return held ? held.valuesFor(secretScope(where)) : {};
}

/** Why a command naming a handle its conversation does not hold is refused, and what to do instead. */
export function notHeld(missing: readonly string[]): string {
  const these = missing.length === 1 ? `${missing[0]} is` : `${missing.join(", ")} are`;
  return `${these} not held in this conversation: a credential sent in chat lasts an hour, in the chat it was sent in. Ask for it again, or use a secret kept under a name`;
}

/** A list of arguments passes `$TMP_SECRET_…` as written; a string is read by the shell, which finds it in the environment. */
export const HANDLE_IN_ARGV =
  'a handle in a list of arguments would be passed as written. Send the command as one string ("curl -H \\"Authorization: Bearer $TMP_SECRET_…\\" https://…") and the shell reads it from the environment';

/**
 * The secret guard, for one agent's commands.
 *
 * Asked once per handle per turn: whoever said yes is not asked again for the same handle in the same turn, and the
 * next turn starts clean. A grant does not cover it and `/approvals balanced` does not drain it, because the case it
 * exists for is a turn that read something written to make it run exactly this; of the levels only `trusted`, which
 * asks nothing, answers it (0.8.0 — it was a switch of its own, `[security] secret_guard`).
 */
export class SecretGuard {
  private readonly cleared = new Set<string>();

  /** The question this command must be asked, or null. */
  ask(ctx: Pick<ToolContext, "turnId" | "untrustedRead">, named: readonly NamedHandle[]): GateAsk | null {
    if (named.length === 0 || !ctx.untrustedRead?.length) return null;
    const open = named.filter((handle) => !this.cleared.has(this.key(ctx, handle.handle)));
    if (open.length === 0) return null;
    const what = open.map((handle) => `${handle.handle} (${handle.label})`).join(", ");
    return {
      action: "ask",
      grantable: false,
      hardline: true,
      hardlineClass: "credential-out",
      reason: `it uses ${what}, sent in this chat, after this turn read outside content (${ctx.untrustedRead.join(", ")}), which could be what asked for it`,
    };
  }

  /** The command ran, so its handles were cleared for this turn — asked and answered, or never in question. */
  clear(ctx: Pick<ToolContext, "turnId">, named: readonly NamedHandle[]): void {
    // A call with no turn to belong to asks every time: there is no "this turn" to have answered for.
    if (!ctx.turnId) return;
    for (const handle of named) this.cleared.add(this.key(ctx, handle.handle));
    // A ceiling, as every table kept in memory has: the oldest turns' answers go first, and the worst a lost one does
    // is ask again.
    while (this.cleared.size > 512) this.cleared.delete(this.cleared.values().next().value!);
  }

  private key(ctx: Pick<ToolContext, "turnId">, handle: string): string {
    return `${ctx.turnId}\u0000${handle}`;
  }
}
