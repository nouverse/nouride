/**
 * The connection to WhatsApp: one Baileys socket at a time, reconnected when it closes, and what arrives on it.
 *
 * Its state is at module scope — the socket, the auth handle, the reconnect timer — so a second bridge in the same
 * module graph would share all of it; the in-process host refuses a second one for that reason
 * (`apps/engine/src/modules/gateways/bridge-inproc.ts`). `handler.ts` reaches it through the six functions it exports
 * (the `Link` it is given), and nothing else does.
 */

import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";
import { ensureDir, join, writeBytesSync } from "@nouride/runtime";
import { useEncryptedAuthState, type EncryptedAuthState } from "./auth.ts";
import { editEvent, extensionFor, incoming, incomingEdit, messageEvent, selfIdsOf } from "./message.ts";
import { BRIDGE_PROTOCOL_VERSION } from "./protocol.ts";
import { emit, note } from "./say.ts";
import { GroupSubjects } from "./subjects.ts";

/** Groups' subjects, for the `message` event's `chatTitle` — across reconnects: a group keeps its name. */
const subjects = new GroupSubjects();

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

function makeLogger(level: string) {
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

let socket: WASocket | null = null;
let auth: EncryptedAuthState | null = null;
let sessionDir = "";
let sessionKey = "";
let mediaDir = "";
let stopping = false;
/** Whether this socket has actually signed in. Sending before it has is what threw inside Baileys. */
let linked = false;

/**
 * Which socket's events still count.
 *
 * Baileys emits `connection.update` more than once per socket, and a reconnect used to *replace* the
 * module-level `socket` while leaving the old object's listeners registered — so a second `close`
 * from a socket already replaced started another connection. Sockets multiplied instead of being
 * swapped, each one holding a WhatsApp session and its own credentials writer.
 *
 * This took a live server down: memory exhausted to the point that sshd could not complete a banner
 * exchange. The generation counter is the fix — a listener that is not the current generation returns
 * immediately — and `teardown()` is the belt to its braces.
 */
let generation = 0;
let starting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

/** Capped exponential backoff. A close that fails instantly must not become a tight loop. */
const BACKOFF_MAX_MS = 30_000;

/** The socket, while there is one. */
export function currentSocket(): WASocket | null {
  return socket;
}

/** Whether WhatsApp has accepted the login on the current socket. */
export function isLinked(): boolean {
  return linked;
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
export async function start(dir: string, key: string): Promise<void> {
  sessionDir = dir;
  sessionKey = key;
  stopping = false;
  attempt = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  await connect();
}

/**
 * Drop the connection and stay down: the `shutdown` command, and the in-process host letting the bridge go.
 *
 * The timer first: a reconnect firing between here and the caller's exit would open a socket nobody owns, and the
 * process that owned it is already on its way out.
 */
export function stop(): void {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  teardown();
}

/** Unlink this number. The one path that deletes: an explicit instruction, not an inferred one. */
export async function logout(): Promise<void> {
  stopping = true;
  await socket?.logout();
  teardown();
  auth?.clear();
  auth = null;
  linked = false;
}

/** Where downloaded media lands, so the engine gets a path rather than bytes on the pipe. */
function ensureMediaDir(): string {
  const dir = join(sessionDir, "media");
  ensureDir(dir, 0o700);
  return dir;
}

/** Drop the current socket and everything listening to it. */
function teardown(): void {
  const old = socket;
  socket = null;
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

/** After this many failures in a row, it stops being transient and the engine should know. */
const GIVE_UP_AFTER = 8;

function scheduleReconnect(reason: string): void {
  if (stopping || reconnectTimer) return;

  if (attempt >= GIVE_UP_AFTER) {
    // Said once, and then this process stays put rather than spinning. The engine's own reconnect
    // takes over from here — which is correct, because respawning is the thing this process cannot
    // do for itself.
    note("giving up", { attempts: attempt, reason });
    emit({ type: "status", status: "disconnected", reason: `gave up after ${attempt} attempts` });
    return;
  }

  const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** attempt);
  attempt += 1;
  note("reconnecting", { in_ms: delay, attempt, reason });
  reconnectTimer = setTimeout(() => {
    // One `try` around the tick, by hand: the bridge runs inside the daemon, where a throw out of a timer is an
    // uncaught exception that shuts it down, and it imports nothing of the engine's to contain one with. `connect` is
    // async, so what it throws arrives in the `catch` after it — and a throw from there is said, not left unseen.
    try {
      reconnectTimer = null;
      void connect()
        .catch((err) => {
          note("reconnect failed", String(err));
          emit({ type: "status", status: "disconnected", reason: String(err) });
          scheduleReconnect("start threw");
        })
        .catch((err) => note("could not report a failed reconnect", String(err)));
    } catch (err) {
      note("reconnect failed", String(err));
    }
  }, delay);
}

async function connect(): Promise<void> {
  // Two closes arriving together used to mean two sockets. One at a time, always.
  if (stopping || starting) return;
  starting = true;
  const mine = ++generation;

  try {
    teardown();

    // Opened once and reused. A fresh auth state per reconnect would give two live sockets two
    // different credential objects writing the same files — which corrupts the session rather than
    // merely wasting work.
    if (!auth) auth = await useEncryptedAuthState(sessionDir, sessionKey);
    mediaDir = ensureMediaDir();

    const { version } = await fetchLatestBaileysVersion();
    note("connecting", { version, generation: mine });

    socket = makeWASocket({
      version,
      auth: auth.state,
      // See makeLogger: without this, Baileys writes pino JSON to stdout and corrupts the protocol.
      // `warn` by default, matching the reference implementations. Silent was a mistake: the one thing
      // that would have explained a message accepted and never delivered is Baileys' own warning, and
      // it was being thrown away. `NOURIDE_WA_LOG_LEVEL=debug` turns it all the way up.
      logger: makeLogger(process.env.NOURIDE_WA_LOG_LEVEL ?? "warn") as never,
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
    });

    socket.ev.on("creds.update", () => {
      try {
        if (mine !== generation) return;
        void auth?.saveCreds();
      } catch (err) {
        note("could not save the session's credentials", String(err));
      }
    });

    socket.ev.on("connection.update", (update) => {
      try {
        // A socket that has been replaced still holds this listener and still emits. Acting on it is
        // what multiplied connections until a live server ran out of memory.
        if (mine !== generation) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) emit({ type: "qr", qr });
        if (connection === "connecting") emit({ type: "status", status: "connecting" });

        if (connection === "open") {
          attempt = 0;
          linked = true;
          emit({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: socket?.user?.id ?? "" });
          emit({ type: "status", status: "connected" });
          return;
        }

        if (connection !== "close") return;
        linked = false;

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
          teardown();
          linked = false;
          emit({ type: "session_expired" });
          emit({ type: "status", status: "disconnected", reason: "logged out" });
          return;
        }

        if (stopping) {
          emit({ type: "status", status: "disconnected", reason: "shutting down" });
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
        emit({
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
        teardown();
        scheduleReconnect(
          status === DisconnectReason.restartRequired
            ? "restart required after pairing"
            : String(status ?? "closed"),
        );
      } catch (err) {
        note("could not handle a connection update", String(err));
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
        if (mine !== generation) return;
        for (const entry of updates) {
          const status = entry.update?.status;
          if (status !== proto.WebMessageInfo.Status.ERROR) continue;
          const code = String(entry.update?.messageStubParameters?.[0] ?? "unknown");
          emit({
            type: "delivery_refused",
            chatId: entry.key?.remoteJid ?? "",
            messageId: entry.key?.id ?? "",
            code,
          });
          note("delivery refused", { chatId: entry.key?.remoteJid, code });
        }
      } catch (err) {
        note("could not read a delivery update", String(err));
      }
    });

    // A group renamed: its new subject, for the next message's `chatTitle` (0.7.24).
    socket.ev.on("groups.update", (updates) => {
      try {
        if (mine !== generation) return;
        for (const update of updates) if (update.id && update.subject) subjects.note(update.id, update.subject);
      } catch (err) {
        note("could not take in a group update", String(err));
      }
    });

    socket.ev.on("messages.upsert", (upsert) => {
      try {
        if (mine !== generation) return;
        if (upsert.type !== "notify") return;
        void Promise.all(
          upsert.messages.map((message) =>
            forward(message).catch((err) => note("could not forward a message", String(err))),
          ),
        );
      } catch (err) {
        note("could not take in new messages", String(err));
      }
    });
  } finally {
    starting = false;
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
export function phoneForLid(lid: string): string | null {
  const bare = lid.replace(/@.*$/, "").replace(/:\d+$/, "");
  const raw = auth?.read<unknown>(`lid-mapping-${bare}_reverse`);
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

/** One incoming message up to the engine, with its media saved to disk first — or a person's edit of one (G11). */
async function forward(message: WAMessage): Promise<void> {
  const edited = incomingEdit(message);
  if (edited) return emit(editEvent(message, edited, selfIdsOf(socket?.user)));
  const found = incoming(message);
  if (!found) return;

  let media: { path: string; mimeType: string; kind: string; caption?: string; fileName?: string } | undefined;
  if (found.media) {
    try {
      const bytes = (await downloadMediaMessage(message, "buffer", {})) as Buffer;
      const path = join(mediaDir, `${crypto.randomUUID()}.${extensionFor(found.media.mimeType, found.media.fileName)}`);
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
      note("media download failed", String(err));
    }
  }

  // Read after the download, as it always was: the socket may have been replaced while it ran.
  const event = messageEvent(message, found, selfIdsOf(socket?.user), media);
  // A group's name, where it is known — never waited for: the ask runs beside the message (`subjects.ts`).
  const current = socket;
  const chatTitle = event.chatType === "group" && current ? subjects.of(found.chatId, (jid) => current.groupMetadata(jid)) : undefined;
  emit(chatTitle ? { ...event, chatTitle } : event);
}
