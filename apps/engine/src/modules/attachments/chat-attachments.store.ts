/**
 * What files are in a conversation, and where to get one.
 *
 * Before this, a file was readable only by the agent the message was addressed to, during that turn:
 * a file another agent sent was invisible to everybody else, a file in an untagged message had no
 * reader at all, and an earlier file could not be re-read. So this is an index, not a second copy of
 * the bytes — a row says *what* is in the conversation and how to get it (`local_path` when some agent
 * has a durable copy, `handle` to fetch one otherwise), and reading is on demand, because an image
 * costs a vision call and a busy channel is no reason to spend one per file per agent.
 *
 * A room is keyed on the chat and not the connection. Six bots in one channel are six connections onto
 * one conversation, each handed its own copy of every message; the `ref` comes from the message id, so
 * the copies collapse to one row that keeps whichever connection arrived first. Scoping a room's read
 * by `gateway_id` would work for one agent and fail for the other five.
 *
 * A one-to-one chat is the other way round: it is the connection's. On Telegram and WhatsApp a DM's chat
 * id is the person's own id, so two of our bots talking to the same person share a chat id and nothing
 * else — see `inConversation`. `gateway_id` is stored for that, and because fetching needs it: a
 * Telegram `file_id` belongs to the bot that was given it. This is the only thing that touches the
 * table.
 *
 * The division of labour with `AttachmentStore` is worth stating, because the two are easy to
 * confuse: the store owns *bytes on disk*, scoped to one agent's conversation directory, and knows
 * nothing about who else is in the room. This owns *the conversation's list of files*, holds no
 * bytes at all, and is what makes one agent able to open a file another one received.
 */

import { createLogger, type Attachment, type ChatType, type Port } from "@nouride/shared";
import { createHash, type SqliteDb } from "@nouride/runtime";

const log = createLogger("attachments.index");

/**
 * A short, stable reference for one file.
 *
 * Derived rather than random, because the same message reaches every connection in the room and the
 * six arrivals have to collapse onto one row — a random id would register the same photo six times
 * under six names, and the model would be offered all six.
 *
 * Ten hex characters, not four: this is the primary key of a table spanning every chat, and a
 * collision loses a file silently (the second registration is a no-op). At 2^40 that is not a risk
 * worth a longer string the model has to copy without a typo.
 */
