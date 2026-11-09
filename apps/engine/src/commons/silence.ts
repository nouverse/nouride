/**
 * How a system event lets an agent say nothing (0.8.12): a reply of only ".", which the daemon drops — a system
 * event's answer with no letter or digit in it is the silence it was allowed (`pipeline/turn.ts`).
 *
 * "Reply with nothing at all" was right for a model and wrong for a coding CLI: Claude Code asks its model again for
 * visible output when a turn ends empty, and the person got a filler line ("nothing to report again, now I'm
 * waiting…") where silence was asked for. A full stop is something either can send.
 */
export const SAY_NOTHING = 'reply with only "." (it is not sent)';
