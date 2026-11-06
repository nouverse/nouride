/**
 * Which columns hold a key — a gateway, a conversation, a chat, an agent, a person — and in what shape.
 *
 * Data only. Three operations change or remove a key across the whole schema, and each used to keep its own list:
 * `nouride gateway rename` (`modules/gateways/rename.ts`), ending a conversation (`pipeline/conversation-end.ts`)
 * and forgetting a person. A list kept by hand only ever shrinks — a dropped table makes the operation throw, so
 * somebody notices — while a table added later is missed in silence. That is how the rename came to skip the room
 * log, the event stream, the inbox, the turn journal and memory: every one of them was added after its list.
 *
 * So the lists are this one, and `tests/contracts/key-columns.test.ts` walks the migrated schema against it: a
 * column whose name says it holds a key fails the build until it is classified here, an entry whose column is gone
 * fails too, and the rename is run over a row in every table to prove it reaches each column it should.
 *
 * Read by the data layer only — the rename, which builds its SQL from it, and the tests.
 */

/** What a column's value is, which decides what changing that key has to do to it. */
export type KeyKind =
  /** A gateway instance id on its own: `telegram:nouva`. */
  | "gateway"
  /** A conversation's id, `ses_<agent>:<gateway>:<chat>` — the gateway sits inside it (`@nouride/shared` `sessionId`). */
  | "session"
  /**
   * A value that begins with `<gateway>:` — memory's chat key, `<gateway>:<chat>` (`modules/memory/access.ts`), and an
   * inbox id, which is the chat key with the platform's message id after it.
   */
  | "gatewayPrefixed"
  /** JSON, with a key at each of `paths`. */
  | "json"
  /** A platform alone (`telegram`): the half of a gateway id a rename never changes. */
  | "platform"
  /** A platform's chat id, read with the gateway column beside it. */
  | "chatId"
  /** An agent id — its pack's directory name. */
  | "agent"
  /** A person: a `[[people]]` key, or a platform-qualified id (`telegram:814…`) for someone without one. */
  | "person"
  /** A platform's id for whoever sent a message, read with the gateway column beside it. */
  | "sender"
  /** A document that may mention any of them anywhere — a log line's fields. Never searched or rewritten by key. */
  | "text";

export interface KeyColumn {
  readonly table: string;
  readonly column: string;
  readonly kind: KeyKind;
  /** `json` only: where in the document a key sits, and which kind it is there. */
  readonly paths?: Readonly<Record<string, "gateway" | "session">>;
  /** The column holds several, comma-separated. */
  readonly list?: true;
  /**
   * A record of what happened, with the key as it was then — reported, and never rewritten. Rewriting an append-only
   * history to agree with the present is how a history stops being evidence: an audit row says which gateway a thing
   * happened on, and that gateway was called what it was called at the time.
   */
  readonly record?: true;
}

