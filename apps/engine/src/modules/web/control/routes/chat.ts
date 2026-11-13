/**
 * The dashboard's chat, as a set of resources rather than one long request.
 *
 * The old shape was a single blocking `POST /message` that returned the reply as its body, with an
 * in-memory activity feed polled alongside it. Three bugs came out of that, and they were all the
 * same bug: **the turn belonged to the HTTP request.** Refresh and the reply had nowhere to land, so
 * the page re-sent the message from a URL parameter. Refresh and the steps were gone, because they
 * only ever existed in React state. Close the tab and the work continued with nobody able to see it.
 *
 * Here the turn belongs to the daemon. `POST /chat/send` starts one and answers immediately with the
 * conversation it belongs to; `GET /sessions/:id/live` is how anybody — the tab that started it, a
 * second tab, the same tab after a reload — attaches to whatever is happening; `GET /sessions/:id/turns`
 * is the history, with the steps and the timings that used to be lost. Nothing here waits for a model.
 */

import type { ChatTurn, LiveTurn, RunningJob, SlashCommand, Transcript, UploadedFile } from "@nouride/wire";
import { sessionIdFor } from "@nouride/shared";
import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import { readFileBody, readFileRange, statFile } from "@nouride/runtime";
import {
  historyOf,
  messagesToTranscript,
  resolveCursor,
  toTurnPayload,
  withDurations,
} from "@/modules/turns/transcript.ts";
import { jsonBody, parseAttachments } from "../payloads.ts";
import { conversationNamed } from "../conversation.ts";
import { keepFirstChoice } from "./chat-choices.ts";
import { pageOf } from "../page.ts";
import { mayOpen, readerOf, type Reader } from "../whose.ts";
import type { Room } from "@/modules/rooms/rooms.store.ts";
import type { Principal } from "@/modules/users/auth.ts";
import type { Session } from "@nouride/shared";
import { MAX_FILES_PER_REQUEST, refuseUpload } from "../uploads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { CHAT_OFF, NOT_RUNNING } from "../plain.ts";
import { askedBy, groupLog } from "../senders.ts";

/** What a client sends. `sessionId` is what it has; everything else is optional. */
interface SendBody {
  text?: string;
  /** The conversation to continue, as it appears in the URL. */
  sessionId?: string;
  /** Or the chat id inside one, for a client that has that instead. */
  chatId?: string;
  agent?: string;
  senderId?: string;
  senderName?: string;
  attachments?: unknown;
  /** The dashboard page it was written from, where the client says one (`page.ts`). */
  page?: unknown;
  /** A model and an effort chosen on the page for this conversation, before its first message (`chat-choices.ts`). */
  model?: unknown;
  effort?: unknown;
}

/**
 * Types a browser renders without running anything in them.
 *
 * SVG is deliberately absent: it is an image to a person and a script host to a browser. PDF is in,
 * because every current browser renders it in an isolated viewer, and a report the agent produced is
 * the main thing an operator wants to *look* at rather than download.
 */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "application/pdf",
  "text/plain",
  /**
   * Audio, so the chat can play it where it stands.
   *
   * A voice note served as a download is a voice note nobody listens to — `<audio>` needs the bytes
   * inline. Safe for the same reason images are: a browser decodes these with a codec, not a script
   * engine, and unlike SVG there is no scripting surface in the format to abuse.
   */
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/webm",
  /**
   * Video, for the same reason and with the same safety argument as audio.
   *
   * A clip served as a download is a clip nobody watches: `<video>` needs the bytes inline, and an
   * agent that just recorded a screen capture has produced the one thing an operator most wants to
   * *look* at. These are container formats decoded by a codec — there is no scripting surface in them
   * to abuse, unlike SVG, which is why that one is still absent.
   */
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/mpeg",
]);

export function rendersInline(mimeType: string): boolean {
  return INLINE_TYPES.has(mimeType.split(";")[0]?.trim().toLowerCase() ?? "");
}

/**
 * A filename safe to put in a header.
 *
 * A header value cannot carry a quote or a newline without changing what the header means, and the
 * name came from a chat platform or a browser — neither of which promises anything about it.
 */
export function asciiName(name: string): string {
  const cleaned = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return cleaned.trim() || "file";
}

