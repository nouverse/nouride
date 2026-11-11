/**
 * Conversations: sending, the live turn, transcripts, rooms, sessions, and the approvals a turn waits on.
 *
 * Split out of `api.ts`, which had grown past the size cap with every endpoint group inline, and spread
 * into `api` like the others: `api.x()` reads the same at every call site. The payload types are `@nouride/wire`'s.
 */

import { control, post, request } from "./api.client";
import type { ApprovalDecision, ApprovalRequest, ChatListPayload, ChatTurn, LiveTurn, Room, RunningJob, SessionSummary, SlashCommand, Transcript, TurnAttachment, UploadedFile } from "@nouride/wire";

export const chatApi = {
  /**
   * Stop one agent's turn, or everything running in the chat.
   *
   * A room can have several at once, and the button on a progress card means the narrow one — that
   * agent, the card in front of you. The composer's button has nothing more specific to name, so it
   * sends the wide form.
   */
  stop: (chatId: string, agent?: string) =>
    post<{ stopped: number }>(`${control}/stop`, { chatId, ...(agent ? { agent } : {}) }),

  approvals: () => request<{ pending: ApprovalRequest[]; settled?: ApprovalRequest[] }>(`${control}/approvals`),

  answerApproval: (id: string, decision: ApprovalDecision) =>
    // What the route answers. A 409 means it was answered elsewhere or expired, and changed nothing.
    post<{ ok: true; id: string; decision: ApprovalDecision }>(`${control}/approvals/${id}/${decision}`),

  /**
   * The chat page's list in one read: each agent's newest conversation here, each room, each group on a chat app — the
   * reader's own; `everyone`, an admin's alone, every room and group too.
   */
  chatList: (whose: "mine" | "everyone" = "mine") => request<ChatListPayload>(`${control}/chat-list${whose === "everyone" ? "?whose=everyone" : ""}`),

  room: (chatId: string) => request<{ room: Room }>(`${control}/rooms/${encodeURIComponent(chatId)}`),

  createRoom: (input: { agentIds: string[]; title?: string }) =>
    post<{ room: Room }>(`${control}/rooms`, input),

  addRoomMember: (chatId: string, agentId: string) =>
    post<{ room: Room; added: boolean }>(
      `${control}/rooms/${encodeURIComponent(chatId)}/members`,
      { agentId },
    ),

  removeRoomMember: (chatId: string, agentId: string) =>
    request<{ room: Room; removed: boolean }>(
      `${control}/rooms/${encodeURIComponent(chatId)}/members/${encodeURIComponent(agentId)}`,
      { method: "DELETE" },
    ),

  deleteRoom: (chatId: string) =>
    request<{ ok: true; turns: number; events: number; messages: number; files: number; stopped: number }>(
      `${control}/rooms/${encodeURIComponent(chatId)}`,
      { method: "DELETE" },
    ),

  renameRoom: (chatId: string, title: string | null) =>
    request<{ room: Room }>(`${control}/rooms/${encodeURIComponent(chatId)}/title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),

  /**
   * What a room is doing right now — a list, because a message naming two agents runs both.
   *
   * No cursor, unlike the per-session feed: every poll carries each running turn's steps in full.
   * Running turns are short, and a cursor per turn is state a client would have to keep in step with
   * a list whose membership changes as agents finish.
   */
  roomLive: (chatId: string) =>
    request<{ turns: ChatTurn[]; jobs: RunningJob[] }>(
      `${control}/rooms/${encodeURIComponent(chatId)}/live`,
    ),

  /**
   * Where a conversation's events arrive as the daemon writes them — a turn starting, a step, the answer growing.
   * For an `EventSource`, which sends the session cookie and resumes from the last event after a drop. `tail`:
   * only what comes next, since the page has read the history already.
   */
  eventStreamUrl: (conversation: { chatId: string; gatewayId?: string }): string => {
    const params = new URLSearchParams({ tail: "1", chat: conversation.chatId });
    if (conversation.gatewayId) params.set("gateway", conversation.gatewayId);
    return `${control}/events/stream?${params.toString()}`;
  },

  /**
   * A room's transcript, addressed by the chat rather than a session.
   *
   * A room has no session id until somebody has spoken in it — sessions are created per agent, on
   * the first turn — so a freshly created room cannot be opened the way a one-to-one chat is.
   */
  roomTurns: (chatId: string) =>
    request<Transcript>(`${control}/rooms/${encodeURIComponent(chatId)}/turns`),

  /**
   * One page of the history.
   *
   * `total` is the real count, not the page size — the badge used to read `100` for a daemon holding
   * nine hundred conversations. `nextBefore` is the daemon's own cursor; absent means this was the
   * last page.
   */
  sessions: (options: { q?: string; limit?: number; before?: number; agent?: string; whose?: "mine" | "everyone" } = {}) => {
    const params = new URLSearchParams();
    if (options.whose === "everyone") params.set("whose", "everyone");
    if (options.q?.trim()) params.set("q", options.q.trim());
    if (options.limit) params.set("limit", String(options.limit));
    if (options.before) params.set("before", String(options.before));
    if (options.agent) params.set("agent", options.agent);
    const query = params.toString();
    return request<{ sessions: SessionSummary[]; total: number; nextBefore?: number }>(
      `${control}/sessions${query ? `?${query}` : ""}`,
    );
  },

  /**
   * Where to fetch one of a turn's files.
   *
   * Joined here rather than sent whole by the daemon: the relative half comes from the record, the
   * conversation is what the page is already looking at, and the API's mount path is this file's
   * business. The daemon has no reason to know it is served under `/api/control`.
   */
  attachmentUrl: (sessionId: string, file: TurnAttachment): string | null =>
    file.url ? `${control}/sessions/${encodeURIComponent(sessionId)}/${file.url}` : null,

  deleteSession: (id: string) =>
    request<{ ok: true; turns: number; stopped: number }>(
      `${control}/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  /**
   * Hand files to the daemon.
   *
   * Multipart, and separate from the send: a person picks three screenshots and then types for a
   * minute, so the upload happens while they type and a file that is too large is refused before they
   * have written anything. `request` is bypassed for the headers only — a body of `FormData` must not
   * carry a `content-type`, or the boundary the browser generated is lost.
   */
  chatUpload: (files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return request<{ files: UploadedFile[] }>(`${control}/chat/upload`, {
      method: "POST",
      body: form,
      // Generous: this is bytes over somebody's home connection, not a query.
      timeoutMs: 120_000,
    });
  },

  /**
   * Start a turn, and do not wait for it.
   *
   * The reply is not in the response — it is in the record, read back by `live` below. That is the
   * whole difference between this and the old blocking send: a turn belongs to the daemon, so closing
   * the tab does not cancel it and reopening it does not re-send the message.
   */
  chatSend: (input: {
    text: string;
    sessionId?: string;
    chatId?: string;
    agent?: string;
    senderName?: string;
    senderId?: string;
    attachments?: { path: string; mimeType: string; filename: string }[];
  }) =>
    post<{ sessionId: string; chatId: string; messageId: string; agentId: string }>(
      `${control}/chat/send`,
      input,
    ),

  /**
   * The slash commands the daemon answers, for the composer's `/` menu.
   *
   * Read from the daemon rather than listed in the browser: these are hooks, they change with the
   * build, and a hardcoded copy would advertise commands this daemon does not have.
   */
  commands: () => request<{ commands: SlashCommand[] }>(`${control}/commands`),

  transcript: (sessionId: string) =>
    request<Transcript>(`${control}/sessions/${encodeURIComponent(sessionId)}/turns`),

  /**
   * What this conversation is doing now.
   *
   * `after` and `turn` travel together: the cursor counts steps *within* a turn, so the daemon
   * discards it when it is answering about a different one.
   */
  live: (sessionId: string, after: number, turn?: string) =>
    request<{ turn: LiveTurn | null; jobs?: RunningJob[] }>(
      `${control}/sessions/${encodeURIComponent(sessionId)}/live?after=${after}` +
        (turn ? `&turn=${encodeURIComponent(turn)}` : ""),
    ),
  /**
   * There is deliberately no blocking `send` here any more.
   *
   * `POST /message` still exists for the CLI, which genuinely is one command and one answer. A browser
   * is not: a reply that arrives only as an HTTP body is a reply a refresh throws away, and that is
   * what made the chat re-send messages from the URL. `chatSend` + `live` replaced it, and leaving the
   * old wrapper here would leave a second way to do it wrongly.
   */
};