export const KEY_COLUMNS: readonly KeyColumn[] = [
  { table: "approvals", column: "gateway", kind: "gateway" },
  { table: "approvals", column: "agent_id", kind: "agent" },
  { table: "approvals", column: "chat_id", kind: "chatId" },

  { table: "audit_log", column: "gateway", kind: "gateway", record: true },
  { table: "audit_log", column: "agent_id", kind: "agent", record: true },
  { table: "audit_log", column: "chat_id", kind: "chatId", record: true },

  { table: "auto_approve", column: "gateway_id", kind: "gateway" },
  { table: "auto_approve", column: "sender_id", kind: "sender" },

  // `gateway` is the platform: one room's file list is one list however many of this daemon's bots see the room.
  { table: "chat_attachments", column: "gateway", kind: "platform" },
  { table: "chat_attachments", column: "gateway_id", kind: "gateway" },
  { table: "chat_attachments", column: "chat_id", kind: "chatId" },
  { table: "chat_attachments", column: "from_agent", kind: "agent" },

  { table: "chat_events", column: "gateway_id", kind: "gateway" },
  { table: "chat_events", column: "chat_id", kind: "chatId" },
  { table: "chat_events", column: "agent_id", kind: "agent" },

  { table: "chat_members", column: "gateway_id", kind: "gateway" },
  { table: "chat_members", column: "chat_id", kind: "chatId" },
  { table: "chat_members", column: "agent_id", kind: "agent" },

  { table: "chat_messages", column: "gateway_id", kind: "gateway" },
  { table: "chat_messages", column: "chat_id", kind: "chatId" },
  { table: "chat_messages", column: "sender_id", kind: "sender" },

  { table: "chat_rooms", column: "gateway_id", kind: "gateway" },
  { table: "chat_rooms", column: "chat_id", kind: "chatId" },

  { table: "cron_jobs", column: "agent_id", kind: "agent" },
  { table: "cron_jobs", column: "target_gateway_id", kind: "gateway" },
  { table: "cron_jobs", column: "target_chat_id", kind: "chatId" },
  // `{"mode":"announce","gatewayId":"telegram:bot","chatId":"…"}` — where a job reports, when not where it watches.
  { table: "cron_jobs", column: "delivery", kind: "json", paths: { "$.gatewayId": "gateway" } },

  { table: "events", column: "gateway_id", kind: "gateway" },
  { table: "events", column: "chat_id", kind: "chatId" },
  { table: "events", column: "agent_id", kind: "agent" },
  // A turn's start names its conversation (`EVENT_CONTRACT`, `turn.sessionId`).
  { table: "events", column: "data", kind: "json", paths: { "$.sessionId": "session" } },

  { table: "exec_grants", column: "agent_id", kind: "agent" },

  { table: "inbox", column: "id", kind: "gatewayPrefixed" },
  { table: "inbox", column: "gateway_id", kind: "gateway" },
  { table: "inbox", column: "chat_id", kind: "chatId" },
  { table: "inbox", column: "envelope", kind: "json", paths: { "$.gatewayId": "gateway" } },

  // A mission's agent, the agent that started it, and the chat it reports to with the person who started it there (0.8.0).
  { table: "missions", column: "agent_id", kind: "agent" },
  { table: "missions", column: "by_agent", kind: "agent" },
  { table: "missions", column: "gateway_id", kind: "gateway" },
  { table: "missions", column: "chat_id", kind: "chatId" },
  { table: "missions", column: "started_by", kind: "sender" },
  { table: "jobs", column: "agent_id", kind: "agent" },
  { table: "jobs", column: "gateway_id", kind: "gateway" },
  { table: "jobs", column: "chat_id", kind: "chatId" },
  // Whom a helper `delegate` started in the background was working for (`069_baseline.sql`).
  { table: "jobs", column: "sender_id", kind: "sender" },

  { table: "llm_usage", column: "agent_id", kind: "agent" },
  { table: "llm_usage", column: "session_id", kind: "session" },

  { table: "log_entries", column: "agent_id", kind: "agent", record: true },
  { table: "log_entries", column: "chat_id", kind: "chatId", record: true },
  { table: "log_entries", column: "data", kind: "text", record: true },

  // A remote MCP server a person logged an agent's pack in to (`069_baseline.sql`).
  { table: "mcp_oauth", column: "agent_id", kind: "agent" },

  { table: "mcp_tokens", column: "person", kind: "person" },
  { table: "mcp_tokens", column: "agents", kind: "agent", list: true },

  { table: "memory_changes", column: "subject", kind: "person" },

  { table: "memory_episode_agents", column: "agent_id", kind: "agent" },
  { table: "memory_episode_people", column: "person", kind: "person" },

  // The index columns are rebuilt from the vault, which carries the same keys (`modules/memory/rename.ts`).
  { table: "memory_episodes", column: "chat", kind: "gatewayPrefixed" },
  { table: "memory_facts", column: "subject", kind: "person" },
  { table: "memory_facts", column: "readers", kind: "person", list: true },
  { table: "memory_facts", column: "readers_chat", kind: "gatewayPrefixed" },
  { table: "memory_groups", column: "chat", kind: "gatewayPrefixed" },

  // A group's own `groups_require_mention` (`/mention`): the room as the platform sees it, so no gateway to rename.
  { table: "room_mention", column: "platform", kind: "platform" },
  { table: "room_mention", column: "chat_id", kind: "chatId" },

  // A room's name (0.7.24): keyed like `room_mention`, the room as the platform sees it.
  { table: "room_names", column: "platform", kind: "platform" },
  { table: "room_names", column: "chat_id", kind: "chatId" },

  { table: "rsi_tool_seen", column: "agent_id", kind: "agent" },

  { table: "sender_access", column: "gateway_id", kind: "gateway" },
  { table: "sender_access", column: "sender_id", kind: "sender" },
  { table: "sender_access", column: "chat_id", kind: "chatId" },

  { table: "sessions", column: "id", kind: "session" },
  { table: "sessions", column: "agent_id", kind: "agent" },
  { table: "sessions", column: "gateway", kind: "gateway" },
  { table: "sessions", column: "chat_id", kind: "chatId" },

  // A conversation's messages, by its id (`069_baseline.sql`): renamed with it, deleted with it.
  { table: "session_messages", column: "session_id", kind: "session" },

  { table: "skill_candidates", column: "agent_id", kind: "agent" },
  { table: "skill_candidates", column: "session_id", kind: "session" },
  { table: "skill_drafts", column: "agent_id", kind: "agent" },
  { table: "skill_drafts", column: "gateway_id", kind: "gateway" },
  { table: "skill_drafts", column: "chat_id", kind: "chatId" },
  { table: "skill_drafts", column: "session_id", kind: "session" },

  { table: "tool_grants", column: "agent_id", kind: "agent" },

  // Row 0 of each journal is its head: `{"head":{"agentId":…,"gatewayId":…,"chatId":…}}` (`turns/journal.store.ts`).
  { table: "turn_journal", column: "entry", kind: "json", paths: { "$.head.gatewayId": "gateway" } },

  { table: "turn_records", column: "session_id", kind: "session" },
  { table: "turn_records", column: "agent_id", kind: "agent" },
  { table: "turn_records", column: "gateway_id", kind: "gateway" },
  { table: "turn_records", column: "chat_id", kind: "chatId" },
  { table: "turn_records", column: "sender_id", kind: "sender" },
];

