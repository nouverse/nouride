/**
 * Credentials a person sends in a message, taken out before anything keeps or reads it.
 *
 * `arrive` calls `take` first, before the room's record, the inbox, a steer or a turn. What `findSecrets` sees in what a
 * person wrote — their words and what they quote — goes into `TransientSecrets` (`@nouride/secrets`), and its handle
 * into the text in its place. So what the daemon stores, what the dashboard shows and what a model reads say
 * `$TMP_SECRET_…`, and the value stays in memory for its hour, where a command is handed it (`exec`) and `secret_save`
 * keeps it. The platform's own copy of the message is the person's business; this is about the daemon's.
 *
 * The person is told as it happens, by the daemon rather than the agent: what was taken, and `/secret undo` for what
 * was not a secret — the message goes back as they wrote it, as an edit of itself (`edits.ts`), while an edit is still
 * answered.
 */

import type { AgentRegistry } from "@nouride/persona";
import { envNamesFor, findSecrets, type TransientSecrets } from "@nouride/secrets";
import { createLogger, type Gateway, type MessageEnvelope, type TakenSecret } from "@nouride/shared";
import type { SecretsHookPort } from "@/modules/hooks/types.ts";
import { secretScope, type SecretKeeping } from "@/modules/tools/held-secrets.ts";
import { isSystemEvent, type PipelineDeps } from "./deps.ts";
import { EDIT_WINDOW_MS, quotedId } from "./edit-rules.ts";

const log = createLogger("pipeline.secrets");

/** `/secret set <name> <value>`: the value is taken whatever it looks like — the person said it is a secret. */
const KEEP = /^(\/secret(?:@\S+)?\s+(?:set|replace)\s+\S+\s+)(\S[\s\S]*?)\s*$/i;
const HANDLE = /^\$TMP_SECRET_[0-9A-F]{12}$/;

/** A message something was taken from, as it was written — for `/secret undo`, and only while an edit is answered. */
interface Taken {
  original: MessageEnvelope;
  handles: string[];
  at: number;
}

export class ChatSecrets {
  /** By conversation and sender, newest last. */
  private readonly recent = new Map<string, Taken[]>();