/**
 * The byte window a `Range` header asks for, resolved against the real file size.
 *
 * Returns `null` when there is no usable range and the whole file should be sent — which includes the
 * multi-range form (`bytes=0-99,200-299`). Ignoring a range is explicitly allowed; answering one with
 * a body that is not what it asked for is not, and a media element resyncs from a 200 without
 * complaint. No media element sends a multi-range request anyway.
 *
 * `"unsatisfiable"` is the third outcome and it is separate on purpose: a start past the end of the
 * file is a 416 carrying the true size, not a silent full-body 200 the client will mis-parse as the
 * tail it asked for.
 *
 * Both ends are **inclusive**, as HTTP defines them. Three forms exist and the third is the one that
 * gets forgotten: `bytes=-500` means the *last* 500 bytes, not "from 0 to 500".
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  // A zero-length file can satisfy no range at all, and the arithmetic below would produce -1.
  if (size === 0) return "unsatisfiable";

  let start: number;
  let end: number;

  if (!rawStart) {
    // Suffix form: the last N bytes, clamped to the whole file when N is larger than it.
    const suffix = Number.parseInt(rawEnd!, 10);
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    // An absent or oversized end means "to the end of the file" — `bytes=0-` is what Chrome opens with.
    end = rawEnd ? Math.min(Number.parseInt(rawEnd, 10), size - 1) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "unsatisfiable";
  }
  return { start, end };
}

/** Background jobs still running in one conversation, newest first. */
function runningJobs(
  deps: ControlDeps, sessionId: string,
  /**
   * Who and where, from the turn, for a conversation whose session is not stored yet.
   *
   * A new conversation's session is written when its first turn ends. Looked up by session alone,
   * every job that first turn started was invisible until the turn finished — so the strip "appeared
   * out of nowhere" exactly when the agent stopped, and only in new conversations (2026-10-07).
   */
  fallback?: { agentId: string; gatewayId: string; chatId: string },
): RunningJob[] {
  const session = deps.sessions?.find(sessionId) ?? fallback;
  if (!session || !deps.jobs) return [];
  return deps.jobs
    .running(session.agentId)
    // Scoped to this conversation, not the agent: a build started from Discord is not this chat's
    // business, and showing it here would make every window claim every job.
    .filter((job) => job.gatewayId === session.gatewayId && job.chatId === session.chatId)
    // `kind`, so the strip can say a helper is one (0.7.15) — its `command` is its goal.
    .map((job) => ({ id: job.id, command: job.command, startedAt: job.startedAt, kind: job.kind }));
}

/**
 * The same question for a room: every member's running jobs in this chat.
 *
 * A room has no single session to look up, and a job belongs to the agent that started it. Asked per
 * member and filtered on the chat, so a build one agent started from Discord does not appear in a
 * dashboard room that happens to contain it — the same scoping the per-session version does, said
 * once per member.
 */
function roomJobs(
  deps: ControlDeps,
  gatewayId: string,
  chatId: string,
  members: string[],
): RunningJob[] {
  if (!deps.jobs) return [];
  return members.flatMap((agentId) =>
    deps
      .jobs!.running(agentId)
      .filter((job) => job.gatewayId === gatewayId && job.chatId === chatId)
      .map((job) => ({ id: job.id, command: job.command, startedAt: job.startedAt, kind: job.kind })),
  );
}

/**
 * A conversation this reader may not open is answered as one that is not there (`whose.ts`): a transcript of nothing,
 * a feed with no turn, a 404 where a missing one gets a 404.
 */
const NOTHING: Transcript = { events: [], room: null, session: null, earlier: [], messages: [], turns: [] };
const NOT_THERE = { error: "no such conversation", plain: "That conversation is not there any more." } as const;