/**
 * Tables holding work still in flight, and which of their rows are: a message waiting for its turn, a turn that never
 * ended (`null` — every row of the journal is one). The next boot acts on these, so an operation that changes a key
 * refuses while any of them names it, rather than rewrite a document the boot is about to replay. Starting and
 * stopping the daemon once settles them.
 */
export const IN_FLIGHT: Readonly<Record<string, string | null>> = {
  inbox: "status IN ('queued', 'placed')",
  turn_journal: null,
};

/**
 * What deleting a conversation does to the rows a table keeps for it (`pipeline/conversation-end.ts`).
 *
 * Every table that names a conversation — a session id, or a gateway beside a chat id — is here, so a new one is a
 * decision made before it ships rather than rows left behind after a delete:
 *
 * - `deleted`: the conversation's own record goes with it.
 * - `expired`: what is still waiting on it is closed — a pending approval answered after the delete would wake the
 *   agent in a new conversation about a command it has no context for. What was settled stays, as the record.
 * - `kept`: it outlives the conversation — on purpose, and the reason is beside it.
 */
export const ON_CONVERSATION_DELETE: Readonly<Record<string, "deleted" | "expired" | "kept">> = {
  sessions: "deleted",
  // Its messages: `SessionStore.delete` takes them in the same transaction.
  session_messages: "deleted",
  turn_records: "deleted",
  // A turn's rows go with the turn (`EventedTurnStore.deleteForSession`).
  events: "deleted",
  // The room's notices go with the conversation they annotate, as on `/new`.
  chat_events: "deleted",
  approvals: "expired",
  // What the conversation cost stays spent: the daily caps and the usage pages count it.
  llm_usage: "kept",
  // A proposal waits for its own decision, and carries its own excerpt of the conversation.
  skill_drafts: "kept",
  // A class of work named in a line, not what was said; it lapses by itself when the work does not come back.
  skill_candidates: "kept",
  // A process on the host, stopped from its own page; a wake-up after the delete starts the next conversation.
  jobs: "kept",
  // A schedule aimed at the chat outlives any one conversation in it.
  cron_jobs: "kept",
  // A mission reports to the chat, and outlives any one conversation in it: its notices start the next one (0.8.0).
  missions: "kept",
  // A room's transcript, files and members belong to the room, which is deleted as a whole (`DELETE /rooms/:chatId`).
  chat_messages: "kept",
  chat_attachments: "kept",
  chat_members: "kept",
  chat_rooms: "kept",
  // A message waiting is still answered; a settled row only recognises a redelivery, for two days.
  inbox: "kept",
  // Who may talk to the daemon, not what they said.
  sender_access: "kept",
  // Records.
  audit_log: "kept",
};
