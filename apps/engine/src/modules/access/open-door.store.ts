/**
 * What strangers have used of an agent open to everyone, counted by the operator's own day.
 *
 * An open agent answers anyone on its owner's tokens, so what that may cost is bounded by two numbers its admin gave
 * (`OpenLimits`): the agent's tokens in a day, and one person's messages to it in a day. This store keeps the second
 * count and what was already said, in the database, so a restart resets neither. The first is read from what the
 * daemon meters of every model call (`llm_usage`), and handed in.
 *
 * It must not fail open: a message is counted before it is answered, and one past either number begins nothing.
 */

import type { SqliteDb } from "@nouride/runtime";
import type { OpenLimits } from "@nouride/shared";

/** How long a day's rows are kept: long enough for the agent's page to say the week, and a ceiling on the table. */
const KEPT_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

export type DoorVerdict =
  | { action: "answer" }
  /**
   * The agent's tokens for the day are used: closed to strangers until the next day. `say` the first time this sender
   * hears it today, and `first` the first time anyone does: when its admin is told.
   */
  | { action: "closed"; say: boolean; first: boolean }
  /** This person has sent all they may today. `say` the first time. */
  | { action: "enough"; say: boolean };

interface Row {
  messages: number;
  told_closed: number;
  told_enough: number;
}

export class OpenDoorStore {
  constructor(private readonly db: SqliteDb) {}

  private row(agentId: string, day: number, gatewayId: string, senderId: string): Row {
    const found = this.db
      .prepare<Row>("SELECT messages, told_closed, told_enough FROM open_door WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?")
      .get(agentId, day, gatewayId, senderId);
    if (found) return found;
    // A new day's first row for somebody: the days past keeping go with it.
    this.db.prepare("DELETE FROM open_door WHERE day < ?").run(day - KEPT_DAYS * DAY_MS);
    this.db.prepare("INSERT INTO open_door (agent_id, day, gateway_id, sender_id) VALUES (?, ?, ?, ?)").run(agentId, day, gatewayId, senderId);
    return { messages: 0, told_closed: 0, told_enough: 0 };
  }

  private toldClosed(agentId: string, day: number, gatewayId: string, senderId: string): void {
    this.db.prepare("UPDATE open_door SET told_closed = 1 WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(agentId, day, gatewayId, senderId);
  }

  /**
   * One stranger's message for an open agent, on the day that began at `day`: counted here when it may be answered.
   * `tokensToday` is what the agent has used since then, whoever it answered.
   */
  take(input: { agentId: string; gatewayId: string; senderId: string; name?: string; day: number; tokensToday: number; limits: Pick<OpenLimits, "maxDailyTokens" | "maxDailyMessagesPerPerson">; messages?: number }): DoorVerdict {
    const { agentId, gatewayId, senderId, day } = input;
    return this.db.transaction((): DoorVerdict => {
      const theirs = this.row(agentId, day, gatewayId, senderId);
      if (input.name?.trim()) this.db.prepare("UPDATE open_door SET name = ? WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(input.name.trim().slice(0, 120), agentId, day, gatewayId, senderId);
      if (input.tokensToday >= input.limits.maxDailyTokens) {
        const agents = this.row(agentId, day, "", "");
        if (!agents.told_closed) this.toldClosed(agentId, day, "", "");
        if (!theirs.told_closed) this.toldClosed(agentId, day, gatewayId, senderId);
        return { action: "closed", say: !theirs.told_closed, first: !agents.told_closed };
      }
      // A burst of files sent together is one turn and as many messages as were sent: counted as one, a stranger could
      // send a day's worth of files, each fetched and each looked at, as a single message.
      const count = Math.max(1, input.messages ?? 1);
      if (theirs.messages + count > input.limits.maxDailyMessagesPerPerson) {
        if (!theirs.told_enough) this.db.prepare("UPDATE open_door SET told_enough = 1 WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(agentId, day, gatewayId, senderId);
        return { action: "enough", say: !theirs.told_enough };
      }
      this.db.prepare("UPDATE open_door SET messages = messages + ? WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(count, agentId, day, gatewayId, senderId);
      return { action: "answer" };
    });
  }

  /**
   * What the chat app last called each sender on one of an agent's connections, among the days kept: the newest name
   * wins. A week's rows at most, read whole for the connection: the page that asks lists a few dozen of them.
   */
  names(agentId: string, gatewayId: string): Map<string, string> {
    const rows = this.db
      .prepare<{ sender_id: string; name: string }>("SELECT sender_id, name FROM open_door WHERE agent_id = ? AND gateway_id = ? AND name IS NOT NULL ORDER BY day")
      .all(agentId, gatewayId);
    return new Map(rows.map((row) => [row.sender_id, row.name]));
  }

  /** How many people wrote to an agent on the day that began at `day`, and how many of their messages it answered. */
  today(agentId: string, day: number): { people: number; messages: number } {
    const row = this.db
      .prepare<{ people: number; messages: number | null }>("SELECT COUNT(*) AS people, SUM(messages) AS messages FROM open_door WHERE agent_id = ? AND day = ? AND sender_id != ''")
      .get(agentId, day);
    return { people: row?.people ?? 0, messages: row?.messages ?? 0 };
  }
}