  constructor(
    readonly held: TransientSecrets,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Take every credential out of what a person wrote, in place: the handles go into `text` and `quotedText`, and onto
   * `secrets` for the model to be told what each one is. Says what this message gave that was not held already — what
   * the person is told about; nothing for `/secret set`, whose own reply says.
   */
  take(envelope: MessageEnvelope): TakenSecret[] {
    if (envelope.senderIsBot || envelope.asWritten || isSystemEvent(envelope)) return [];
    const scope = secretScope(envelope);
    const before = new Set(Object.keys(this.held.valuesFor(scope)));
    const original: MessageEnvelope = { ...envelope, raw: null };
    const taken: TakenSecret[] = [];
    const hold = (value: string, label: string) => {
      const handle = this.held.hold(value, { scope, label, from: envelope.senderId });
      if (!taken.some((secret) => secret.handle === handle)) taken.push({ handle, label });
      return handle;
    };
    const swap = (text: string) => {
      let out = "";
      let at = 0;
      for (const match of findSecrets(text, "ingress")) {
        out += text.slice(at, match.start) + hold(match.value, match.pattern.label);
        at = match.end;
      }
      return out + text.slice(at);
    };

    envelope.text = swap(envelope.text);
    const keep = KEEP.exec(envelope.text);
    if (keep && !HANDLE.test(keep[2]!)) envelope.text = keep[1]! + hold(keep[2]!, "a secret to keep");
    if (envelope.quotedText) envelope.quotedText = swap(envelope.quotedText);
    if (taken.length === 0) return [];

    const known = envelope.secrets ?? [];
    envelope.secrets = [...known, ...taken.filter((secret) => !known.some((had) => had.handle === secret.handle))];
    // The platform's own object still says it. Nothing reads it past the adapter, and the inbox never kept it — but
    // nothing is left holding it either.
    envelope.raw = null;
    // `/secret set` says what it did itself, and is not put back: written out again it would be the value in the inbox
    // and the room's record. Telling the person it was taken, with an undo that does nothing, only confuses it.
    if (keep) {
      log.info("credentials taken out of a message", { gateway: envelope.gatewayId, chat_id: envelope.chatId, taken: taken.map((secret) => secret.label) });
      return [];
    }
    // Another of our bots' copy of this very message, in a room — its credentials the room's, taken already: one line,
    // one way back, one notice.
    if (!this.remember(scope, envelope.senderId, original, taken)) return [];
    log.info("credentials taken out of a message", { gateway: envelope.gatewayId, chat_id: envelope.chatId, taken: taken.map((secret) => secret.label) });
    return taken.filter((secret) => !before.has(secret.handle.slice(1)));
  }

  /**
   * The sender's message as they wrote it — the newest they sent here, or the one `handle` came from — as an edit of
   * itself, for `arrive` to deliver: answered as corrected, wherever it is (`edits.ts`). Its handles are let go. Null
   * when nothing they sent here was taken in the last `EDIT_WINDOW_MS`, the time an edit is still answered.
   */
  putBack(command: Pick<MessageEnvelope, "gatewayId" | "chatId" | "senderId">, handle?: string): MessageEnvelope | null {
    const key = `${secretScope(command)}\u0000${command.senderId}`;
    const list = (this.recent.get(key) ?? []).filter((taken) => this.now() - taken.at < EDIT_WINDOW_MS);
    const found = handle ? list.find((taken) => taken.handles.includes(handle)) : list.at(-1);
    if (!found) return null;
    this.recent.set(
      key,
      list.filter((taken) => taken !== found),
    );
    for (const held of found.handles) this.held.release(held);
    const { secrets: _secrets, ...original } = found.original;
    return {
      ...original,
      id: `${original.id}:as-written`,
      timestamp: this.now(),
      edit: { of: original.edit?.of ?? original.id, sentAt: original.edit?.sentAt ?? original.timestamp },
      asWritten: true,
    };
  }

  /** Keep it for `/secret undo` — unless it is another copy of the newest one kept, which says false. */
  private remember(scope: string, sender: string, original: MessageEnvelope, taken: readonly TakenSecret[]): boolean {
    const key = `${scope}\u0000${sender}`;
    const at = this.now();
    const list = (this.recent.get(key) ?? []).filter((had) => at - had.at < EDIT_WINDOW_MS);
    const newest = list.at(-1)?.original;
    // The same message as each bot is handed it: the same sender, time and words; in a Telegram basic group not the id.
    if (newest && newest.timestamp === original.timestamp && newest.text === original.text && newest.gatewayId !== original.gatewayId) return false;
    list.push({ original, handles: taken.map((secret) => secret.handle), at });
    // A handful per person per chat — undo reaches back to the newest, or names one — and set last, so the ceiling on
    // the conversations held, which every table kept in memory has, lets the quietest go first.
    this.recent.delete(key);
    this.recent.set(key, list.slice(-5));
    while (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!);
    return true;
  }
}

/** What the person reads when something they sent was taken: what, the handle it is now, and the way back. */
function takenNotice(taken: readonly TakenSecret[]): string {
  const what = taken.map((secret) => `${secret.label} (${secret.handle})`).join(", ");
  const it = taken.length === 1 ? "it" : "them";
  return (
    `🔒 Taken out of your message before anything stored or read it: ${what}. The agent can use ${it} in commands for an hour without seeing ${it}.\n` +
    `Not a secret? /secret undo in the next ${Math.round(EDIT_WINDOW_MS / 60_000)} minutes puts your message back as you wrote it.`
  );
}

/**
 * Which bot says it. In a one-to-one chat, the one it was sent to. In a room, the orchestrator's — the room's front
 * desk — where it has a connection up on this platform: whichever bot's copy of the message came first takes the
 * credential (`secretScope`), and that was Nestor's in a group where Nouva leads (2026-10-21). Another bot's, or none
 * configured: the copy's own.
 */
function speakerFor(deps: Pick<PipelineDeps, "config" | "gateways">, gateway: Gateway, envelope: MessageEnvelope): Gateway {
  const desk = envelope.chatType === "dm" ? undefined : deps.config.daemon.orchestrator;
  if (!desk) return gateway;
  const own = deps.config.gateways.find((instance) => instance.enabled && instance.platform === envelope.gateway && instance.agent === desk);
  const live = own ? deps.gateways.get(own.id) : undefined;
  return live && live.status === "connected" ? live : gateway;
}

/**
 * Tell the person what was taken: in the chat, from the daemon, and on the dashboard's timeline — where its own
 * connection hands a line only to a request still waiting for it.
 */
export function tellTaken(deps: Pick<PipelineDeps, "chatEvents" | "config" | "gateways">, gateway: Gateway, envelope: MessageEnvelope, taken: readonly TakenSecret[]): void {
  if (taken.length === 0) return;
  const text = takenNotice(taken);
  deps.chatEvents?.record({
    gatewayId: envelope.gatewayId,
    chatId: envelope.chatId,
    audience: "ui",
    kind: "secret",
    text,
    ...(envelope.senderId ? { actor: envelope.senderId } : {}),
    details: { handles: taken.map((secret) => secret.handle) },
  });
  const speaker = speakerFor(deps, gateway, envelope);
  // Quoted where that bot knows the message by this id — not in a Telegram basic group, which numbers it per bot.
  const quote = envelope.chatType === "dm" || (speaker !== gateway && envelope.idsPerConnection) ? {} : { replyTo: quotedId(envelope) };
  const say = (by: Gateway, quoted: object) => by.send({ gatewayId: by.id, chatId: envelope.chatId, text, ...quoted });
  void say(speaker, quote)
    // The orchestrator's bot may not be in this room: the copy's own then says it.
    .catch((err: unknown) => (speaker === gateway ? Promise.reject(err) : say(gateway, envelope.chatType === "dm" ? {} : { replyTo: quotedId(envelope) })))
    .catch((err: unknown) => log.warn("could not say what was taken out of a message", { chat_id: envelope.chatId, error: String(err) }));
}

/**
 * What `/secret` reaches (`hooks/builtins/secrets.ts`): the conversation's handles, the store and the packs through
 * `keeping` — `index.ts` holds those — and `deliver`, which hands a message put back to `arrive` as it would one from
 * the platform.
 */
export function secretsHookPort(o: {
  secrets: ChatSecrets;
  keeping: SecretKeeping | undefined;
  registry: AgentRegistry;
  mayManage: (envelope: MessageEnvelope) => boolean;
  deliver: (envelope: MessageEnvelope) => void;
  now?: () => number;
}): SecretsHookPort {
  const now = o.now ?? Date.now;
  return {
    held: (where) =>
      o.secrets.held.heldIn(secretScope(where)).map((secret) => ({ handle: secret.handle, label: secret.label, minutesLeft: Math.max(1, Math.ceil((secret.expiresAt - now()) / 60_000)) })),
    mayManage: o.mayManage,
    keep: async ({ name, handle, where, replace, actor, agentId }) => {
      if (!o.keeping) return { status: "invalid", error: "Keeping a secret is not available on this daemon." };
      const held = o.secrets.held.get(handle, secretScope(where));
      if (!held) return { status: "gone" };
      const exists = o.keeping.has(name);
      if (exists && !replace) return { status: "exists" };
      const saved = await o.keeping.keep({ name, value: held.value, actor }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
      if (!saved.ok) return { status: "invalid", error: saved.error };
      const bound = await o.keeping.bind(agentId, name).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
      return { status: exists ? "replaced" : "kept", handed: bound.ok ? { variable: `$${envNamesFor(name)[0]}`, already: !bound.changed } : { error: bound.error } };
    },
    putBack: (envelope, handle) => {
      const back = o.secrets.putBack(envelope, handle);
      if (back) o.deliver(back);
      return back !== null;
    },
  };
}
