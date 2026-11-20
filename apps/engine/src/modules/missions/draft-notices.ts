/**
 * A draft's one notice in its chat. Sent when the draft is made, with Start it and Drop it; when the draft changes,
 * that message is rewritten where it stands, its buttons kept, on a connection that can rewrite one. Where it cannot,
 * or the message is not known any more (a restart, a notice that went out in parts), the chat gets one line saying
 * what changed, and the draft whole is on its page.
 *
 * Every change used to send the whole draft again. An agent tidies a draft two or three times in its first minutes,
 * and a person's chat held the same goal three times, each a notification on their phone: fifteen of them in two
 * weeks on the live box, beside fourteen drafts.
 */

import type { MessageButton } from "@nouride/shared";

interface Where {
  gatewayId: string;
  chatId: string;
}

/** The chat as these notices reach it: what was posted, by its message ids; a message rewritten with its buttons. */
export interface DraftChat {
  ask(to: Where, text: (buttons: boolean) => string, buttons: MessageButton[]): Promise<{ ids: string[]; buttons: boolean } | null>;
  rewrite(to: Where, messageId: string, text: string, buttons: readonly MessageButton[]): Promise<boolean>;
  say(to: Where, text: string): Promise<unknown>;
}

/** With buttons under it, the notice says so; without, its own commands stand in for them. */
const withButtons = (text: string, carried: boolean): string => (carried ? `${text}\nOr tap a button below.` : text);

export class DraftNotices {
  private readonly sent = new Map<string, Where & { messageId: string; buttons: boolean }>();

  constructor(private readonly chat: DraftChat) {}

  /** The draft made: its notice, remembered when it is one message. */
  async made(missionId: string, to: Where, whole: string, buttons: MessageButton[]): Promise<void> {
    const posted = await this.chat.ask(to, (carried) => withButtons(whole, carried), buttons);
    if (posted && posted.ids.length === 1) this.sent.set(missionId, { ...to, messageId: posted.ids[0]!, buttons: posted.buttons });
    else this.sent.delete(missionId);
  }

  /** The draft changed: its notice rewritten in place, or one line where it cannot be. Which of the two, for the record. */
  async changed(missionId: string, to: Where, whole: string, line: string, buttons: MessageButton[]): Promise<"rewritten" | "said"> {
    const known = this.sent.get(missionId);
    if (known && known.gatewayId === to.gatewayId && known.chatId === to.chatId && (await this.chat.rewrite(to, known.messageId, withButtons(whole, known.buttons), buttons))) return "rewritten";
    await this.chat.say(to, line);
    return "said";
  }

  /** The draft started, was dropped or ended: its notice is not rewritten again. */
  forget(missionId: string): void {
    this.sent.delete(missionId);
  }

  get size(): number {
    return this.sent.size;
  }
}