export function registerChatRoutes(control: ControlApp, deps: ControlDeps): void {
  const readerIn = (c: { get(key: "principal"): Principal }): Reader => readerOf(c.get("principal"), deps.ctx.config.people);
  /** A room of the dashboard's this reader may open: one they made or spoke in, or any for an admin. */
  const roomFor = (reader: Reader, chatId: string) => Boolean(deps.local && deps.rooms?.hasMembers(deps.local.id, chatId) && mayOpen(deps, reader, { gatewayId: deps.local.id, chatId }));
  /**
   * Take files from a browser and put them somewhere a turn can reach.
   *
   * Separate from the send, deliberately. A person picks three screenshots and then types for a
   * minute; uploading on pick means the message is instant when they finally hit enter, and a file
   * that is too large is refused while they can still do something about it rather than after they
   * have written a paragraph.
   *
   * Answers with paths, which is the only shape the rest of the daemon accepts — and those paths are
   * only usable by `/chat/send`, which checks they came from here. See `uploads.ts`.
   */
  control.post("/chat/upload", async (c) => {
    if (!deps.uploads) return c.json({ error: "uploads are not available on this daemon", plain: NOT_RUNNING }, 501);

    let body: Record<string, unknown>;
    try {
      // `all` so several files can share the `files` key, which is what a multiple-file input sends.
      body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    } catch {
      return c.json({ error: "expected a multipart form" }, 400);
    }

    const raw = body.files ?? body.file;
    const candidates = (Array.isArray(raw) ? raw : [raw]).filter(
      (entry): entry is File => entry instanceof File,
    );
    if (candidates.length === 0) return c.json({ error: "no files in the request" }, 400);
    if (candidates.length > MAX_FILES_PER_REQUEST) {
      return c.json(
        { error: `${candidates.length} files at once, over the limit of ${MAX_FILES_PER_REQUEST}` },
        413,
      );
    }

    // The operator's own limit, the same one every gateway's inbound files are held to. A second
    // number here would be a second answer to "how big is too big".
    const maxBytes = deps.ctx.config.attachments.maxSizeMb * 1024 * 1024;
    for (const file of candidates) {
      const refusal = refuseUpload({ name: file.name, size: file.size }, maxBytes);
      if (refusal) return c.json({ error: refusal }, 413);
    }

    const files = [];
    for (const file of candidates) {
      files.push(
        await deps.uploads.save({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          bytes: new Uint8Array(await file.arrayBuffer()),
        }),
      );
    }

    deps.audit.record({
      action: "chat_upload",
      actor: c.get("principal").actor,
      details: { files: files.map((f) => ({ name: f.name, bytes: f.bytes })) },
    });

    return c.json({ files } satisfies { files: UploadedFile[] });
  });

  /**
   * The slash commands this daemon answers.
   *
   * Read by the dashboard's composer so `/` offers the same list Telegram's menu shows. It comes from
   * the hook registry rather than a table in the browser: a command list maintained in two places is
   * one that disagrees with itself, and the copy people read is always the stale one.
   */
  control.get("/commands", (c) => {
    return c.json({ commands: deps.pipeline.commands() } satisfies { commands: SlashCommand[] });
  });

  /**
   * Start a turn. Do not wait for it.
   *
   * Answers with the conversation's id, which is the only thing the caller needs: everything else
   * about the turn is readable from `/sessions/:id/live` a moment later, by this client or any other.
   *
   * The checks that happen here are the ones a client cannot recover from on its own — no local
   * gateway, no such agent, an agent that is disabled or paused. Everything else is the pipeline's to
   * decide, and it decides asynchronously.
   */
  control.post("/chat/send", async (c) => {
    if (!deps.local) {
      return c.json({ error: "the local gateway is not enabled: set [control] chat = true", plain: CHAT_OFF }, 409);
    }
    if (!deps.turns) return c.json({ error: "turn records are not available" }, 501);

    const json = await jsonBody(c);
    if (!json) return c.json({ error: "body must be a JSON object" }, 400);
    const body = json as SendBody;

    const attachments = parseAttachments(body.attachments);
    if ((typeof body.text !== "string" || !body.text.trim()) && attachments.length === 0) {
      return c.json({ error: "`text` or `attachments` is required" }, 400);
    }

    /**
     * A browser may only attach what it uploaded.
     *
     * `parseAttachments` takes any path, which is correct for the CLI — it runs as the operator, on
     * their own machine. Here it would mean a dashboard account could name `/etc/shadow` as an
     * attachment and have the agent read it out. So the path has to be one this daemon wrote itself,
     * in the uploads directory, and nothing else is accepted.
     */
    const foreign = attachments.find((attachment) => !deps.uploads?.holds(attachment.url ?? ""));
    if (foreign) {
      return c.json(
        {
          error:
            "attachments have to be uploaded through /chat/upload first: a path from anywhere else is not accepted here",
        },
        400,
      );
    }

    /**
     * Which conversation this belongs to, resolved from the id the client already has.
     *
     * The client holds a *session* id — it is in the URL — and not the chat id inside it. Making it
     * parse one out of the other would put the id format in two places, and it is the kind of format
     * that changes. So the session is looked up here and its chat id used — through its running turn
     * while the first one has not ended, which is when the row is written (`conversationNamed`).
     */
    const asked = body.sessionId?.trim();
    const existing = asked ? conversationNamed(deps, asked) : body.chatId?.trim() ? deps.sessions?.find(body.chatId.trim()) : null;
    // Never into a conversation the sender may not open: another person's chat is not there to send into.
    const reader = readerIn(c);
    if (existing && !mayOpen(deps, reader, existing)) return c.json(NOT_THERE, 404);

    /**
     * A room, or a one-to-one chat with one agent — decided by whether the chat has a membership
     * list, not by a flag the client sends.
     *
     * Derived rather than declared because the two must never disagree: the router reads the
     * membership list to decide who may answer here, so a client that said "this is a DM" about a
     * chat with three members would be sending into a conversation the daemon routes as a room.
     *
     * The whole DM path below is untouched. That is deliberate and not laziness — in a one-to-one
     * chat a tag reaches nobody, because each bot has its own private conversation with the person,
     * and the handover goes over `ask_agent` instead so the agent being spoken to stays the only
     * voice. Making a DM "a room of one" would turn that back on, and `voice.ts` records what it
     * cost: a second agent answering under the first one's name, with its progress lines and its
     * approval prompts arriving in a conversation the person opened with somebody else.
     */
    const roomChatId = existing?.chatId ?? body.chatId?.trim() ?? "";
    const room =
      roomChatId && deps.rooms ? deps.rooms.get(deps.local.id, roomChatId) : null;

    if (room && !mayOpen(deps, reader, { gatewayId: deps.local.id, chatId: room.chatId })) return c.json(NOT_THERE, 404);
    if (room) {
      const sent = sendToRoom(deps, {
        room,
        ...(body.text ? { text: body.text } : {}),
        attachments: body.attachments,
        principal: c.get("principal"),
      });
      return c.json(sent.body, sent.status);
    }

    // Named by the client, the conversation's own agent, or the orchestrator — in that order. A
    // client that names a different agent for an existing chat gets that agent's own conversation in
    // it, which is what the session key already means.
    const agentId = (body.agent ?? existing?.agentId ?? deps.ctx.config.daemon.orchestrator ?? "").trim();
    const agent = agentId ? deps.registry.get(agentId) : undefined;
    if (!agent) {
      const known = deps.registry.enabled().map((a) => a.config.id);
      return c.json(
        {
          error: agentId
            ? `there is no agent called "${agentId}". Available: ${known.join(", ") || "none"}`
            : "name an agent: this daemon has no default",
          plain: agentId ? `There is no agent called "${agentId}". Pick another one.` : "Pick an agent to talk to first.",
        },
        404,
      );
    }
    if (!agent.config.enabled) return c.json({ error: `${agent.config.id} is disabled` }, 409);
    // Refused up front, and this is the one refusal worth being synchronous about: a paused agent
    // produces no turn at all, so a client that got a 200 here would wait for a record that is never
    // written and eventually decide the daemon is broken. Except a command it still answers — `/start`
    // above all, which the composer offers like any other: refused here, a person who typed `/stop` in
    // this chat could not type `/start` after it (found on 0.7.15's run). It is answered, and the answer
    // written down as a turn's record, as on any platform.
    if (deps.registry.isPaused(agent.config.id) && !deps.pipeline.answersWhilePaused(typeof body.text === "string" ? body.text : "")) {
      return c.json({ error: `${agent.config.id} is asleep. Wake it from Agents, or send /wake` }, 409);
    }

    const chatId = existing?.chatId ?? body.chatId?.trim() ?? `web-${Date.now()}`;
    const sessionId = sessionIdFor({
      agentId: agent.config.id,
      chatId,
      gatewayId: deps.local.id,
    });

    /**
     * A conversation that happened somewhere else is readable here, not writable.
     *
     * The history list spans every gateway — that is what makes the dashboard a monitor — and typing
     * into a Discord conversation used to silently start a *different*, local one with the same chat
     * id: two transcripts, one name, and the agent answering into the wrong one. This daemon cannot
     * post as the person on Discord, so the honest answer is to say so.
     */
    if (existing && existing.gatewayId !== deps.local.id) {
      return c.json(
        {
          error: `this conversation belongs to ${existing.gatewayId}: you can read it here, but replies have to be sent from there`,
        },
        409,
      );
    }

    /**
     * Who is sending this, taken from the login rather than from the request.
     *
     * The client used to say who it was, which is fine for a name in a corner of the screen and not
     * fine for something the agent is told. An authenticated request already carries the account, so
     * the daemon reads it there: a dashboard user cannot introduce themselves to an agent as somebody
     * else, and the name the agent hears is the same one the audit log records.
     *
     * `displayName` first, then the username — which on most installs is an email. The users table
     * says an empty display name means "nobody has said", and that is right for a *label*; for a
     * conversation the login is still a better answer than none, and the prompt describes it as the
     * account it is rather than as a chosen name.
     *
     * A token-authenticated caller (a script, a test) has no account, so it keeps saying who it is
     * and is *not* marked verified — which is honest: nothing checked a person there.
     */
    const account = c.get("principal").user;
    // The daemon's own sender is its events', which pass a pack's allowlist and every rate limit (0.8.1): a caller with
    // the token does not borrow it.
    if (!account && body.senderId === SYSTEM_SENDER) return c.json({ error: `${SYSTEM_SENDER} is the daemon's own sender. Name another`, plain: "That name is Nouride's own. Pick another one." }, 400);
    const sender = account
      ? {
          senderId: account.id,
          senderName: account.displayName.trim() || account.username.trim(),
          senderVerified: true,
        }
      : {
          ...(body.senderId ? { senderId: body.senderId } : {}),
          ...(body.senderName ? { senderName: body.senderName } : {}),
        };

    // A model and an effort picked on the page before the conversation had a message come with its first one.
    const refused = keepFirstChoice(deps, agent, chatId, body);
    if (refused) return c.json(refused, 400);

    const { messageId } = deps.local.dispatch({
      ...(body.text ? { text: body.text } : {}),
      chatId,
      agent: agent.config.id,
      ...sender,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...pageOf(body.page),
    });

    deps.audit.record({
      action: "chat_sent",
      actor: c.get("principal").actor,
      agentId: agent.config.id,
      chatId,
      details: { session: sessionId, message: messageId },
    });

    return c.json({ sessionId, chatId, messageId, agentId: agent.config.id } satisfies { sessionId: string; chatId: string; messageId: string; agentId: string });
  });

  /**
   * The whole conversation: recorded turns, and whatever came before them.
   *
   * Read on load and after a turn ends — not on a timer. The live endpoint below is what a client
   * polls, and it is small.
   */
  control.get("/sessions/:id/turns", (c) => {
    if (!deps.turns || !deps.sessions) return c.json({ error: "not available" }, 501);
    const id = c.req.param("id");
    const named = conversationNamed(deps, id);
    if (named && !mayOpen(deps, readerIn(c), named)) return c.json(NOTHING satisfies Transcript);
    return c.json(
      transcript(deps, { turns: deps.turns, sessions: deps.sessions }, {
        session: deps.sessions.find(id) ?? null,
        fallbackId: id,
      }) satisfies Transcript,
    );
  });

  /**
   * The same transcript, addressed by the room instead.
   *
   * A room has no session id until somebody has spoken in it — a session is created per agent, on its
   * first turn — so a freshly created room cannot be opened the way a one-to-one chat is. Rather than
   * have the client hunt for a member's session, or invent one, it asks by the chat id it was given
   * when the room was created.
   *
   * One builder behind both, because a second copy of "what a transcript is" is a second answer to
   * the question of whether a room is read across its agents.
   */
  control.get("/rooms/:chatId/turns", (c) => {
    if (!deps.turns || !deps.sessions) return c.json({ error: "not available" }, 501);
    if (!deps.local) return c.json({ error: "the local gateway is not enabled", plain: CHAT_OFF }, 409);
    const chatId = c.req.param("chatId");
    if (!deps.rooms || !roomFor(readerIn(c), chatId)) {
      return c.json({ error: "no such room" }, 404);
    }
    /**
     * Any member's session stands in as the addressable one.
     *
     * The turns come from the room either way — `transcript` reads `forChat` once it sees a
     * membership list — and this only decides which id the client is handed back for the things that
     * are still per-agent: the live feed, and stopping a turn.
     */
    const members = deps.rooms.membersOf(deps.local.id, chatId);
    const session =
      members
        .map((agentId) =>
          deps.sessions!.find(sessionIdFor({ agentId, chatId, gatewayId: deps.local!.id })),
        )
        .find((found) => found) ?? null;
    return c.json(
      transcript(deps, { turns: deps.turns, sessions: deps.sessions }, {
        session,
        fallbackId: chatId,
        room: { chatId },
      }) satisfies Transcript,
    );
  });

  /**
   * What a room is doing right now: every turn still running in it, and the jobs behind them.
   *
   * A list, where the per-session feed is one turn — a message naming two agents runs both, and a
   * feed that could only carry one would draw one worker and imply the other had finished.
   *
   * No cursor, deliberately. The per-session feed sends only the steps since the client's last poll
   * because a single turn can run for minutes and accumulate a long tail; here there may be several
   * turns at once and a cursor per turn is state the client would have to keep in step with a list
   * whose membership changes as agents finish. Running turns are short and their steps are few, so
   * every poll carries all of them — which also makes each step's duration measurable from its own
   * neighbour rather than from whatever the client happened to see last.
   */
  control.get("/rooms/:chatId/live", (c) => {
    if (!deps.turns) return c.json({ error: "turn records are not available" }, 501);
    if (!deps.local) return c.json({ error: "the local gateway is not enabled", plain: CHAT_OFF }, 409);
    const chatId = c.req.param("chatId");
    if (!deps.rooms || !roomFor(readerIn(c), chatId)) {
      return c.json({ error: "no such room" }, 404);
    }

    const running = deps.turns.runningForChat(deps.local.id, chatId);
    return c.json({
      turns: running.map((view) => ({
        ...toTurnPayload(view),
        // Measured from the turn's own start, as the per-session feed does — the client draws a clock
        // that has to agree with the one the daemon will record.
        steps: withDurations(view.steps, view.startedAt),
      })),
      jobs: roomJobs(deps, deps.local.id, chatId, deps.rooms.membersOf(deps.local.id, chatId)),
    } satisfies { turns: ChatTurn[]; jobs: RunningJob[] });
  });

  /**
   * What this conversation is doing right now.
   *
   * The newest turn, whatever its status, plus its steps after `after`. Returning a *finished* turn is
   * deliberate: it is how a client that polled once too slowly still learns the answer, and how a
   * reply produced with nobody watching — a slash command, a background job reporting in — reaches a
   * page that was not open when it happened.
   */
  control.get("/sessions/:id/live", (c) => {
    if (!deps.turns) return c.json({ error: "turn records are not available" }, 501);
    const id = c.req.param("id");
    const named = conversationNamed(deps, id);
    if (named && !mayOpen(deps, readerIn(c), named)) return c.json({ turn: null, jobs: [] } satisfies { turn: LiveTurn | null; jobs?: RunningJob[] });
    const sessionId = deps.sessions?.find(id)?.id ?? id;
    /**
     * The cursor, and the turn it belongs to.
     *
     * A sequence number means nothing without knowing which turn it counted. A client that polled at
     * step 40 of one turn and was then answered about the *next* turn would skip its first forty
     * steps — so the cursor only applies when the turn matches.
     */
    const requested = c.req.query("turn");
    const asked = Number.parseInt(c.req.query("after") ?? "0", 10) || 0;

    const turn = deps.turns.latestForSession(sessionId);
    if (!turn) return c.json({ turn: null, jobs: runningJobs(deps, sessionId) } satisfies { turn: LiveTurn | null; jobs?: RunningJob[] });
    const after = resolveCursor({ requested, latest: turn.id, asked });

    /**
     * One step further back than asked for, so the first delivered step has something to be measured
     * from.
     *
     * Step durations are differences between neighbours. Fetching only what the client has not seen
     * would leave the first one measured from the start of the turn — which reads as a tool that took
     * four minutes when what took four minutes was the tool before it.
     */
    const window = deps.turns.stepsSince(turn.id, Math.max(0, after - 1));
    const anchor = after > 0 && window[0]?.seq === after ? window[0] : undefined;
    const steps = anchor ? window.slice(1) : window;

    return c.json({
      /**
       * Work that outlives the turn that started it.
       *
       * `exec background: true` returns immediately, so the turn ends and the conversation looks idle
       * while a build runs for ten minutes. The job then wakes the agent and a new turn appears out of
       * nowhere. Reporting the jobs here is what makes that legible in between: the chat can say what
       * is still running, in the conversation that started it.
       */
      jobs: runningJobs(deps, sessionId, turn),
      turn: {
        ...toTurnPayload({ ...turn, steps: [] }),
        ...askedBy(deps, turn),
        steps: withDurations(steps, anchor?.at ?? turn.startedAt),
        /** The client's next `after`. Sent rather than inferred, so an empty batch is unambiguous. */
        cursor: window.length > 0 ? window[window.length - 1]!.seq : after,
      },
    } satisfies { turn: LiveTurn | null; jobs?: RunningJob[] });
  });

  /**
   * The bytes of one file on one turn.
   *
   * Addressed by position, never by path. That is the whole security design: the client cannot name a
   * file, so it cannot name a file it was not shown — and the daemon checks that the turn belongs to
   * the conversation asked for before it opens anything.
   *
   * ## Why the disposition matters more than it looks
   *
   * Serving somebody's uploaded file from the dashboard's own origin is how a stored-XSS gets in. An
   * HTML file, or an SVG — which can carry script — rendered inline would run with the dashboard's
   * cookies. So `inline` is an allowlist of types that browsers render without executing anything, and
   * everything else downloads. `nosniff` is already set globally, which stops a browser deciding for
   * itself that a `.txt` is HTML.
   */
  control.get("/sessions/:id/turns/:turnId/files/:index", async (c) => {
    if (!deps.turns) return c.json({ error: "turn records are not available" }, 501);

    const named = conversationNamed(deps, c.req.param("id"));
    if (named && !mayOpen(deps, readerIn(c), named)) return c.json({ error: "no such file" }, 404);
    const sessionId = deps.sessions?.find(c.req.param("id"))?.id ?? c.req.param("id");
    const turn = deps.turns.get(c.req.param("turnId"));
    // Both checks, and the second is the one that matters: without it any session id would serve any
    // turn's files, which makes the session in the URL decoration rather than a permission.
    if (!turn || turn.sessionId !== sessionId) return c.json({ error: "no such file" }, 404);

    const index = Number.parseInt(c.req.param("index") ?? "", 10);
    const file = Number.isInteger(index) ? turn.attachments?.[index] : undefined;
    if (!file?.path) return c.json({ error: "no such file" }, 404);

    const stat = statFile(file.path);
    if (!stat || stat.isDirectory) {
      // Swept, or the disk moved under us. Said plainly, because the alternative is a broken image
      // icon and no way to tell that from a bug.
      return c.json({ error: "that file is no longer on disk: attachments are swept by retention" }, 410);
    }

    const headers: Record<string, string> = {
      "content-type": file.mimeType || "application/octet-stream",
      "content-disposition": `${rendersInline(file.mimeType) ? "inline" : "attachment"}; filename="${asciiName(file.name)}"`,
      // Private, because this is somebody's file, and short because a retention sweep can remove it.
      "cache-control": "private, max-age=300",
      // Advertised whether or not this request asked for a range: a `<video>` element decides how to
      // load — and on Safari, *whether* to play at all — from this header on the first response.
      "accept-ranges": "bytes",
    };

    const range = parseRange(c.req.header("range"), stat.size);

    if (range === "unsatisfiable") {
      // 416 must carry the real size, or the client has no way to correct its own request.
      return new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${stat.size}` },
      });
    }

    if (range) {
      const length = range.end - range.start + 1;
      return new Response(readFileRange(file.path, range.start, range.end + 1), {
        status: 206,
        headers: {
          ...headers,
          "content-length": String(length),
          "content-range": `bytes ${range.start}-${range.end}/${stat.size}`,
        },
      });
    }

    // Streamed rather than buffered even here. The whole point is that nothing on this path has to
    // hold a large file in memory, and a request with no `Range` header is exactly the request that
    // would hold the largest one.
    return new Response(readFileBody(file.path), {
      headers: { ...headers, "content-length": String(stat.size) },
    });
  });

  /**
   * Delete a conversation.
   *
   * Its history, its turn records and their stream, the live progress feed, its spilled output, its `/model` override,
   * the approvals it is still waiting on — and the turn still running in it, if there is one. A delete that left the
   * agent working on a conversation nobody can see would be the worst outcome: money spent on a transcript that no
   * longer exists. What it clears is `ENDS.delete` in `pipeline/conversation-end.ts`.
   */
  control.delete("/sessions/:id", async (c) => {
    if (!deps.sessions) return c.json({ error: "not available" }, 501);
    const id = c.req.param("id");
    const session = deps.sessions.find(id);
    if (!session || !mayOpen(deps, readerIn(c), session)) return c.json({ error: "no such session" }, 404);

    // A mission's own conversation (0.8.0) takes the mission with it: stopped while its conversation is still there to
    // say so, then removed. Left alone, it went on working with its checklist deleted.
    if (session.gatewayId === MISSION_GATEWAY_ID) deps.missions?.forget(session.chatId, c.get("principal").actor);

    const { stopped, turns } = await deps.pipeline.endConversation(
      { agentId: session.agentId, gatewayId: session.gatewayId, chatId: session.chatId, sessionId: session.id },
      "delete",
    );

    deps.audit.record({
      action: "session_deleted",
      actor: c.get("principal").actor,
      agentId: session.agentId,
      chatId: session.chatId,
      details: { session: session.id, turns, stopped },
    });

    return c.json({ ok: true, turns, stopped } satisfies { ok: true; turns: number; stopped: number });
  });
}

/**
 * Send into a room, where nobody is pinned and the tag decides.
 *
 * The DM path resolves exactly one agent and hands `agent:` to the gateway, which becomes a mention
 * the message's own text cannot override — right for a conversation with one agent in it, and wrong
 * here: in a room the person chooses who they are talking to by tagging them, and the router already
 * knows how to read that (`findMentioned` matches an id or a display name, a leading `nero:` or an
 * `@nero` anywhere in the text).
 *
 * So this dispatches the message as written, with `chatType: "group"`, and lets routing do its job.
 * Everything that makes a room a room follows from that flag: the mention gate, the room's shared
 * history, and the handover between agents.
 *
 * ## Several agents in one message
 *
 * Nothing special happens here, and that is the point. The route dispatches one message; the pipeline
 * decides who it addressed and runs each of them — see `InboundRouter.addressees`.
 *
 * It was briefly done in this route, in both available shapes, and both are wrong. Dispatching once
 * per member with fresh message ids makes `GroupContext.record` store the person's message once per
 * member, because its dedupe is by message id, so the room's own history repeats it. Dispatching with
 * one shared id makes the queue drop every copy but the first, because that is precisely its dedupe
 * key. A message has to stay one message through observation and the queue and only then fan out,
 * which puts the fan-out inside the pipeline rather than out here.
 */
function sendToRoom(
  deps: ControlDeps,
  input: {
    room: Room;
    text?: string;
    attachments?: unknown;
    /** Taken from the login by the caller, so a room send cannot introduce itself as somebody else. */
    principal: Principal;
  },
): { status: 200 | 400 | 409; body: Record<string, unknown> } {
  const fail = (status: 400 | 409, error: string) => ({ status, body: { error } }) as const;
  if (!deps.local) return { status: 409, body: { error: "the local gateway is not enabled", plain: CHAT_OFF } };

  const attachments = parseAttachments(input.attachments);
  const text = input.text?.trim() ?? "";
  if (!text && attachments.length === 0) return fail(400, "`text` or `attachments` is required");

  const live = input.room.members.filter((member) => {
    const agent = deps.registry.get(member.agentId);
    return agent?.config.enabled && !deps.registry.isPaused(member.agentId);
  });
  if (live.length === 0) {
    return fail(409, "no agent in this room can answer: every member is disabled or paused");
  }

  const account = input.principal.user;
  const sender = account
    ? {
        senderId: account.id,
        senderName: account.displayName.trim() || account.username.trim(),
        senderVerified: true,
      }
    : {};


  const { messageId } = deps.local.dispatch({
    ...(text ? { text } : {}),
    chatId: input.room.chatId,
    // The flag the whole room behaviour hangs off. Without it this is a DM with several agents in
    // it, which is the arrangement `busConventionLines` exists to describe and refuse.
    chatType: "group",
    ...sender,
    ...(attachments.length > 0 ? { attachments } : {}),
  });

  deps.audit.record({
    action: "chat_sent",
    actor: input.principal.actor,
    chatId: input.room.chatId,
    details: { room: true, members: live.map((member) => member.agentId), message: messageId },
  });

  return { status: 200, body: { chatId: input.room.chatId, messageId, room: true } };
}


/**
 * What a client is handed when it opens a conversation: the recorded turns, whatever came before
 * them, and the room's own events.
 *
 * One function behind two routes — `/sessions/:id/turns` and `/rooms/:chatId/turns` — because "what
 * a transcript is" has exactly one answer, and the interesting part of that answer is whether the
 * turns span the room or one agent's side of it.
 */
function transcript(
  deps: ControlDeps,
  stores: { turns: TurnsPort; sessions: SessionsPort },
  input: {
    /** The addressable session, or null for a room nobody has spoken in yet. */
    session: Session | null;
    /** What to look turns up under when there is no session — the id the client asked with. */
    fallbackId: string;
    /** Set by the room route, so a room with no session yet is still read as a room. */
    room?: { chatId: string };
  },
): Transcript {
  const sessionId = input.session?.id ?? input.fallbackId;
  /**
   * A conversation whose first turn is still running has no row yet (it is written when that turn ends): its session is
   * the one that turn is for. Answered as none, the page fell back to the orchestrator — opened from the Office while Nix
   * worked on a first turn, it showed Nouva, and a message sent there went to her (2026-11-02). Never for a room's chat,
   * which is read as a room.
   */
  const opening = input.session || input.room ? null : stores.turns.latestForSession(sessionId);
  const session: Session | null =
    input.session ??
    (opening?.status === "running" && !deps.rooms?.hasMembers(opening.gatewayId, opening.chatId)
      ? { id: sessionId, agentId: opening.agentId, chatId: opening.chatId, gatewayId: opening.gatewayId, sessionType: "main", status: "active", contextTokenCount: 0, createdAt: opening.startedAt, startedAt: opening.startedAt, updatedAt: opening.startedAt }
      : null);
    /**
     * A room is read across every agent in it; a one-to-one chat is read per session.
     *
     * `forSession` is one agent's side of a conversation. In a room that is a monologue: several
     * agents share the chat and each has its own session, so reading one of them shows a transcript
     * with the other half of the exchange missing. `forChat` is the same rows keyed on the room, which
     * is what the `idx_turn_records_chat` index is for.
     *
     * Decided by whether the chat has a membership list rather than by a parameter, for the same
     * reason the send route decides it that way: the two must not be able to disagree about what kind
     * of conversation this is.
     */
    const isRoom = Boolean(
      input.room ?? (session && deps.rooms?.hasMembers(session.gatewayId, session.chatId)),
    );
    const roomChat = input.room?.chatId ?? (isRoom ? session?.chatId : undefined);
    /**
     * Finished turns only. The running one belongs to `/live`.
     *
     * Both returning it was a bug with a very visible shape: after a reload the running turn arrived
     * here too, got drawn as a *finished* exchange — `… 0 steps` and an empty answer — and the live
     * feed was suppressed because the turn was "already in the transcript". The page then sat there
     * forever while the daemon happily finished the work. One turn has one owner: history, or now.
     */
    const turns = historyOf(
      isRoom && roomChat && deps.local
        ? stores.turns.forChat(deps.local.id, roomChat)
        : stores.turns.forSession(sessionId),
    );
    /**
     * The room's own messages: what people said, whether or not anybody answered.
     *
     * This is what makes a room a conversation rather than a list of answered questions. An untagged
     * message produces no turn, and before this table it produced nothing at all — it went into the
     * in-memory group buffer, reached the next agent tagged as background, and was never anywhere a
     * transcript could read it.
     *
     * It also fixes the mirror-image problem: a message two agents answered produced two turn
     * records, and a client drawing each turn's prompt drew the same message twice. The bubble comes
     * from here now and a turn carries only the reply, joined back by `messageId`. A group on a chat app reads its own
     * log the same way, with each person under the name the dashboard knows them by (`senders.ts`).
     */
    const messages =
      isRoom && roomChat && deps.local && deps.roomMessages
        ? deps.roomMessages.forChat(deps.local.id, roomChat)
        : groupLog(deps, session);

    /**
     * The earlier part, older than the oldest turn the log keeps — and **never for a room**.
     *
     * `earlier` is one agent's `session.context` — its private view of the conversation, with every
     * context block the harness composed into it. In a one-to-one chat that is the same conversation
     * seen from the other side, and worth showing where the turns no longer reach: they are swept after
     * `[retention] session_days`, the context is not. In a room it is one member's copy, so it drew the
     * harness's own scaffolding as something a person had said and repeated the other agents' replies
     * back as the reader's own words.
     */
    const first = turns[0];
    const earlier = isRoom
      ? []
      : messagesToTranscript(
          stores.sessions.messagesById(sessionId) ?? [],
          first ? { before: first.startedAt, prompt: first.prompt } : undefined,
        );

    /**
     * The room's events, beside the turns rather than merged into them.
     *
     * Sent as their own list because they are their own thing: a turn has a question, an answer and
     * steps, and an event has a sentence and a kind. Folding them into the turn array would mean
     * every field on a turn becoming optional so that a pill could travel in the same shape — and
     * every reader of a turn then checking which of the two it got.
     *
     * The client interleaves by timestamp, which it already does for `earlier` and `turns`.
     *
     * Read from the *room*, not the session: an event belongs to the chat, so a conversation with two
     * agents in it shows the same notices under both. That is the point of the table.
     *
     * And keyed on the chat rather than on a session, which is the third time that mistake has been
     * made in this function. A room has no session until an agent has taken a turn in it, so gating a
     * room-scoped read on one means a freshly created room reports nothing at all — no members
     * joining, no notices. A one-to-one chat keeps using its session, which is the only thing that
     * identifies it.
     */
    const eventChat = roomChat ?? session?.chatId;
    const eventGateway = roomChat ? deps.local?.id : session?.gatewayId;
    const events =
      deps.chatEvents && eventChat && eventGateway
        ? deps.chatEvents.forChat(eventGateway, eventChat)
        : [];

    return {
      events,
      /**
       * Read from the chat id, not from a session that may not exist yet.
       *
       * `session!.gatewayId` was a non-null assertion on a value that is null for exactly the case
       * this route exists to serve: a room nobody has spoken in has no session, because sessions are
       * created per agent on their first turn. So opening a freshly created room returned a 500 —
       * and the assertion is the same lie `ids[0]!` already cost this repo once.
       */
      room:
        isRoom && roomChat && deps.local
          ? (deps.rooms?.get(deps.local.id, roomChat) ?? null)
          : null,
      session: session
        ? {
            id: session.id,
            agentId: session.agentId,
            chatId: session.chatId,
            gatewayId: session.gatewayId,
            updatedAt: session.updatedAt,
            /**
             * Whether this client can send into it.
             *
             * Sent rather than inferred, because the inference needs the local gateway's id and a
             * client that hard-coded `web:dashboard` would be wrong the day that changes. A conversation
             * from Telegram or Discord reads here and is answered there.
             */
            writable: !deps.local || session.gatewayId === deps.local.id,
          }
        : null,
      earlier,
      messages,
      turns: turns.map((turn) => ({ ...toTurnPayload(turn), ...askedBy(deps, turn) })),
    };
  }
