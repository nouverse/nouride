/**
 * Wire protocol — a hand-maintained copy of
 * `packages/shared/src/types/bridge.ts`.
 *
 * Not an import from `@nouride/shared`: this package depends on `@nouride/runtime`
 * and nothing else in the repo (§6 of docs/ARCHITECTURE.md). The two copies are
 * held equal by `scripts/check-seams.ts`, which fails on a field one side has and
 * the other does not, or a version bumped on one side only. The `hello` handshake
 * compares the version alone.
 */

export const BRIDGE_PROTOCOL_VERSION = 4;

export type BridgeCommand =
  | { type: "hello"; version: number; sessionDir: string }
  | { type: "send"; id: string; chatId: string; text: string; replyTo?: string; mentions?: string[] }
  /**
   * `voice` is what makes WhatsApp render a voice note rather than an audio file.
   *
   * Carried as its own field because the bridge decides the media kind from the **mime type**
   * (`audio/ogg` → audio), and `audio/ogg` is what both an audio file and a voice note are. The
   * engine knows which one the agent asked for and that intent had nowhere to travel, so a voice note
   * arrived as a plain audio message with no push-to-talk bubble.
   */
  | {
      type: "send_media";
      id: string;
      chatId: string;
      path: string;
      mimeType: string;
      caption?: string;
      mentions?: string[];
      voice?: boolean;
    }
  | { type: "typing"; chatId: string }
  /** Mark an inbound message read — sent only once the engine has accepted it. */
  | { type: "read"; chatId: string; messageId: string; participant?: string }
  | { type: "logout" }
  | { type: "shutdown" };

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
      /** `fileName`: a document's name as it was sent (0.7.27); absent for a photo, a video or a voice note. */
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
