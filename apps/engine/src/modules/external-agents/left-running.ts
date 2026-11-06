/**
 * What the external agents' CLIs leave running in the background (0.8.6): a command a CLI started that goes on after
 * its prompt has ended (`commandsRunningUnder`), and the chat that is owed what came of it.
 *
 * A restart that is asked for waits for those commands as for a background job, and for half a minute past the last,
 * while the CLI says what came of it (`working`). A stop that does not wait — `now`, a crash — takes them with it: the
 * chat a prompt left one running in is written down as it happens, let go once the command ends or the CLI reports,
 * and what is still written at the next start wakes that chat (`interrupted`), as a job a restart killed wakes its
 * agent.
 */

import type { CliConnection } from "./connection.ts";
import type { OwnChat } from "./own-words.ts";

/**
 * How long after its last command ended a CLI still counts as at work for a restart: what it says of the result comes
 * seconds later — Claude Code reads the output, then answers — and wakes the chat, which the restart then waits for. A
 * restart that looked in between cut the answer off (the live box, 0.8.6).
 */
const REPORT_GRACE_MS = 30_000;

/** Where the chats are written: in the database, so a crash leaves them for the next start (`cliLeftRunningState`). */
export interface LeftRunningFile {
  load(): Record<string, OwnChat>;
  save(left: Record<string, OwnChat>): void;
}

export class LeftRunning {
  /** When each agent's CLI was last seen running a command of its own, by agent id. */
  private readonly seen = new Map<string, number>();
  /** The chats this process's CLIs left a command running in, by session (`ownKey`). */
  private left: Record<string, OwnChat> = {};
  /** What the last process left, and was stopped with: taken once, at the start. */
  private before: OwnChat[];

  constructor(
    private readonly file: LeftRunningFile | undefined,
    private readonly commandsUnder: (pid: number) => number,
  ) {
    this.before = Object.values(file?.load() ?? {});
  }

  /** How many commands a CLI's process runs now. */
  commandsOf(connection: Pick<CliConnection, "pid">): number {
    const pid = connection.pid;
    return pid === undefined ? 0 : this.commandsUnder(pid);
  }

  /**
   * The CLIs a restart waits for, each as a job: one still running a command, or one whose last ended less than
   * `REPORT_GRACE_MS` ago. One with neither has nothing left running: what it was written down for is let go.
   */
  working(running: Iterable<[string, CliConnection]>, now: number): { id: string; command: string; startedAt: number }[] {
    return [...running].flatMap(([agentId, connection]) => {
      if (connection.pid === undefined) return [];
      if (this.commandsOf(connection) > 0) this.seen.set(agentId, now);
      else if (now - (this.seen.get(agentId) ?? -Infinity) > REPORT_GRACE_MS) {
        this.ended(agentId);
        return [];
      }
      // Since its last word, the nearest the daemon knows to when it was left running.
      return [{ id: `cli:${agentId}`, command: `${agentId}'s ${connection.row.name}`, startedAt: connection.lastUsed }];
    });
  }

  /** A session's prompt left a command running in its chat. */
  note(key: string, chat: OwnChat): void {
    this.left = { ...this.left, [key]: chat };
    this.file?.save(this.left);
  }

  /** Whether a session's prompt left a command running that its CLI has not reported on. */
  has(key: string): boolean {
    return key in this.left;
  }

  /** The CLI said what came of what a session left running: a stop from here cuts nothing of it off. */
  reported(key: string): void {
    this.drop((written) => written === key);
  }

  /** An agent's CLI runs no command now: nothing its sessions left running is left. */
  ended(agentId: string): void {
    this.drop((written) => written.startsWith(`${agentId}|`));
  }

  /** The chats whose CLI's command the last process was stopped with, once each — taken at the start, to be told. */
  interrupted(): OwnChat[] {
    const chats = [...new Map(this.before.map((chat) => [`${chat.agentId}|${chat.gatewayId}|${chat.chatId}`, chat])).values()];
    this.before = [];
    this.file?.save(this.left);
    return chats;
  }

  private drop(done: (key: string) => boolean): void {
    const kept = Object.entries(this.left).filter(([key]) => !done(key));
    if (kept.length === Object.keys(this.left).length) return;
    this.left = Object.fromEntries(kept);
    this.file?.save(this.left);
  }
}
