/**
 * The rooms the agents talk in (`routes/groups.ts`, `routes/known-chats.ts`): each group, channel or thread, and the
 * chats the daemon has met.
 */

/** One room, as `GET /groups` answers it (`KnownRoom` in the engine's `pipeline/known-rooms.ts`). */
export interface GroupRecord {
  /** The connection it is reached through. */
  gatewayId: string;
  platform: string;
  chatId: string;
  /** Its name: a dashboard room's title, else the rename made here, else what its platform calls it. */
  name?: string;
  /** What its platform calls it, where it said — what clearing a rename goes back to. */
  platformTitle?: string;
  /** A room made in the dashboard's Chat. */
  dashboard: boolean;
  /** The agents with a conversation there. */
  agents: string[];
  /** Who spoke there lately: a People key and name, or the name their platform shows. */
  people: { key?: string; name: string }[];
  lastActive: number;
}

/** A chat a job's results can go to, as `GET /chats` answers it (`reachableChats` in the engine's `pipeline/send-message.ts`). */
export interface KnownChat {
  gatewayId: string;
  chatId: string;
  platform: string;
  kind: "dm" | "group";
  /** A group's name, where it has one. */
  title?: string;
  /** The person on the other end of a one-to-one, or who spoke in a group lately. */
  people: string[];
  lastActive: number;
}
