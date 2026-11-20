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
  /**
   * The room's own answer to that, where it gave one with `/mention` or from its header: a tag is needed, or none is
   * and the agent named answers. Absent while the room follows its members' rule.
   */
  mention?: { requireTag: boolean; answerer?: string };
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
  /**
   * Each of our agents' tag as this platform writes it, the tag to the agent: Discord's `<@1001…>` is markup, and the
   * dashboard reads it as `@Nexa`. Absent where no agent of ours has one there.
   */
  tags?: Record<string, string>;
}

/**
 * An agent that was deleted, and its newest conversation the reader may open. Its chats are kept: read, and not written
 * to while no agent has its id.
 */
export interface ChatListGone {
  agentId: string;
  sessionId: string;
  at: number;
  last?: ChatListLine;
}

export interface ChatListPayload {
  agents: ChatListAgent[];
  /** The deleted agents the reader has a conversation with, newest first. */
  gone: ChatListGone[];
  rooms: ChatListRoom[];
  groups: ChatListGroup[];
}
