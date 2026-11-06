/**
 * Wire protocol for the WhatsApp bridge — the entire coupling between the engine
 * and `packages/wa-bridge`.
 *
 * The bridge depends on `@nouride/runtime` and nothing else in the repo (§6 of
 * docs/ARCHITECTURE.md), so it declares these same shapes by hand in its
 * `src/protocol.ts`. `scripts/check-seams.ts` holds the two copies equal, type
 * for type and the version with them: a field added here must be added there.
 * The `hello` handshake compares only the version, so it is not what keeps them
 * in step.
 *
 * Framing: newline-delimited JSON, one message per line, in both directions.
 */

export const BRIDGE_PROTOCOL_VERSION = 4;

/** Engine → bridge. */
export type BridgeCommand =
  | { type: "hello"; version: number; sessionDir: string }
  | { type: "send"; id: string; chatId: string; text: string; replyTo?: string; mentions?: string[] }
  /** `voice`: render it as a voice note, not an audio file — both are `audio/ogg`, so the mime type cannot say. */
  | { type: "send_media"; id: string; chatId: string; path: string; mimeType: string; caption?: string; mentions?: string[]; voice?: boolean }
  | { type: "typing"; chatId: string }
  /** Mark an inbound message read — sent only once the engine has accepted it. */
  | { type: "read"; chatId: string; messageId: string; participant?: string }
  | { type: "logout" }
  | { type: "shutdown" };

/** Bridge → engine. */
export type BridgeEvent =
  | { type: "ready"; version: number; jid: string }
  | { type: "qr"; qr: string }
  | { type: "status"; status: "connecting" | "connected" | "disconnected"; reason?: string }
  | { type: "session_expired" }
  | {
      type: "message";
      id: string;
      chatId: string;
      chatType: "dm" | "group";
      senderId: string;
      senderName: string;
      text: string;
      timestamp: number;
      replyTo?: string;
      /** Ids this message addressed, so a group bot can answer only when it was tagged. */
      mentions?: string[];
      /** The text of the message being replied to — the context a tag in a group refers to. */
      quotedText?: string;
      /** Who wrote the quoted message. */
      quotedSender?: string;
      /** Our own address on this account, so the engine can tell whether the mention was for us. */
      selfIds?: string[];
      /** `fileName`: a document's name as it was sent (0.7.27). */
      media?: { path: string; mimeType: string; kind: string; caption?: string; fileName?: string };
      /**
       * (4) A person's edit: the id of the message it changes, and `text` what that message says now. `id` is the
       * edit's own, and an edit carries no media — it is words.
       */
      edits?: string;
      /** (4, 0.7.24) A group's subject, when the bridge knows it — its name on WhatsApp. Absent in a one-to-one. */
      chatTitle?: string;
    }
  | { type: "ack"; id: string }
  /**
   * WhatsApp took the message and then refused it.
   *
   * Separate from `error`, which is a command that failed. This one arrives *after* a successful
   * send: `sendMessage` returned a key, the ack came back, and the server rejected it afterwards.
   * Nothing above could tell the difference, which is how it stayed silent.
   */
  | { type: "delivery_refused"; chatId: string; messageId: string; code: string }
  | { type: "error"; id?: string; message: string };
