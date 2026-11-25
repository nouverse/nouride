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
  person: string | null;
}

export class OpenDoorStore {
  constructor(private readonly db: SqliteDb) {}

  private row(agentId: string, day: number, gatewayId: string, senderId: string): Row {
    const found = this.db
      .prepare<Row>("SELECT messages, told_closed, told_enough, person FROM open_door WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?")
      .get(agentId, day, gatewayId, senderId);
    if (found) return found;
    // A new day's first row for somebody: the days past keeping go with it.
    this.db.prepare("DELETE FROM open_door WHERE day < ?").run(day - KEPT_DAYS * DAY_MS);
    this.db.prepare("INSERT INTO open_door (agent_id, day, gateway_id, sender_id) VALUES (?, ?, ?, ?)").run(agentId, day, gatewayId, senderId);
    return { messages: 0, told_closed: 0, told_enough: 0, person: null };
  }

  private toldClosed(agentId: string, day: number, gatewayId: string, senderId: string): void {
    this.db.prepare("UPDATE open_door SET told_closed = 1 WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(agentId, day, gatewayId, senderId);
  }

  /** A row as it is, made by nobody: another address of the same person, read beside the one written to. */
  private peek(agentId: string, day: number, gatewayId: string, senderId: string): Row | undefined {
    return this.db.prepare<Row>("SELECT messages, told_closed, told_enough, person FROM open_door WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").get(agentId, day, gatewayId, senderId) ?? undefined;
  }

  /**
   * A message the door let in that the install's own cap then refused, and whether this person is still to be told today
   * that there is nothing left to answer them with, marked as told: once a day, as the agent's own day is said. Only a
   * sender the door has counted (a stranger) is marked; anyone else (a person of the household) is told each time, and
   * is not made one of the people the agent's page counts. The refused `messages` are taken off what the page says was
   * answered: counted as the door let them in, they were said answered though nothing was.
   */
  tellClosed(input: { agentId: string; gatewayId: string; senderId: string; also?: readonly string[]; day: number; messages?: number }): boolean {
    const { agentId, gatewayId, senderId, day } = input;
    return this.db.transaction((): boolean => {
      const theirs = this.peek(agentId, day, gatewayId, senderId);
      if (!theirs) return true;
      this.db.prepare("UPDATE open_door SET answered = MAX(answered - ?, 0) WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(Math.max(1, input.messages ?? 1), agentId, day, gatewayId, senderId);
      const told = theirs.told_closed || (input.also ?? []).some((other) => other !== senderId && this.peek(agentId, day, gatewayId, other)?.told_closed);
      if (!told) this.toldClosed(agentId, day, gatewayId, senderId);
      return !told;
    });
  }

  /**
   * One stranger's message for an open agent, on the day that began at `day`: counted here when it may be answered.
   * `tokensToday` is what the agent has used since then, whoever it answered.
   */
  take(input: { agentId: string; gatewayId: string; senderId: string; also?: readonly string[]; name?: string; day: number; tokensToday: number; limits: Pick<OpenLimits, "maxDailyTokens" | "maxDailyMessagesPerPerson">; messages?: number }): DoorVerdict {
    const { agentId, gatewayId, senderId, day } = input;
    return this.db.transaction((): DoorVerdict => {
      const theirs = this.row(agentId, day, gatewayId, senderId);
      /**
       * The same person by their other addresses (`senderAlso`): a WhatsApp sender is a phone address in one chat and a
       * hidden one in another. Each address they wrote from holds their whole count, written to all of them as it moves,
       * so one that comes alone, with no other beside it, still reads what they used; and each keeps the name it wrote
       * under, the one its conversation knows them by, so the agent's page finds it.
       */
      const alsoIds = (input.also ?? []).filter((other) => other !== senderId);
      const others = alsoIds.flatMap((other) => this.peek(agentId, day, gatewayId, other) ?? []);
      // Who they are for the page's count of people: the address they were first counted by, which the others take.
      const person = [theirs, ...others].find((row) => row.person)?.person ?? senderId;
      for (const id of [senderId, ...alsoIds]) this.db.prepare("UPDATE open_door SET person = COALESCE(person, ?) WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(person, agentId, day, gatewayId, id);
      const before = Math.max(theirs.messages, ...others.map((other) => other.messages));
      const setCount = (count: number) => {
        for (const id of [senderId, ...alsoIds]) this.db.prepare("UPDATE open_door SET messages = ? WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(count, agentId, day, gatewayId, id);
      };
      const toldClosed = theirs.told_closed || others.some((other) => other.told_closed);
      const toldEnough = theirs.told_enough || others.some((other) => other.told_enough);
      if (input.name?.trim()) this.db.prepare("UPDATE open_door SET name = ? WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(input.name.trim().slice(0, 120), agentId, day, gatewayId, senderId);
      if (input.tokensToday >= input.limits.maxDailyTokens) {
        const agents = this.row(agentId, day, "", "");
        if (!agents.told_closed) this.toldClosed(agentId, day, "", "");
        if (!toldClosed) this.toldClosed(agentId, day, gatewayId, senderId);
        return { action: "closed", say: !toldClosed, first: !agents.told_closed };
      }
      // A burst of files sent together is one turn and as many messages as were sent: counted as one, a stranger could
      // send a day's worth of files, each fetched and each looked at, as a single message.
      const count = Math.max(1, input.messages ?? 1);
      const most = input.limits.maxDailyMessagesPerPerson;
      if (before + count > most) {
        // Their day is over, as they are told: a burst past what was left closes it, rather than a single message after
        // it being answered the same day.
        for (const id of [senderId, ...alsoIds]) this.db.prepare("UPDATE open_door SET told_enough = 1 WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(agentId, day, gatewayId, id);
        setCount(Math.max(before, most));
        return { action: "enough", say: !toldEnough };
      }
      setCount(before + count);
      this.db.prepare("UPDATE open_door SET answered = answered + ? WHERE agent_id = ? AND day = ? AND gateway_id = ? AND sender_id = ?").run(count, agentId, day, gatewayId, senderId);
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

  /**
   * How many people wrote to an agent on the day that began at `day`, and how many of their messages it answered: a
   * person by all their addresses once (where the platform gave them together), and the messages answered, not the
   * count their limit is held to.
   */
  today(agentId: string, day: number): { people: number; messages: number } {
    const row = this.db
      .prepare<{ people: number; messages: number | null }>(
        "SELECT COUNT(DISTINCT COALESCE(person, sender_id)) AS people, SUM(answered) AS messages FROM open_door WHERE agent_id = ? AND day = ? AND sender_id != ''",
      )
      .get(agentId, day);
    return { people: row?.people ?? 0, messages: row?.messages ?? 0 };
  }
}
