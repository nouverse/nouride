/**
 * How a system event lets an agent say nothing (0.8.12): a reply of only ".", which the daemon drops — a system
 * event's answer with no letter or digit in it is the silence it was allowed (`pipeline/turn.ts`).
 *
 * "Reply with nothing at all" was right for a model and wrong for a coding CLI: Claude Code asks its model again for
 * visible output when a turn ends empty, and the person got a filler line ("nothing to report again, now I'm
 * waiting…") where silence was asked for. A full stop is something either can send.
 */
export const SAY_NOTHING = 'reply with only "." (it is not sent)';

/** Whether an answer holds a word: a letter or a digit. "." and "…" hold none. */
export const hasWords = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/**
 * What a turn wrote beside its tool calls, in order: the words of each step that also called a tool.
 *
 * On a system event's turn none of them is sent as it is written (`pipeline/preamble.ts` is a person's turn's), and
 * the turn's last answer is what the chat gets. A model writes its report in the same step as one more call and then,
 * asked to "reply with only ." where the result was already reported, ends on the full stop: to it, what it wrote was
 * said. Live, a helper came back having failed; the agent wrote its whole report and a question for the person
 * beside a `notes` call, ended on ".", and the chat got nothing. The person waited nine minutes on a promise of news,
 * and the agent on an answer to a question nobody had been sent.
 *
 * `unsent`: on a person's turn some of those words went to the chat as they were written (the opening line), and only
 * what did not is still owed.
 */
export function writtenBesideCalls(turn: readonly { role: string; content: unknown; toolCalls?: readonly unknown[] }[], unsent: (words: string) => boolean = () => true): string {
  return turn
    .filter((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
    .map((message) => (typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("") : "").trim())
    .filter((words) => hasWords(words) && unsent(words))
    .join("\n\n");
}
