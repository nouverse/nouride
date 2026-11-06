/**
 * A conversation's event rows as an editor's ACP `session/update`s (ACP_PROTOCOL §4), for `nouride acp`. Pure: a row in,
 * what to send out — so the table is tested as a table, apart from any stream or editor.
 *
 * Paired by `callId`, never by order or name. The answer arrives as `reply` rows, each an offset and the text from there
 * (`reply.from`); an editor takes chunks it appends, so what extends what was sent is sent, and an answer the daemon
 * rewrote under a part already sent is put right once, at the end, from the turn's own reply. A delegate's own turn —
 * a helper in the background, an `ask_agent` moved there — is no turn of this conversation, and is left out, as
 * `nouride chat` leaves it out.
 */

import type { SessionUpdate, ToolKind } from "@nouride/acp";

/** A row of the stream as read off it — any kind, a newer one included, whose `data` is read field by field. */
export interface EventRow {
  turnId: string | null;
  kind: string;
  data: Record<string, unknown>;
}

/** A tool's name as the protocol's coarser word, which an editor draws an icon by. */
const KINDS: Readonly<Record<string, ToolKind>> = {
  read: "read",
  read_image: "read",
  attachment_read: "read",
  glob: "search",
  grep: "search",
  web_search: "search",
  memory_search: "search",
  write: "edit",
  edit: "edit",
  multi_edit: "edit",
  exec: "execute",
  session: "execute",
  web_fetch: "fetch",
};

/** A parked call the editor is asked about: the request it answers at `/approvals/:id/:decision`. */
export interface WaitingCall {
  approvalId: string;
  callId?: string;
  name?: string;
  text: string;
}

export interface TurnEnd {
  status: string;
  reply?: string;
  error?: string;
}

export interface RowResult {
  updates: SessionUpdate[];
  waiting?: WaitingCall;
  ended?: TurnEnd;
}

const text = (value: string) => ({ type: "text" as const, text: value });

export class TurnUpdates {
  /** The answer as the editor has it, and as the daemon now has it. */
  private sent = "";
  private answer = "";
  private readonly delegated = new Set<string>();

  read(row: EventRow): RowResult {
    const { data } = row;
    if (row.turnId && this.delegated.has(row.turnId)) return { updates: [] };
    const said = typeof data.text === "string" ? data.text : "";
    switch (row.kind) {
      case "turn":
        if (data.phase === "start" && row.turnId && typeof data.via === "string") this.delegated.add(row.turnId);
        if (data.phase !== "end") return { updates: [] };
        return {
          updates: [],
          ended: {
            status: typeof data.status === "string" ? data.status : "done",
            ...(typeof data.reply === "string" ? { reply: data.reply } : {}),
            ...(typeof data.error === "string" ? { error: data.error } : {}),
          },
        };
      case "reply": {
        const from = typeof data.from === "number" ? data.from : this.answer.length;
        this.answer = `${this.answer.slice(0, from)}${said}`;
        return { updates: this.extend() };
      }
      case "reasoning":
      case "note":
      case "retry":
      case "compact":
      case "steer_reply":
        // The daemon talking about the turn, not the agent acting.
        return { updates: said ? [{ sessionUpdate: "agent_thought_chunk", content: text(said) }] : [] };
      case "tool": {
        const callId = typeof data.callId === "string" ? data.callId : "";
        if (!callId) return { updates: [] };
        const name = typeof data.name === "string" ? data.name : "";
        return { updates: [{ sessionUpdate: "tool_call", toolCallId: callId, title: said || name, kind: KINDS[name] ?? (name.startsWith("web_") ? "fetch" : "other"), status: "in_progress" }] };
      }
      case "audit": {
        const callId = typeof data.callId === "string" ? data.callId : "";
        return { updates: callId ? [{ sessionUpdate: "tool_call_update", toolCallId: callId, rawInput: data.args }] : [] };
      }
      case "tool_done": {
        const callId = typeof data.callId === "string" ? data.callId : "";
        if (!callId) return { updates: [] };
        return { updates: [{ sessionUpdate: "tool_call_update", toolCallId: callId, status: data.error === true ? "failed" : "completed", content: [{ type: "content", content: text(said) }] }] };
      }
      case "waiting":
        if (typeof data.approvalId !== "string") return { updates: [] };
        return {
          updates: [],
          waiting: {
            approvalId: data.approvalId,
            text: said,
            ...(typeof data.callId === "string" ? { callId: data.callId } : {}),
            ...(typeof data.name === "string" ? { name: data.name } : {}),
          },
        };
      default:
        return { updates: [] };
    }
  }

  /**
   * The answer as the turn ended with it — the end's `reply`, or what `/message` returned where no stream came. What
   * extends what was sent is sent; an answer that no longer starts with it is sent whole after it, marked, since an
   * editor cannot take back a chunk.
   */
  finish(reply: string): SessionUpdate[] {
    if (!reply || reply === this.sent) return [];
    if (reply.startsWith(this.sent)) {
      this.answer = reply;
      return this.extend();
    }
    this.sent = reply;
    this.answer = reply;
    return [{ sessionUpdate: "agent_message_chunk", content: text(`\n\n(corrected)\n${reply}`) }];
  }

  private extend(): SessionUpdate[] {
    if (!this.answer.startsWith(this.sent) || this.answer.length === this.sent.length) return [];
    const chunk = this.answer.slice(this.sent.length);
    this.sent = this.answer;
    return [{ sessionUpdate: "agent_message_chunk", content: text(chunk) }];
  }
}
