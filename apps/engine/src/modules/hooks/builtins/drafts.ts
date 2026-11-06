/**
 * `/drafts` — deciding on a proposed skill from the chat it came out of.
 *
 * **Why not `/approve`.** The RFC asked for `/approve <id>` and `/deny <id>`, and that name is taken
 * by the tool-approval gate, where it means something with a five-minute fuse attached to a turn that
 * is blocked right now. Overloading it would make the most consequential command in this daemon
 * ambiguous at exactly the moment somebody is typing it quickly on a phone — and the failure would be
 * silent, because both readings are plausible for a bare id. One verb, one lifecycle.
 *
 * Every subcommand is deliberately survivable from a phone: a draft can be named by its skill name,
 * not only by `dft_` and twenty characters of base32.
 */

import { approvedSentence, draftVerb } from "@/modules/reflection/moves.ts";
import type { SkillDraft } from "@/modules/reflection/types.ts";
import type { Hook } from "../types.ts";

export const draftHooks: Hook[] = [
  {
    command: "/drafts",
    description: "Skills I have drafted and want your call on: `show`, `approve`, `deny`",
    handler: async (ctx) => {
      const drafts = ctx.deps.drafts;
      if (!drafts) {
        return { handled: true, reply: "Self-improvement is not wired in this build." };
      }

      const [verb, ...rest] = ctx.args;
      const reference = rest.join(" ").trim();

      if (!verb) return { handled: true, reply: renderList(drafts.pending()) };

      if (/^(list|ls)$/i.test(verb)) return { handled: true, reply: renderList(drafts.pending()) };

      if (/^(show|read|view)$/i.test(verb)) {
        const draft = drafts.resolve(reference);
        if (!draft) return { handled: true, reply: notFound(reference, drafts) };
        return { handled: true, reply: renderDraft(draft) };
      }

      if (/^(approve|ok|yes|simpan|save)$/i.test(verb)) {
        /**
         * `/drafts approve` with nothing after it approves everything waiting.
         *
         * Asked for, and only for approve. Denying is destructive and irreversible — the row and its
         * transcript are deleted — so a bare `/drafts deny` would be one keystroke between a queue
         * and nothing, which is not a thing to make convenient. Approving in bulk is undoable one
         * skill at a time with `nouride skills off`.
         *
         * Sequential rather than parallel: each approval writes a file and reloads every agent's
         * pack, and two of those at once is two writers on one directory. Nothing here is waiting on
         * the clock.
         */
        if (!reference) {
          const waiting = drafts.pending();
          if (waiting.length === 0) return { handled: true, reply: "Nothing is waiting." };

          const done: string[] = [];
          const failed: string[] = [];
          for (const one of waiting) {
            const outcome = await drafts.approve(one.id, ctx.senderId);
            if (outcome.ok) done.push(one.name);
            else failed.push(`${one.name}: ${outcome.error}`);
          }
          return {
            handled: true,
            reply: [
              done.length > 0
                ? `✅ Approved ${done.length} draft${done.length === 1 ? "" : "s"}: ${done.join(", ")}.`
                : "Nothing was approved.",
              // Named individually, because a count would leave the operator to work out which of
              // the ones they just approved is not actually in the pool.
              ...(failed.length > 0 ? ["", `Could not approve:`, ...failed.map((f) => `· ${f}`)] : []),
            ].join("\n"),
          };
        }

        const draft = drafts.resolve(reference);
        if (!draft) return { handled: true, reply: notFound(reference, drafts) };

        // The sender id, not a display name. The audit log has to answer "who said yes" against
        // something that identifies a person, and a platform display name is a string they chose.
        const result = await drafts.approve(draft.id, ctx.senderId);
        return {
          handled: true,
          reply: result.ok
            ? [
                `✅ **${draft.name}** ${approvedSentence(draft)}.`,
                ...(result.path ? [`\`${result.path}\``] : []),
              ].join("\n")
            : `Could not approve it: ${result.error}`,
        };
      }

      if (/^(deny|no|discard|buang|tolak)$/i.test(verb)) {
        const draft = drafts.resolve(reference);
        if (!draft) return { handled: true, reply: notFound(reference, drafts) };

        const gone = drafts.deny(draft.id, ctx.senderId);
        return {
          handled: true,
          reply: gone
            ? `🗑️ Discarded **${draft.name}**. The draft and its transcript are gone.`
            : `**${draft.name}** was already decided.`,
        };
      }

      return {
        handled: true,
        reply:
          "`/drafts` · `/drafts show <name>` · `/drafts approve <name>` · `/drafts approve` (all) · `/drafts deny <name>`",
      };
    },
  },
];

/**
 * Why a reference did not resolve — and "no such draft" is not always the answer.
 *
 * Two sessions can propose an improvement to the same skill, and both wait. `resolve` refuses an
 * ambiguous name rather than picking one, so without this the person is told their draft does not
 * exist while two of them sit in the queue — and goes looking for a bug that is not there.
 */
function notFound(reference: string, drafts: { pendingAllByName(name: string): SkillDraft[] }): string {
  if (!reference) return "Name a draft: `/drafts approve <id>`. `/drafts` lists what is waiting.";

  const sharing = drafts.pendingAllByName(reference);
  if (sharing.length > 1) {
    return [
      `${sharing.length} drafts are waiting under \`${reference}\`, so the name is not enough. By id:`,
      ...sharing.map((draft) => `  \`${draft.id}\`: ${draft.triggerReason}`),
    ].join("\n");
  }
  return `No draft called \`${reference}\` is waiting. \`/drafts\` lists what is.`;
}

/**
 * The queue.
 *
 * Says out loud that nothing expires, because that is the property people do not expect from a
 * pending list and the one that decides whether they feel they have to act tonight.
 */
function renderList(pending: SkillDraft[]): string {
  if (pending.length === 0) {
    return "No skill drafts are waiting. I raise one when a turn takes real working out.";
  }

  const rows = pending.map((draft) => {
    const age = describeAge(Date.now() - draft.createdAt);
    // What approving moves, first: `/drafts approve` takes the whole queue, and an archive must not read as a new skill.
    const verb = draftVerb(draft);
    return `• ${verb ? `${verb} ` : ""}**${draft.name}**: ${draft.description}\n  _${draft.agentId}, ${age}_`;
  });

  return [
    `${pending.length} skill draft${pending.length === 1 ? "" : "s"} waiting on you:`,
    "",
    ...rows,
    "",
    // `approve` on its own is offered here and not on a single-draft view: it only means anything
    // when there is a queue, and this is the only screen that shows one.
    pending.length > 1
      ? "`/drafts show <name>` · `/drafts approve <name>` · `/drafts deny <name>` · `/drafts approve` takes all " +
        `${pending.length}`
      : "`/drafts show <name>` to read one · `/drafts approve <name>` · `/drafts deny <name>`",
    "Nothing expires. They wait until you decide.",
  ].join("\n");
}

function renderDraft(draft: {
  name: string;
  description: string;
  requires: string;
  body: string;
  agentId: string;
  triggerReason: string;
}): string {
  return [
    `**${draft.name}**`,
    draft.description,
    ...(draft.requires ? [`Needs: ${draft.requires}`] : []),
    `Drafted by ${draft.agentId}: ${draft.triggerReason}`,
    "",
    "---",
    "",
    draft.body,
    "",
    "---",
    `\`/drafts approve ${draft.name}\` · \`/drafts deny ${draft.name}\``,
  ].join("\n");
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
