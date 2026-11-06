/**
 * Telling the chat a skill was drafted, or kept.
 *
 * Split out of `index.ts`, which is over its line budget and may only shrink. Two builders that read
 * as one concern: both answer "what does the person in that conversation need to be told", and the
 * *difference* between them is the whole point — one asks for a decision and one reports a decision
 * already made, and a message offering approve/deny for something already live is how a
 * notification teaches people to ignore it.
 */

import type { Notifier } from "@/commons/notify.ts";
import { lessonOf } from "./drafts.store.ts";
import type { SkillDraft } from "./types.ts";

export interface NotifyDeps {
  /** `[skills.learning] notify_chat`. Off leaves the dashboard and `nouride skills drafts` as the only way in. */
  notifyChat: boolean;
  notifier?: Notifier;
}

/**
 * Tell the conversation the draft came out of.
 *
 * There, rather than in the operator's alert chat, because the person who just watched the agent
 * work out the procedure is the one who can say whether it is worth keeping. `[alerts]` is for
 * things about the daemon; this is about the work.
 */
export async function announceDraft(deps: NotifyDeps, draft: SkillDraft, superseded = false): Promise<void> {
  if (!deps.notifyChat) return;
  if (!deps.notifier || !draft.gatewayId || !draft.chatId) return;

  /**
   * Two sentences and the commands.
   *
   * This was ten lines: the description, `Needs:`, the reason, and a paragraph explaining that
   * nothing happens until you approve. All true, and all of it read once — by the tenth of these
   * the paragraph is scenery, and the description is the skill's *trigger* line rather than
   * anything that helps decide. What is left is the two facts a decision needs: which skill, and
   * what it learned. `/drafts show` is right there for the rest.
   */
  const lines = [
    superseded
      // Said plainly, because otherwise a second message about the same skill reads as the daemon
      // repeating itself — and the reviewer needs to know the earlier one is gone.
      ? `💡 Learned more since: rewrote the draft for **${draft.name}**, replacing the earlier one.`
      : draft.triggerKind === "external_install"
        ? `📦 Found a skill, **${draft.name}**. It is waiting for your approval before anything is installed.`
        : draft.target
        ? `💡 Learned something just now: drafted an improvement to **${draft.name}**.`
        : `💡 Learned something just now: drafted a new skill, **${draft.name}**.`,
    lessonOf(draft.triggerReason),
    // Only when there is more in it than the sentence above says. This is the one line that changes
    // how big the decision is, so it survives the trim.
    ...(draft.carries.length > 0
      ? [`Carries ${draft.carries.length} earlier lesson${draft.carries.length === 1 ? "" : "s"} too.`]
      : []),
    "",
    `\`/drafts approve ${draft.name}\`   ·   \`/drafts deny ${draft.name}\`   ·   \`/drafts show ${draft.name}\``,
  ];

  await deps.notifier.toChat({ gatewayId: draft.gatewayId, chatId: draft.chatId }, lines.join("\n"));
}

/**
 * The `auto` message: what it kept, not what it wants.
 *
 * A separate wording rather than a flag on `announce`, because that message is three-quarters
 * instructions for deciding — approve, deny, show — and every one of those is wrong here: the
 * decision is made and the skill is live. Telling somebody to approve what is already in the pool
 * is how a notification teaches people to stop reading it.
 *
 * Still sent, though. `auto` means nobody was *asked*, not that nobody is told — the pool
 * changed under every agent on this daemon, and `nouride skills drafts` shows it approved with the
 * daemon as actor if they want the detail.
 */
export async function announceAccepted(deps: NotifyDeps, draft: SkillDraft, superseded = false): Promise<void> {
  if (!deps.notifyChat) return;
  if (!deps.notifier || !draft.gatewayId || !draft.chatId) return;

  // Trimmed alongside `announceDraft`, and one line shorter: there is no decision to support here,
  // only a change to be told about and a way to look at what changed.
  const lines = [
    superseded
      ? `✅ Learned more about **${draft.name}** and rewrote it. The pool has the newer version.`
      : `✅ Learned something just now and kept it as a skill: **${draft.name}**.`,
    lessonOf(draft.triggerReason),
    "",
    `\`/drafts show ${draft.name}\`   ·   \`nouride skills off ${draft.name} <agent>\` takes it back out`,
  ];

  await deps.notifier.toChat({ gatewayId: draft.gatewayId, chatId: draft.chatId }, lines.join("\n"));
}