function attachmentRef(key: string): string {
  return `f${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

/** Which conversation a lookup is made in. An envelope and a tool's context each are one, as they stand. */
export interface FileScope {
  /** Platform. A room's key, with `chatId`. */
  gateway: string;
  /** The connection. A one-to-one chat's key, with `gateway` and `chatId` — see `inConversation`. */
  gatewayId: string;
  chatId: string;
  chatType: ChatType;
}

/**
 * The refs one message's files were indexed under, by position.
 *
 * Recomputed wherever it is needed rather than passed between modules, because it is a pure function
 * of the message and the position — which is exactly what makes one file reachable by one name
 * from every agent in the room, and from the intake that never saw the registration.
 *
 * Namespaced by the conversation and by whoever numbered the id. A bare message id is not unique:
 * Telegram numbers a supergroup's messages per chat, and each bot its own DMs and a basic group's
 * (`idsPerConnection`), so two bots' message 5 from the same person was one ref. The second
 * registration was dropped, and the second bot's `markStored` pointed the first bot's row at the second
 * bot's copy (#12).
 */
export function messageAttachmentRefs(
  message: FileScope & { idsPerConnection?: boolean },
  messageId: string,
  count: number,
): string[] {
  const numberedBy = message.chatType === "dm" || message.idsPerConnection ? message.gatewayId : message.gateway;
  return Array.from({ length: count }, (_unused, index) =>
    attachmentRef(JSON.stringify([numberedBy, message.chatId, messageId, index])),
  );
}

/**
 * The ref each of a message's own files was indexed under, by position in it — each under the message it came with,
 * where a burst was folded into this one (`Attachment.from`), as it was registered when that message arrived.
 */
export function ownAttachmentRefs(message: FileScope & { idsPerConnection?: boolean; id: string; attachments?: readonly Attachment[] }): string[] {
  return (message.attachments ?? []).map((attachment, index) => {
    const from = attachment.from ?? { message: message.id, position: index };
    return messageAttachmentRefs(message, from.message, from.position + 1)[from.position]!;
  });
}

export interface ChatAttachment {
  ref: string;
  /** Platform. The room key, with `chatId`. */
  gateway: string;
  chatId: string;
  /**
   * The connection that saw it first — tried first when bytes have to be fetched. In a one-to-one chat,
   * the only one that saw it, and part of the conversation's key.
   */
  gatewayId: string;
  name: string;
  mimeType: string;
  kind: string;
  size?: number;
  /** A durable copy, when one exists. */
  localPath?: string;
  /** The platform reference, for fetching bytes the first time somebody asks. */
  handle?: Attachment;
  senderName?: string;
  fromAgent?: string;
  at: number;
}

interface Row {
  ref: string;
  gateway: string;
  chat_id: string;
  gateway_id: string;
  name: string;
  mime_type: string;
  kind: string;
  size: number | null;
  local_path: string | null;
  handle: string | null;
  sender_name: string | null;
  from_agent: string | null;
  at: number;
}

/** The window a prompt block covers — the same shape `ChatEventStore.since` takes. */
export interface FileWindow extends FileScope {
  /** Exclusive lower bound: when this agent was last spoken to. */
  after: number;
  /** Inclusive upper bound: when the triggering message arrived. */
  before: number;
  /**
   * Refs to leave out — the triggering message's own files.
   *
   * By identity rather than by an exclusive upper bound, which is what this replaced. A file
   * registered in the *same millisecond* as the message that follows it is a real case — the
   * dashboard registers and dispatches in one call, and a platform stamps whole seconds — and a
   * strict `<` dropped it from every window forever rather than from this one.
   */
  exclude?: readonly string[];
  limit: number;
}

export class ChatAttachmentIndex {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Record one file, or leave the existing row alone.
   *
   * Metadata only — nothing is fetched here. Registration happens before routing, on every message
   * with an attachment, in every chat: at that point nobody knows whether anyone will ever ask about
   * the file, and downloading a channel's images on the chance somebody might is the cost this whole
   * design exists to avoid.
   */
  register(input: Omit<ChatAttachment, "ref"> & { ref?: string; key?: string }): string | null {
    const ref = input.ref ?? (input.key ? attachmentRef(input.key) : null);
    if (!ref) return null;

    const handle = portableHandle(input.handle);
    // A buffer-only attachment has no size of its own on some platforms, and the listing is more
    // useful with one than without.
    const size = input.size ?? input.handle?.buffer?.byteLength;

    try {
      this.db
        .prepare(
          `INSERT INTO chat_attachments (ref, gateway, chat_id, gateway_id, name, mime_type, kind,
                                         size, local_path, handle, sender_name, from_agent, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ref) DO NOTHING`,
        )
        .run(
          ref,
          input.gateway,
          input.chatId,
          input.gatewayId,
          input.name,
          input.mimeType,
          input.kind,
          size ?? null,
          input.localPath ?? null,
          handle ? JSON.stringify(handle) : null,
          input.senderName ?? null,
          input.fromAgent ?? null,
          input.at,
        );
      return ref;
    } catch (err) {
      // Never fatal. A file that failed to index is a file nobody can re-read later, which is worse
      // than the message not arriving only if the message does not arrive.
      log.warn("could not index an attachment", { chat_id: input.chatId, error: String(err) });
      return null;
    }
  }

  /**
   * Note that a durable copy now exists on disk.
   *
   * Called by the intake, which stores the bytes for the agent it is running for, and by a read that
   * had to fetch them. Whoever materialised it last wins: a path is a hint, and a reader that finds
   * nothing there fetches again rather than failing.
   */
  markStored(ref: string, localPath: string): void {
    try {
      this.db.prepare(`UPDATE chat_attachments SET local_path = ? WHERE ref = ?`).run(localPath, ref);
    } catch (err) {
      log.warn("could not record an attachment path", { ref, error: String(err) });
    }
  }

  /**
   * One file, by ref, **inside one conversation**.
   *
   * The conversation in the query is the permission, not decoration: without it any agent holding a
   * ref could open a file from a conversation it has never been in, which is the exact leak the store's
   * per-conversation directories exist to prevent.
   */
  find(ref: string, scope: FileScope): ChatAttachment | null {
    const row = this.db
      .prepare<Row>(
        `SELECT * FROM chat_attachments
         WHERE ref = ? AND gateway = ? AND chat_id = ? AND (? IS NULL OR gateway_id = ?)`,
      )
      .get(ref, ...inConversation(scope));
    return row ? toAttachment(row) : null;
  }

  /** A conversation's files, newest first. What the tool answers a bare listing with. */
  recent(scope: FileScope, limit: number): ChatAttachment[] {
    return this.db
      .prepare<Row>(
        `SELECT * FROM chat_attachments
         WHERE gateway = ? AND chat_id = ? AND (? IS NULL OR gateway_id = ?)
         ORDER BY at DESC, ref LIMIT ?`,
      )
      .all(...inConversation(scope), Math.max(1, limit))
      .map(toAttachment);
  }

  /**
   * Files that arrived in a window, oldest first.
   *
   * The current message's own attachments are kept out by `exclude`, not by the clock: those are
   * described by the intake notice in the same prompt, and announcing them twice under two different
   * labels is how a model ends up reporting one photo as two.
   */
  since(window: FileWindow): ChatAttachment[] {
    if (window.limit <= 0) return [];
    const exclude = window.exclude ?? [];
    const notThese = exclude.length > 0 ? `AND ref NOT IN (${exclude.map(() => "?").join(", ")})` : "";
    return this.db
      .prepare<Row>(
        `SELECT * FROM chat_attachments
         WHERE gateway = ? AND chat_id = ? AND (? IS NULL OR gateway_id = ?) AND at > ? AND at <= ?
         ${notThese}
         ORDER BY at DESC, ref LIMIT ?`,
      )
      .all(...inConversation(window), window.after, window.before, ...exclude, window.limit)
      .map(toAttachment)
      .reverse();
  }

  /**
   * Drop index rows older than the retention window.
   *
   * Days, and the same number the room's messages use: this is a record of a conversation, and it
   * makes no sense for the list of files to outlive the transcript that mentions them. The bytes are
   * swept separately by `AttachmentStore.sweep`, on the attachment window — so a row can outlive its
   * file, which is why a read re-fetches rather than trusting the path.
   */
  sweep(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
    const result = this.db.prepare(`DELETE FROM chat_attachments WHERE at < ?`).run(cutoff);
    const removed = Number(result.changes ?? 0);
    if (removed > 0) log.info("attachment index swept", { removed, retention_days: retentionDays });
    return removed;
  }

  /** Everything in one conversation, for the dashboard's delete. */
  deleteForChat(scope: FileScope): number {
    const result = this.db
      .prepare(`DELETE FROM chat_attachments WHERE gateway = ? AND chat_id = ? AND (? IS NULL OR gateway_id = ?)`)
      .run(...inConversation(scope));
    return Number(result.changes ?? 0);
  }
}

/**
 * The rows one conversation may see: a room's are the platform's, a one-to-one chat's are its connection's. The
 * values for `gateway = ? AND chat_id = ? AND (? IS NULL OR gateway_id = ?)`, which every lookup here starts with.
 *
 * A DM's chat id is not a conversation on its own. On Telegram and WhatsApp it is the person's id, the
 * same for every one of our bots they talk to, so `telegram:nouva` and `telegram:nero` each in a DM
 * with one person are two conversations under one chat id — and matched on the platform and the chat
 * alone, either agent listed, was handed and could open what the person had sent the other (#12). In a DM
 * only the connection the message came in on registers its files, so its `gateway_id` is the conversation.
 *
 * Added to the room's key rather than put in its place, so the lookup stays on the `(gateway, chat_id,
 * at)` index — and a chat whose type nobody knows, which a job's turn takes for `"dm"`, sees less
 * rather than more.
 */
function inConversation(scope: FileScope): [string, string, string | null, string | null] {
  const connection = scope.chatType === "dm" ? scope.gatewayId : null;
  return [scope.gateway, scope.chatId, connection, connection];
}

/**
 * The handle, minus its bytes.
 *
 * `Attachment.buffer` is a `Uint8Array`, and `JSON.stringify` turns one into an object with a
 * numbered key per byte — a 2MB voice note becomes several megabytes of JSON in a row that exists to
 * hold *metadata*. Stripped here rather than at each caller, because the callers are the two places
 * an envelope arrives and one of them would eventually forget.
 *
 * What is lost is real and small: an attachment that arrived as bytes with no URL and no id cannot be
 * fetched again from this row. It can still be *read*, whenever some agent's intake wrote a durable
 * copy — which is the ordinary case, since the file came with a message somebody was addressed by.
 */
function portableHandle(handle: Attachment | undefined): Attachment | undefined {
  if (!handle) return undefined;
  const { buffer: _bytes, ...rest } = handle;
  return rest;
}

function toAttachment(row: Row): ChatAttachment {
  return {
    ref: row.ref,
    gateway: row.gateway,
    chatId: row.chat_id,
    gatewayId: row.gateway_id,
    name: row.name,
    mimeType: row.mime_type,
    kind: row.kind,
    ...(row.size === null ? {} : { size: row.size }),
    ...(row.local_path ? { localPath: row.local_path } : {}),
    ...handleOf(row.handle),
    ...(row.sender_name ? { senderName: row.sender_name } : {}),
    ...(row.from_agent ? { fromAgent: row.from_agent } : {}),
    at: row.at,
  };
}

/** A handle that will not parse is a handle we cannot fetch with, not a reason to lose the row. */
function handleOf(json: string | null): { handle?: Attachment } {
  if (!json) return {};
  try {
    return { handle: JSON.parse(json) as Attachment };
  } catch {
    return {};
  }
}

/**
 * The files in a conversation, as the daemon depends on it.
 *
 * Business logic takes this, never `ChatAttachmentIndex` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type ChatAttachmentsPort = Port<ChatAttachmentIndex>;
