/**
 * What the engine asks of the bridge, carried out: the protocol's commands, one line at a time.
 *
 * It holds no connection of its own. The socket and what can be done to it arrive as a `Link` — `connection.ts`'s
 * functions in the bridge, a stand-in in a test — so every command can be driven without WhatsApp.
 */

import { isLidUser, type WASocket } from "@whiskeysockets/baileys";
import { readBytesSync } from "@nouride/runtime";
import * as io from "./io.ts";
import { BridgeExit } from "./io.ts";
import { cleanMentionText, extractMentions } from "./mentions.ts";
import { splitMessage } from "./message.ts";
import { BRIDGE_PROTOCOL_VERSION, type BridgeCommand } from "./protocol.ts";
import { emit, note } from "./say.ts";

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

/** Where the session lives and the key it is encrypted under, before the engine's `hello` says otherwise. */
export interface Settings {
  sessionDir: string;
  sessionKey: string;
}

export class Handler {
  /** Whether a `hello` has arrived. Nothing else is carried out before it. */
  private handshakeDone = false;
  private sessionDirFromEnv: string;
  /**
   * Read from the environment when nothing calls `configure()` — the way a bridge run as its own process
   * was given it.
   *
   * Changeable, for the in-process host — which must not use the environment at all. Putting the
   * session key into the daemon's own `process.env` would hand it to every command the agent runs
   * through `exec`, since a child inherits the parent's environment. `configure()` passes it directly
   * instead, so it exists only in this module.
   */
  private sessionKey: string;

  constructor(
    private readonly link: Link,
    settings: Settings,
  ) {
    this.sessionDirFromEnv = settings.sessionDir;
    this.sessionKey = settings.sessionKey;
  }

  /**
   * Supply what the environment would have carried, for a bridge running inside another process.
   *
   * The in-process host calls this; without it the environment is read. The session
   * directory still arrives over the protocol in `hello` and still wins over this — the engine holds
   * the config — so this is really about the key.
   */
  configure(input: { sessionDir?: string; encryptionKey: string }): void {
    this.sessionKey = input.encryptionKey;
    if (input.sessionDir) this.sessionDirFromEnv = input.sessionDir;
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
      emit({ type: "error", message: `malformed command: ${String(err)}` });
    }
  }

  private async handle(command: BridgeCommand): Promise<void> {
    if (command.type === "hello") {
      if (command.version !== BRIDGE_PROTOCOL_VERSION) {
        emit({
          type: "error",
          message: `protocol version mismatch: engine ${command.version}, bridge ${BRIDGE_PROTOCOL_VERSION}`,
        });
        io.exit(1);
      }
      this.handshakeDone = true;

      // The engine's value wins over the environment: the environment is how the key arrives, but the
      // directory is a config setting and the engine is the one holding the config.
      const sessionDir = command.sessionDir || this.sessionDirFromEnv;
      if (!sessionDir) {
        emit({ type: "error", message: "no session directory was given" });
        io.exit(1);
      }
      if (!this.sessionKey) {
        emit({
          type: "error",
          message: "NOURIDE_WA_SESSION_KEY is not set; refusing to write an unencrypted session",
        });
        io.exit(1);
      }

      try {
        await this.link.start(sessionDir, this.sessionKey);
      } catch (err) {
        emit({ type: "status", status: "disconnected", reason: String(err) });
        note("start failed", String(err));
      }
      return;
    }

    if (command.type === "shutdown") {
      this.link.stop();
      io.exit(0);
    }

    if (!this.handshakeDone) {
      emit({ type: "error", message: "no hello received" });
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
      emit({
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
            sent = await withTimeout(socket.sendMessage(target.to, payload), "sendMessage");
          }
          note("sent", {
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
          emit({ type: "ack", id: command.id });
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
          await withTimeout(socket.sendMessage(sendTarget(command.chatId).to, payload as never), "sendMedia");
          emit({ type: "ack", id: command.id });
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
          emit({ type: "session_expired" });
          return;
      }
    } catch (err) {
      emit({
        type: "error",
        ...("id" in command ? { id: command.id } : {}),
        message: String(err),
      });
    }
  }
}
