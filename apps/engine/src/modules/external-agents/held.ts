/**
 * A chat's turn that ends where its agent's own work ended, though its CLI has not answered the prompt.
 *
 * Claude Code's connector keeps a prompt open until the helpers the CLI started in the background have ended, for a
 * client that has not told it otherwise. Nouride took a turn to be over when its prompt answered, so an agent that
 * said "two helpers in the background, this chat stays free" was shown at work in that chat for as long as they took,
 * and a message sent meanwhile went into that turn.
 *
 * The connector says when the CLI's own turn has ended (`CliRow.ended`) and whose each call is (`CliRow.helper`), so
 * the reader of the prompt's updates knows when only helpers work on (`UpdateReader.heldFor`). The turn ends there:
 * the prompt is let go of (`CliConnection.prompt`), the chat is free, the next message is a turn of its own, and what
 * the agent says once its helpers have ended is said by itself (`own-words.ts`). Only in the agent's own chat: a
 * mission's turn and one another agent asked for wait for the helpers, whose work is part of their answer.
 */

import { contained, createLogger } from "@nouride/shared";
import type { UpdateReader } from "./updates.ts";

const log = createLogger("external-agents");

/**
 * How long after a CLI's own turn ended, with nothing of the agent's own since and a helper at work, the chat's turn
 * ends. A connector that holds the prompt for such helpers holds it at once, so the wait is only for a turn that is
 * not over: one a message was steered into goes on with the agent's own words seconds after the turn it cut short
 * said it ended. A choice.
 */
const HELD_QUIET_MS = 10_000;

/** Looks, while a prompt runs, for the moment only its CLI's helpers work on: `ended` then, and `stop` ends the looking. */
export function lookForHeld(read: UpdateReader, quietMs: number = HELD_QUIET_MS): { ended: Promise<void>; stop: () => void } {
  let endsHere: () => void = () => {};
  const ended = new Promise<void>((resolve) => (endsHere = resolve));
  const looking = setInterval(contained(log, "could not look whether a CLI's own work has ended", () => void (read.heldFor(quietMs) && endsHere())), Math.min(1_000, quietMs));
  return { ended, stop: () => clearInterval(looking) };
}
