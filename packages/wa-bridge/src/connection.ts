/**
 * One connection to WhatsApp: one Baileys socket at a time, reconnected when it closes, and what arrives on it.
 *
 * Its state is the connection's own: the socket, the login, the folders, the reconnect timer. It was the module's,
 * so a second number in the same daemon would have shared all of it and the two accounts fought over one socket;
 * the host refused a second for that reason, which was one WhatsApp number for each daemon. Each `Connection` now
 * holds its own, and says what happens to it through the `Speaker` it was given, so one number's events never go up
 * another's channel. `handler.ts` reaches it through the six methods of the `Link` it is, and nothing else does.
 */

import makeWASocket, {
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";
import { ensureDir, join, proxyAgentFor, writeBytesSync } from "@nouride/runtime";
import { useEncryptedAuthState, type EncryptedAuthState } from "./auth.ts";
import { editEvent, extensionFor, incoming, incomingEdit, messageEvent, selfIdsOf } from "./message.ts";
import { BRIDGE_PROTOCOL_VERSION } from "./protocol.ts";
import type { Speaker } from "./say.ts";
import { GroupSubjects } from "./subjects.ts";

/**
 * The one field this bridge reads off whatever Baileys threw.
 *
 * A disconnect arrives as `lastDisconnect.error`, and Baileys puts the reason in
 * `output.statusCode` because it throws `@hapi/boom` errors. Typed structurally rather than by
 * importing `Boom`: this is the only property ever read, and the import was buying a *type* from
 * `@hapi/boom@10` while the object producing it comes from the `@hapi/boom@9` nested under Baileys.
 * The two agree on `statusCode` today, which is exactly the kind of thing that is fine until it is
 * not — and it cost this plugin a direct dependency, in a plugin whose point is having almost none.
 */
type DisconnectError = { output?: { statusCode?: number } };

/**
 * Baileys' own logging, redirected to stderr.
 *
 * Not cosmetic. Baileys ships a pino logger that writes to **stdout** by default, and stdout here is
 * the protocol — its handshake dumps land in the middle of the JSON stream and the engine reads them
 * as garbage lines. Found by running the bridge for the first time: the very first connection
 * printed four pino objects before any protocol event.
 *
 * `silent` by default rather than off entirely, because a session that will not link is diagnosed
 * from exactly these lines. `NOURIDE_WA_LOG_LEVEL=debug` turns them on, on stderr, where the engine
 * already forwards them into the daemon log.
 */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function makeLogger(level: string, note: Speaker["note"]) {
  const threshold = LOG_LEVELS.indexOf(level as LogLevel);
  const write = (at: LogLevel) => (a: unknown, b?: unknown) => {
    if (threshold < 0 || LOG_LEVELS.indexOf(at) < threshold) return;
    const message = typeof a === "string" ? a : (b ?? "");
    const detail = typeof a === "string" ? undefined : a;
    note(`baileys ${at}: ${String(message)}`, detail);
  };
  const logger = {
    level,
    trace: write("trace"),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    fatal: write("fatal"),
    child: () => logger,
  };
  return logger;
}

/** Capped exponential backoff. A close that fails instantly must not become a tight loop. */
const BACKOFF_MAX_MS = 30_000;

/** After this many failures in a row, it stops being transient and the engine should know. */
const GIVE_UP_AFTER = 8;

export class Connection {
  private socket: WASocket | null = null;
  private auth: EncryptedAuthState | null = null;
  private sessionDir = "";
  private sessionKey = "";
  private mediaDir = "";
  private stopping = false;
  /** Whether this socket has actually signed in. Sending before it has is what threw inside Baileys. */
  private linked = false;

  /**
   * Which socket's events still count.
   *
   * Baileys emits `connection.update` more than once per socket, and a reconnect used to *replace* the
   * connection's `socket` while leaving the old object's listeners registered — so a second `close`
   * from a socket already replaced started another connection. Sockets multiplied instead of being
   * swapped, each one holding a WhatsApp session and its own credentials writer.
   *
   * This took a live server down: memory exhausted to the point that sshd could not complete a banner
   * exchange. The generation counter is the fix — a listener that is not the current generation returns
   * immediately — and `teardown()` is the belt to its braces. Counted for each connection: one number's
   * reconnect is no reason for another's listeners to stop.
   */
  private generation = 0;
  private starting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** Groups' subjects, for the `message` event's `chatTitle` — across reconnects: a group keeps its name. */
  private readonly subjects = new GroupSubjects();

  constructor(private readonly say: Speaker) {}

  /** The socket, while there is one. */
  currentSocket(): WASocket | null {
    return this.socket;
  }

  /** Whether WhatsApp has accepted the login on the current socket. */
  isLinked(): boolean {
    return this.linked;
  }

  /**
   * Connect with the session in `dir`, encrypted under `key` — what a `hello` starts.
   *
   * Afresh: not stopping, no attempts spent, no reconnect pending. Run in its own process a bridge always started so,
   * from a new module. Hosted in the daemon (`inproc`) the module stays, and what the last bridge left stayed with it:
   * the engine restarts a bridge that gave up by `shutdown` and a new `hello`, and `shutdown` had set `stopping` for
   * good — every connect after it returned at its first line. Live (2026-10-21): the internet dropped, the bridge gave
   * up after eight tries, the engine restarted it into nothing, and WhatsApp took no message until the daemon restarted.
   */
  async start(dir: string, key: string): Promise<void> {
    this.sessionDir = dir;
    this.sessionKey = key;
    this.stopping = false;
    this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.connect();
  }

  /**
   * Drop the connection and stay down: the `shutdown` command, and the in-process host letting the bridge go.
   *
   * The timer first: a reconnect firing between here and the caller's exit would open a socket nobody owns, and the
   * process that owned it is already on its way out.
   */
  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown();
  }

  /** Unlink this number. The one path that deletes: an explicit instruction, not an inferred one. */
  async logout(): Promise<void> {
    this.stopping = true;
    await this.socket?.logout();
    this.teardown();
    this.auth?.clear();
    this.auth = null;
    this.linked = false;
  }

  /** Where downloaded media lands, so the engine gets a path rather than bytes on the pipe. */
  private ensureMediaDir(): string {
    const dir = join(this.sessionDir, "media");
    ensureDir(dir, 0o700);
    return dir;
  }

  /** Drop the current socket and everything listening to it. */
  private teardown(): void {
    const old = this.socket;
    this.socket = null;
    if (!old) return;
    try {
      old.ev.removeAllListeners("connection.update");
      old.ev.removeAllListeners("creds.update");
      old.ev.removeAllListeners("messages.upsert");
    } catch {
      // Older Baileys builds expose this differently; ending the socket is what actually matters.
    }
    try {
      old.end(undefined);
    } catch {
      // Already gone.
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopping || this.reconnectTimer) return;

    if (this.attempt >= GIVE_UP_AFTER) {
      // Said once, and then this process stays put rather than spinning. The engine's own reconnect
      // takes over from here — which is correct, because respawning is the thing this process cannot
      // do for itself.
      this.say.note("giving up", { attempts: this.attempt, reason });
      this.say.emit({ type: "status", status: "disconnected", reason: `gave up after ${this.attempt} attempts` });
      return;
    }

    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** this.attempt);
    this.attempt += 1;
    this.say.note("reconnecting", { in_ms: delay, attempt: this.attempt, reason });
    this.reconnectTimer = setTimeout(() => {
      // One `try` around the tick, by hand: the bridge runs inside the daemon, where a throw out of a timer is an
      // uncaught exception that shuts it down, and it imports nothing of the engine's to contain one with. `connect` is
      // async, so what it throws arrives in the `catch` after it — and a throw from there is said, not left unseen.
      try {
        this.reconnectTimer = null;
        void this.connect()
          .catch((err) => {
            this.say.note("reconnect failed", String(err));
            this.say.emit({ type: "status", status: "disconnected", reason: String(err) });
            this.scheduleReconnect("start threw");
          })
          .catch((err) => this.say.note("could not report a failed reconnect", String(err)));
      } catch (err) {
        this.say.note("reconnect failed", String(err));
      }
    }, delay);
  }

  private async connect(): Promise<void> {
    // Two closes arriving together used to mean two sockets. One at a time, always.
    if (this.stopping || this.starting) return;
    this.starting = true;
    const mine = ++this.generation;

    try {
      this.teardown();

      // Opened once and reused. A fresh auth state per reconnect would give two live sockets two
      // different credential objects writing the same files — which corrupts the session rather than
      // merely wasting work.
      const auth = (this.auth ??= await useEncryptedAuthState(this.sessionDir, this.sessionKey, (line) => this.say.note(line)));
      this.mediaDir = this.ensureMediaDir();

      const { version } = await fetchLatestBaileysVersion();
      this.say.note("connecting", { version, generation: mine });

      // This connect's own socket by name: the listeners below are its, and `this.socket` may be another's by the time one fires.
      const socket = (this.socket = makeWASocket({
        version,
        auth: auth.state,
        // See makeLogger: without this, Baileys writes pino JSON to stdout and corrupts the protocol.
        // `warn` by default, matching the reference implementations. Silent was a mistake: the one thing
        // that would have explained a message accepted and never delivered is Baileys' own warning, and
        // it was being thrown away. `NOURIDE_WA_LOG_LEVEL=debug` turns it all the way up.
        logger: makeLogger(process.env.NOURIDE_WA_LOG_LEVEL ?? "warn", (message, detail) => this.say.note(message, detail)) as never,
        // We forward it instead. Printing to stdout would corrupt the protocol stream, and printing to
        // a terminal nobody is watching is why this field exists at all.
        printQRInTerminal: false,
        // Named, so the entry under Linked devices on the phone says what it is rather than "Ubuntu".
        browser: ["Nouride", "Chrome", "120.0"],
        // Left offline on purpose: an account marked online stops delivering push notifications to the
        // phone that owns it.
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        /**
         * Required on Baileys 7.
         *
         * When a sender's E2EE session needs re-establishing, WhatsApp asks for the original message
         * to complete a retry handshake. With no `getMessage` the decrypt fails, `msg.message` arrives
         * as null, and the message is **dropped without a trace** — which is exactly the class of
         * silent loss this bridge has already cost a day to. We keep no message store, and an empty
         * placeholder is enough for the handshake.
         */
        getMessage: async () => ({ conversation: "" }),
        /**
         * The proxy the environment names (`HTTPS_PROXY`, `NO_PROXY`), for the websocket: Bun's `ws` reads none of them
         * and takes it off this agent. Without it a pod that may only leave through its egress proxy dialled WhatsApp
         * directly, and every attempt closed with 408 after 20 s. Media and the version check go by `fetch`, which
         * reads the environment itself.
         */
        agent: proxyAgentFor(String(DEFAULT_CONNECTION_CONFIG.waWebSocketUrl)),
      }));

      socket.ev.on("creds.update", () => {
        try {
          if (mine !== this.generation) return;
          void this.auth?.saveCreds();
        } catch (err) {
          this.say.note("could not save the session's credentials", String(err));
        }
      });

      socket.ev.on("connection.update", (update) => {
        try {
          // A socket that has been replaced still holds this listener and still emits. Acting on it is
          // what multiplied connections until a live server ran out of memory.
          if (mine !== this.generation) return;

          const { connection, lastDisconnect, qr } = update;

          if (qr) this.say.emit({ type: "qr", qr });
          if (connection === "connecting") this.say.emit({ type: "status", status: "connecting" });

          if (connection === "open") {
            this.attempt = 0;
            this.linked = true;
            this.say.emit({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: this.socket?.user?.id ?? "" });
            this.say.emit({ type: "status", status: "connected" });
            return;
          }

          if (connection !== "close") return;
          this.linked = false;

          const status = (lastDisconnect?.error as DisconnectError | undefined)?.output?.statusCode;

          /**
           * `loggedOut` (401) stops this process — it does **not** delete the session.
           *
           * It used to. That cost a working link: WhatsApp sent one 401 twenty-six seconds after a
           * successful pairing, the credentials were wiped on the spot, the next connect started from
           * nothing, and the reply the person was waiting for died with
           * `authState.creds.me.id is undefined` because the socket was no longer signed in. A single
           * ambiguous signal must not be answered by destroying the only copy of something.
           *
           * So: say so, stop retrying, and leave the files. If the account really was unlinked the next
           * start says 401 again and stops again — noisy, not destructive. Deleting is what the explicit
           * `logout` command is for, and what removing the gateway now does.
           */
          if (status === DisconnectReason.loggedOut) {
            this.teardown();
            this.linked = false;
            this.say.emit({ type: "session_expired" });
            this.say.emit({ type: "status", status: "disconnected", reason: "logged out" });
            return;
          }

          if (this.stopping) {
            this.say.emit({ type: "status", status: "disconnected", reason: "shutting down" });
            return;
          }

          /**
           * `connecting`, not `disconnected` — this bridge is about to fix it itself.
           *
           * Reporting `disconnected` made the engine start its own recovery: tear the gateway down and
           * spawn a replacement bridge. Both layers then retried the same transient close, and since the
           * engine's reconnect did not kill the process it was replacing, every cycle left one more live
           * bridge behind.
           *
           * The division of labour is: a close this process can recover from is this process's problem
           * and stays invisible above; `disconnected` means it has genuinely given up, and only then
           * should anything above act.
           */
          this.say.emit({
            type: "status",
            status: "connecting",
            reason: lastDisconnect?.error ? String(lastDisconnect.error) : "connection closed",
          });

          /**
           * `restartRequired` (515) is normal, and it is the one that bites.
           *
           * WhatsApp sends it immediately after a successful pairing: the socket that carried the scan
           * has to be replaced before anything else works. So the very first thing a freshly linked
           * bridge does is reconnect — which was exactly the path that multiplied sockets. That is why
           * this survived every test and did not survive ten minutes after somebody scanned.
           */
          this.teardown();
          this.scheduleReconnect(
            status === DisconnectReason.restartRequired
              ? "restart required after pairing"
              : String(status ?? "closed"),
          );
        } catch (err) {
          this.say.note("could not handle a connection update", String(err));
        }
      });

      /**
       * A message the server took and then rejected.
       *
       * Baileys reports this through `messages.update` with `status: ERROR` and the platform's code in
       * `messageStubParameters` — the documented path, rather than the warning it also logs. Forwarded
       * up because nothing above could otherwise tell a delivered message from a refused one: the send
       * resolved, the ack came back, and the reply simply never appeared.
       *
       * `463` is the one that matters in practice: WhatsApp refusing to let a restricted account start
       * a new chat. Baileys' own note is explicit that retrying "counts as another reach out and worsens
       * the restriction", which is why this is reported rather than retried.
       */
      socket.ev.on("messages.update", (updates) => {
        try {
          if (mine !== this.generation) return;
          for (const entry of updates) {
            const status = entry.update?.status;
            if (status !== proto.WebMessageInfo.Status.ERROR) continue;
            const code = String(entry.update?.messageStubParameters?.[0] ?? "unknown");
            this.say.emit({
              type: "delivery_refused",
              chatId: entry.key?.remoteJid ?? "",
              messageId: entry.key?.id ?? "",
              code,
            });
            this.say.note("delivery refused", { chatId: entry.key?.remoteJid, code });
          }
        } catch (err) {
          this.say.note("could not read a delivery update", String(err));
        }
      });

      // A group renamed: its new subject, for the next message's `chatTitle` (0.7.24).
      socket.ev.on("groups.update", (updates) => {
        try {
          if (mine !== this.generation) return;
          for (const update of updates) if (update.id && update.subject) this.subjects.note(update.id, update.subject);
        } catch (err) {
          this.say.note("could not take in a group update", String(err));
        }
      });

      socket.ev.on("messages.upsert", (upsert) => {
        try {
          if (mine !== this.generation) return;
          if (upsert.type !== "notify") return;
          void Promise.all(
            upsert.messages.map((message) =>
              this.forward(message).catch((err) => this.say.note("could not forward a message", String(err))),
            ),
          );
        } catch (err) {
          this.say.note("could not take in new messages", String(err));
        }
      });
    } finally {
      this.starting = false;
    }
  }

  /**
   * The phone number behind a LID, from the session store.
   *
   * WhatsApp now addresses many conversations by **LID** (`100000000000001@lid`) instead of by phone
   * number. Baileys 7 learns the mapping and writes it into the auth store as
   * `lid-mapping-<lid>_reverse` — and then does not use it when addressing an outgoing message. A
   * reply sent to the bare LID is accepted by `sendMessage`, returns a message key, throws nothing,
   * and is never delivered.
   *
   * That cost a day of "it says it sent but nothing arrives", with clean logs on both sides. Both
   * reference implementations resolve the mapping themselves for the same reason.
   *
   * Returns null when there is no mapping yet, and the caller sends to the LID as before — which is
   * the best that can be done and is at least no worse than not trying.
   */
  phoneForLid(lid: string): string | null {
    const bare = lid.replace(/@.*$/, "").replace(/:\d+$/, "");
    const raw = this.auth?.read<unknown>(`lid-mapping-${bare}_reverse`);
    if (raw === null || raw === undefined) return null;
    // Baileys has stored this as a bare string and as a wrapped object across versions.
    const value =
      typeof raw === "string"
        ? raw
        : typeof raw === "number"
          ? String(raw)
          : typeof (raw as { pn?: unknown }).pn === "string"
            ? (raw as { pn: string }).pn
            : null;
    if (!value) return null;
    const digits = value.replace(/[^0-9]/g, "");
    return digits ? `${digits}@s.whatsapp.net` : null;
  }

  /** One incoming message up to the engine, with its media saved to disk first — or a person's edit of one. */
  private async forward(message: WAMessage): Promise<void> {
    const edited = incomingEdit(message);
    if (edited) return this.say.emit(editEvent(message, edited, selfIdsOf(this.socket?.user)));
    const found = incoming(message);
    if (!found) return;

    let media: { path: string; mimeType: string; kind: string; caption?: string; fileName?: string } | undefined;
    if (found.media) {
      try {
        const bytes = (await downloadMediaMessage(message, "buffer", {})) as Buffer;
        const path = join(this.mediaDir, `${crypto.randomUUID()}.${extensionFor(found.media.mimeType, found.media.fileName)}`);
        writeBytesSync(path, bytes, 0o600);
        media = {
          path,
          mimeType: found.media.mimeType,
          kind: found.media.kind,
          ...(found.text.trim() ? { caption: found.text } : {}),
          ...(found.media.fileName ? { fileName: found.media.fileName } : {}),
        };
      } catch (err) {
        // The text still goes through. Losing a photo is better than losing the message that came with
        // it, and the sender gets an answer either way.
        this.say.note("media download failed", String(err));
      }
    }

    // Read after the download, as it always was: the socket may have been replaced while it ran.
    const event = messageEvent(message, found, selfIdsOf(this.socket?.user), media, (lid) => this.phoneForLid(lid));
    // A group's name, where it is known — never waited for: the ask runs beside the message (`subjects.ts`).
    const current = this.socket;
    const chatTitle = event.chatType === "group" && current ? this.subjects.of(found.chatId, (jid) => current.groupMetadata(jid)) : undefined;
    this.say.emit(chatTitle ? { ...event, chatTitle } : event);
  }
}
