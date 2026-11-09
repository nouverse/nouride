/**
 * The chat page's list (`routes/chat-list.ts`): each agent's newest conversation in the dashboard, each dashboard room
 * and each group the agents are in on a chat app, with what was said last and whether anyone is at work there. One
 * read for the whole list, so the page does not ask once per row.
 */

/** The last thing said somewhere, cut to a line: by an agent (its id) or by a person (the name their app shows). */
export interface ChatListLine {
  from: "agent" | "person";
  /** The agent's id, or the person's name; absent where nothing says who wrote it. */
  name?: string;
  text: string;
}

/** One agent, and its newest conversation in the dashboard — the one its row opens to carry on. */
export interface ChatListAgent {
  agentId: string;
  /** That conversation. Absent for an agent nobody has talked to in the dashboard. */
  sessionId?: string;
  /** When it last moved. */
  at?: number;
  last?: ChatListLine;
  /** A turn of it is running now. */
  working: boolean;
  /** Helpers it started there that are still at work. */
  helpers: number;
}

/** A room made in the dashboard: one conversation with several agents. */
export interface ChatListRoom {
  chatId: string;
  title?: string;
  members: string[];
  at: number;
  last?: ChatListLine;
  working: boolean;
  /**
   * Who answers a message that tags nobody, as the router decides it (`InboundRouter.untaggedAnswerer`): absent when
   * nobody does, and such a message is only kept in the room.
   */
  untagged?: string;
}

/**
 * A group on a chat app — a Telegram or WhatsApp group, a Discord channel or thread — one row however many of our bots
 * sit in it: the same chat on the same platform. Read here, answered on its app.
 */
export interface ChatListGroup {
  platform: string;
  chatId: string;
  /** A rename made on Groups, else what its platform calls it. */
  name?: string;
  /** The agents with a conversation there. */
  agents: string[];
  /** Each agent's conversation there, newest first: what the dashboard reads the group from. */
  sessions: { agentId: string; sessionId: string; gatewayId: string }[];
  at: number;
  last?: ChatListLine;
  working: boolean;
  /** How many people spoke there lately, as far as the daemon heard. */
  people: number;
}

export interface ChatListPayload {
  agents: ChatListAgent[];
  rooms: ChatListRoom[];
  groups: ChatListGroup[];
}
