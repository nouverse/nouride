/**
 * A mission's progress, one message (0.8.7): where the chat can edit what it was sent, the line is rewritten in place
 * rather than a new one sent every half hour — a mission of eight hours left sixteen lines nobody needed but the last.
 * Where it cannot, or the edit fails (the message deleted, too old to edit), a new one is sent, as before, and that one
 * is rewritten next. Kept in memory: after a restart the next line is a new message.
 */

export interface ProgressChat {
  /** Send a line; the id of the message it became, where the connection says. */
  send(to: { gatewayId: string; chatId: string }, text: string): Promise<string | undefined>;
  /** Rewrite one; false where the connection cannot, or did not. */
  edit(to: { gatewayId: string; chatId: string }, messageId: string, text: string): Promise<boolean>;
}

export class ProgressLines {
  private readonly sent = new Map<string, { gatewayId: string; chatId: string; messageId: string }>();

  constructor(private readonly chat: ProgressChat) {}

  async say(missionId: string, to: { gatewayId: string; chatId: string }, text: string): Promise<void> {
    const known = this.sent.get(missionId);
    if (known && known.gatewayId === to.gatewayId && known.chatId === to.chatId && (await this.chat.edit(to, known.messageId, text))) return;
    const messageId = await this.chat.send(to, text);
    if (messageId) this.sent.set(missionId, { ...to, messageId });
    else this.sent.delete(missionId);
  }

  /** The mission ended: its next line, if it ever had one, would be a new message. */
  forget(missionId: string): void {
    this.sent.delete(missionId);
  }

  get size(): number {
    return this.sent.size;
  }
}
