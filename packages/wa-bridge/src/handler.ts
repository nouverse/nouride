/**
 * What the engine asks of the bridge, carried out: the protocol's commands, one line at a time.
 *
 * It holds no connection of its own. The socket and what can be done to it arrive as a `Link` — `connection.ts`'s
 * functions in the bridge, a stand-in in a test — so every command can be driven without WhatsApp.
 */

import { isLidUser, type WASocket } from "@whiskeysockets/baileys";
import { readBytesSync } from "@nouride/runtime";
import { BridgeExit } from "./io.ts";
import { cleanMentionText, extractMentions } from "./mentions.ts";
import { splitMessage } from "./message.ts";
import { BRIDGE_PROTOCOL_VERSION, type BridgeCommand } from "./protocol.ts";
import type { Speaker } from "./say.ts";
import { idToSend } from "./sent-here.ts";

/** What the handler does with a socket — all a stand-in has to answer. */
export type Sock = Pick<WASocket, "sendMessage" | "sendPresenceUpdate" | "readMessages">;

/** The connection, as the handler reaches it. */
export interface Link {
  /** The socket, while there is one. */
  currentSocket(): Sock | null;
  /** Whether WhatsApp has accepted the login on it. */
  isLinked(): boolean;
  /** Connect with the session in `dir`, encrypted under `key`. */
  start(dir: string, key: string): Promise<void>;
  /** Drop the connection and stay down. */
  stop(): void;
  /** Unlink this number and delete its session. */
  logout(): Promise<void>;
  /** The phone number behind a LID, when the session store knows it — said in the log, never sent to. */
  phoneForLid(lid: string): string | null;
  /** A file a message carried, downloaded now: where it was saved. */
  fetchMedia(ref: string): Promise<string>;
}

/**
 * The address a message should be sent to: the one it arrived on.
 *
 * An earlier version resolved `…@lid` to `…@s.whatsapp.net` through the stored mapping, on the
 * reasoning that a phone JID is the "real" address. That was wrong and made things worse. A libsignal
 * session is keyed by *address*, and the session WhatsApp established for this conversation is the
 * LID one — sending to the phone JID reaches for a different session, and libsignal answered by
 * closing the one that worked (`Closing session: SessionEntry {…}` in the log, at exactly that send).
 *
 * Both reference implementations send to the incoming address for this reason. One of them keeps a
 * LID→phone map and never consults it when sending, which is the same conclusion reached the same way.
 *
 * `phoneForLid` is kept because knowing the number behind a LID is genuinely useful — for identity and
 * for allowlists — just not for addressing.
 */
function sendTarget(chatId: string): { to: string; resolved: boolean } {
  return { to: chatId, resolved: false };
}

/**
 * A send that cannot hang forever.
 *
 * Baileys occasionally never settles — most often uploading media, less often on plain text — and a
 * bridge whose command loop is awaiting it stops answering entirely. Both reference implementations
 * wrap every send in a timeout for exactly this reason; failing loudly at sixty seconds is what lets
 * the engine buffer and retry instead of the whole gateway going quiet.
 */
const SEND_TIMEOUT_MS = Number(process.env.NOURIDE_WA_SEND_TIMEOUT_MS ?? 60_000);

export function withTimeout<T>(work: Promise<T>, what: string, ms = SEND_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Between chunks, so a split reply arrives in order rather than interleaved. */
const CHUNK_DELAY_MS = 300;

/** Where the session lives, before the engine's `hello` says otherwise, and the key it is encrypted under. */
export interface Settings {
  sessionDir: string;
  sessionKey: string;
}

export class Handler {
  /** Whether a `hello` has arrived. Nothing else is carried out before it. */
  private handshakeDone = false;
  /** Where the session lives unless the engine's `hello` names a folder, which wins: the engine holds the config. */
  private readonly sessionDir: string;
  /**
   * The key the session is encrypted under, handed over by the host when it opens the bridge and never read from the
   * environment: the daemon's `process.env` is inherited by every command an agent runs through `exec`, and a
   * WhatsApp session key there is one `printenv` away from the model. So it exists only in this object.
   */
  private readonly sessionKey: string;

  constructor(
    private readonly link: Link,
    settings: Settings,
    private readonly say: Speaker,
  ) {
    this.sessionDir = settings.sessionDir;
    this.sessionKey = settings.sessionKey;
  }

  /**
   * One protocol line, carried out. A line that is not a command is answered with an `error` event; a stop the bridge
   * decided on (`BridgeExit`) goes up to the host. One at a time — `index.ts`'s `handleLine` says why.
   */
  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      await this.handle(JSON.parse(trimmed) as BridgeCommand);
    } catch (err) {
      if (err instanceof BridgeExit) throw err;
      this.say.emit({ type: "error", message: `malformed command: ${String(err)}` });
    }
  }

  /** `fetch_media`, answered by its id when the download ends: the path, or why there is none. */
  private async fetchApart(id: string, ref: string): Promise<void> {
    try {
      this.say.emit({ type: "media", id, path: await this.link.fetchMedia(ref) });
    } catch (err) {
      this.say.emit({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handle(command: BridgeCommand): Promise<void> {
    if (command.type === "hello") {
      if (command.version !== BRIDGE_PROTOCOL_VERSION) {
        this.say.emit({
          type: "error",
          message: `protocol version mismatch: engine ${command.version}, bridge ${BRIDGE_PROTOCOL_VERSION}`,
        });
        this.say.exit(1);
      }
      this.handshakeDone = true;

      // The engine's value wins: the directory is a config setting and the engine is the one holding the config.
      const sessionDir = command.sessionDir || this.sessionDir;
      if (!sessionDir) {
        this.say.emit({ type: "error", message: "no session directory was given" });
        this.say.exit(1);
      }
      if (!this.sessionKey) {
        this.say.emit({
          type: "error",
          message: "no session key was given; refusing to write an unencrypted session",
        });
        this.say.exit(1);
      }

      try {
        await this.link.start(sessionDir, this.sessionKey);
      } catch (err) {
        this.say.emit({ type: "status", status: "disconnected", reason: String(err) });
        this.say.note("start failed", String(err));
      }
      return;
    }

    if (command.type === "shutdown") {
      this.link.stop();
      this.say.exit(0);
    }

    if (!this.handshakeDone) {
      this.say.emit({ type: "error", message: "no hello received" });
      return;
    }

    /**
     * A held file, fetched apart from the line of commands, and whether or not the number is linked this moment.
     *
     * Commands are taken one at a time, so a reply is never sent before the one asked first. A download awaited in that
     * line held every reply behind it for as long as the file and the network took: a reply past its acknowledgement's
     * time was sent again, the last files of a burst ran out of their own time waiting for the first, and a logout
     * queued behind it was dropped when the number was removed. The file is WhatsApp's to serve, so a number
     * reconnecting still hands it over.
     */
    if (command.type === "fetch_media") {
      void this.fetchApart(command.id, command.ref);
      return;
    }

    /**
     * Not connected, and not *signed in*, are different failures.
     *
     * A socket exists from the moment it is created; `creds.me` only exists once WhatsApp has accepted
     * the login. Sending in between threw `undefined is not an object (evaluating
     * 'authState.creds.me.id')` from inside Baileys — an error nobody could act on, attached to a
     * message that was then dropped. Said in words instead, so the engine can buffer and retry rather
     * than treat it as a broken socket.
     */
    const socket = this.link.currentSocket();
    if (!socket || !this.link.isLinked()) {
      this.say.emit({
        type: "error",
        ...("id" in command ? { id: command.id } : {}),
        message: socket
          ? "not linked yet: this number has not finished signing in to WhatsApp"
          : "not connected to WhatsApp",
      });
      return;
    }

    try {
      switch (command.type) {
        case "send": {
          /**
           * Chunked, timed out, and logged.
           *
           * `sendMessage` resolving is not delivery — it returns the message it built, and one built
           * for an address whose session cannot be established is accepted and then goes nowhere. That
           * failure left no trace on either side, which is how a person ended up staring at a chat that
           * never answered while every log said everything was fine. The returned key is the only
           * evidence that separates "sent" from "accepted and lost".
           */
          const target = sendTarget(command.chatId);
          const chunks = splitMessage(command.text);
          const mentions = extractMentions(command.text, command.mentions);
          let sent: Awaited<ReturnType<typeof socket.sendMessage>> | undefined;
          for (const [index, chunk] of chunks.entries()) {
            if (index > 0) await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
            const payload: Parameters<typeof socket.sendMessage>[1] = {
              text: cleanMentionText(chunk),
              ...(mentions.length > 0 ? { mentions } : {}),
            };
            // Its id chosen here and written down first: the install's other number may be handed it before this resolves.
            sent = await withTimeout(socket.sendMessage(target.to, payload, { messageId: idToSend() }), "sendMessage");
          }
          this.say.note("sent", {
            chatId: command.chatId,
            to: target.to,
            isLid: isLidUser(command.chatId) ?? false,
            phoneBehindLid: isLidUser(command.chatId) ? this.link.phoneForLid(command.chatId) : null,
            chunks: chunks.length,
            mentions: mentions.length,
            id: sent?.key?.id ?? null,
          });
          // Clears the typing bubble the turn raised. Without it WhatsApp leaves "typing…" up until it
          // times out on its own, which reads as a second reply still coming.
          void socket.sendPresenceUpdate("paused", target.to).catch(() => {});
          this.say.emit({ type: "ack", id: command.id });
          return;
        }

        case "send_media": {
          const kind = command.mimeType.split("/")[0];
          const mentions = extractMentions(command.caption ?? "", command.mentions);
          const caption = command.caption ? cleanMentionText(command.caption) : undefined;
          const fileBuffer = Buffer.from(readBytesSync(command.path));
          const content =
            kind === "image"
              ? { image: fileBuffer, caption }
              : kind === "video"
                ? { video: fileBuffer, caption }
                : kind === "audio"
                  ? {
                      audio: fileBuffer,
                      mimetype: command.mimeType,
                      /**
                       * Push-to-talk. The single field that separates a voice note from an audio file.
                       *
                       * Without it WhatsApp shows a file row with a play button; with it, the round
                       * voice bubble with the waveform. The engine says which was meant — the mime type
                       * cannot, since both are `audio/ogg`.
                       */
                      ...(command.voice ? { ptt: true } : {}),
                    }
                  : {
                      document: fileBuffer,
                      mimetype: command.mimeType,
                      fileName: command.path.split("/").pop() ?? "file",
                      caption,
                    };
          const payload = {
            ...content,
            ...(mentions.length > 0 ? { mentions } : {}),
          };
          await withTimeout(socket.sendMessage(sendTarget(command.chatId).to, payload as never, { messageId: idToSend() }), "sendMedia");
          this.say.emit({ type: "ack", id: command.id });
          return;
        }

        /**
         * Blue ticks, and only once the message has been taken seriously.
         *
         * Sent by the engine *after* it accepts a message, not on arrival: marking a stranger's message
         * read in `pair` mode would tell them they had been seen by someone who is in fact ignoring
         * them. Read means read.
         */
        case "read":
          await socket.readMessages([
            {
              remoteJid: command.chatId,
              id: command.messageId,
              fromMe: false,
              ...(command.participant ? { participant: command.participant } : {}),
            },
          ]);
          return;

        case "typing":
          // Plain `composing`, which is what the two working implementations send. An earlier version
          // asserted `available` first on the theory that WhatsApp ignores presence from an offline
          // client; neither reference does that, and theirs show typing.
          await socket.sendPresenceUpdate("composing", sendTarget(command.chatId).to);
          return;

        case "logout":
          // The one path that deletes: an explicit instruction, not an inferred one.
          await this.link.logout();
          this.say.emit({ type: "session_expired" });
          return;
      }
    } catch (err) {
      this.say.emit({
        type: "error",
        ...("id" in command ? { id: command.id } : {}),
        message: String(err),
      });
    }
  }
}
