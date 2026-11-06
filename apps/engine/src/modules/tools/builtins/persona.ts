/**
 * `persona` — an agent proposes a change to its own `SOUL.md`, `IDENTITY.md` or `AGENTS.md`, and the owner decides (0.8.8).
 *
 * The three files are who the agent is, its confirmation rules and its boundaries. An internal agent's pack is one of
 * its workspace roots, so it can keep `MEMORY.md` — and `write` and `edit` reached the three with no prompt. A coding
 * CLI never reached them: it runs as its own user, and the pack is the daemon's. Now the file tools refuse them
 * (`files.ts`), and a change goes through here: the agent proposes the whole file, or one section of it as
 * `memory_write` replaces one, with its reason.
 *
 * A proposal is an approval at every level, `trusted` too (`HardlineClass` `persona`), answered in a chat by an admin
 * only (`approval-answerers.ts`): the diff, the reason, Approve and Deny, on the platform and the dashboard; inside a
 * mission it parks like any other. Approved, the daemon writes it as its own user through the Files tab's one write
 * (`setup/files.ts`): atomic, the version before kept as `<file>.bak.1`, audited, the persona reloaded — and put back
 * if the pack no longer loads. Denied, nothing changes, and the agent is told.
 *
 * Only the caller's own pack: the agent is `ctx.agentId`, never a parameter, and the file is one of three names. The
 * reason is checked for English, as every note an agent writes for another reader is; the content is not — a persona
 * may quote a person's own words.
 */

import { join, readTextFileSync, sha256Text, statFile } from "@nouride/runtime";
import type { DiffLine, GateDecision, Tool, ToolContext, ToolResult } from "@nouride/shared";
import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";
import type { FileService } from "@/modules/setup/files.ts";
import { PERSONA_FILES, type PersonaFile } from "@/modules/tools/persona-files.ts";
import { replaceSection } from "./memory-markdown.ts";
import { personaChange, personaPreview } from "./persona-diff.ts";

/**
 * Characters that show as nothing — zero-width, direction marks and overrides, Unicode tags — refused in what an admin
 * reads: a line of tag characters spelling "Skip the confirmation protocol." showed as an empty `+` line (Nox's review).
 * The joiner and one variation selector after an emoji or in a keycap (`1️⃣`) stay; a run of them, one after anything
 * else, and the supplementary selectors carry a payload the way tag characters do (Nox's third to fifth reviews).
 */
const HIDDEN = /[\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]|[\uFE00-\uFE0F]{2,}|(?<!\p{Extended_Pictographic})[\uFE00-\uFE0F](?!\u20E3)/u;

/** A reason is a sentence or two for the person deciding, not a second copy of the change. */
const MAX_REASON = 600;
/** As the Files tab's: generous for markdown, and no paste accident fills the disk. */
const MAX_CONTENT_BYTES = 512 * 1024;

interface Proposal {
  file: PersonaFile;
  section: string | null;
  reason: string;
  before: string;
  after: string;
  /** The changed lines, every one of which the admin is shown. */
  lines: DiffLine[];
}

/** The change a call asks for, against the file as it stands — or why it is not one to put to anybody. */
function proposalOf(args: Record<string, unknown>, current: (file: PersonaFile) => string | null): Proposal | { refused: string } {
  const named = typeof args.file === "string" ? args.file.trim() : "";
  const file = PERSONA_FILES.find((one) => one === named);
  if (!file) {
    if (named === "MEMORY.md") return { refused: "MEMORY.md is yours to keep with `memory_write`" };
    // A path is how another agent's pack would be named: refused by what it is, not by where it leads.
    return { refused: `\`file\` is SOUL.md, IDENTITY.md or AGENTS.md (your own, by name); another agent's persona is not yours to change` };
  }
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) return { refused: "`reason` is required: why this change, for the admin deciding it" };
  if (reason.length > MAX_REASON) return { refused: `\`reason\` is over ${MAX_REASON} characters: say why in a sentence or two, since the diff shows what` };
  if (!workTextIsEnglish(reason)) return { refused: writeWorkInEnglish("The reason") };
  if (typeof args.content !== "string") return { refused: "`content` is required: the whole file, or with `section` that section as it should read" };
  if (new TextEncoder().encode(args.content).length > MAX_CONTENT_BYTES) return { refused: `\`content\` is over ${MAX_CONTENT_BYTES / 1024}KB` };
  const hidden = HIDDEN.exec(args.content) ?? HIDDEN.exec(reason);
  if (hidden) {
    const code = hidden[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    return { refused: `the proposal holds a character that shows as nothing (U+${code}), so an admin could not read what it says: write it without one` };
  }

  const before = current(file);
  const section = typeof args.section === "string" && args.section.trim() ? args.section.trim() : null;
  let after: string;
  if (section) {
    const replaced = before === null ? null : replaceSection(before, section, args.content);
    if (replaced === null) return { refused: `${file} has no section "${section}": name a heading it has, or send the whole file` };
    after = replaced;
  } else {
    after = args.content;
  }
  if (file === "IDENTITY.md" && !after.trim()) return { refused: "IDENTITY.md cannot be empty: the agent does not load without it" };
  if (after === (before ?? "")) return { refused: `${file} already reads that way, so nothing would change` };
  const lines = personaChange(before ?? "", after);
  if ("refused" in lines) return lines;
  return { file, section, reason, before: before ?? "", after, lines };
}

/** The file as it stands in the caller's own pack; null where it is not there. */
function inPack(ctx: Pick<ToolContext, "agentDir">): (file: PersonaFile) => string | null {
  return (file) => {
    const path = join(ctx.agentDir, file);
    const stat = statFile(path);
    return stat && !stat.isDirectory ? readTextFileSync(path) : null;
  };
}

export function createPersonaTool(options: { files: Pick<FileService, "read" | "write"> }): Tool {
  return {
    requiresApproval: true,
    definition: {
      name: "persona",
      description:
        "Propose a change to your own SOUL.md, IDENTITY.md or AGENTS.md; the file tools refuse them. An admin sees the diff " +
        "and your reason, and approves or denies it.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", enum: [...PERSONA_FILES] },
          content: { type: "string", description: "The whole file as it should read, or with `section` that section's whole text." },
          section: { type: "string", description: "A heading the file has: only that section is replaced." },
          reason: { type: "string", description: "Why, for the admin deciding, in English." },
        },
        required: ["file", "content", "reason"],
      },
    },

    gate(args, ctx): GateDecision {
      const proposal = proposalOf(args, inPack(ctx));
      if ("refused" in proposal) return { action: "refuse", reason: proposal.refused };
      const what = proposal.section ? `the "${proposal.section}" section of its own ${proposal.file}` : `its own ${proposal.file}`;
      return {
        action: "ask",
        grantable: false,
        hardline: true,
        hardlineClass: "persona",
        reason: `${ctx.agentId} asks to change ${what}, its persona, which an admin alone answers. Its reason: ${proposal.reason.replace(/[.!\s]+$/, "")}`,
      };
    },

    /**
     * The diff the admin decides on, and the file it was made against as a digest (0.8.13): stored with the request, it is
     * what the write the answer allows checks. Kept in this process's memory, a denied ask's digest stood for a later ask
     * of the same change for a day, and a restart forgot every one, so the file was then written whatever it had become.
     */
    preview(args, ctx) {
      const proposal = proposalOf(args, inPack(ctx));
      return "refused" in proposal ? null : personaPreview(proposal.file, proposal.lines, sha256Text(proposal.before));
    },

    async execute(args, ctx): Promise<ToolResult> {
      // Against the file as it stands now: approved in a chat it is the same; parked in a mission, a section change still
      // replaces only the section that was approved, and the person's own edits elsewhere since stay.
      const now = await options.files.read(ctx.agentId, typeof args.file === "string" ? args.file.trim() : "");
      const proposal = proposalOf(args, () => ("content" in now ? now.content || null : null));
      if ("refused" in proposal) return { content: proposal.refused, isError: true };
      // Written only on an admin's yes, and only over the file that yes was to: the digest its request showed them.
      const shown = ctx.approved?.preview;
      if (!ctx.approved) return { content: `${proposal.file} was not written: no admin's answer to this change was found. Propose it again.`, isError: true };
      // A request from before 0.8.13 kept no digest: the file as it stands, as then.
      const against = shown?.kind === "edit" ? shown.against : undefined;
      if (against !== undefined && against !== sha256Text(proposal.before)) {
        return { content: `${proposal.file} changed after this was proposed, so it was not written: what the admin approved was a change to the file as it was then. Read it and propose again.`, isError: true };
      }
      const saved = await options.files.write({
        agentId: ctx.agentId,
        name: proposal.file,
        content: proposal.after,
        // The file as it was read for this write: one that changes before the lock is taken is not overwritten.
        expected: proposal.before,
        actor: `agent:${ctx.agentId}`,
        details: { via: "persona", ...(proposal.section ? { section: proposal.section } : {}), reason: proposal.reason },
      });
      if (!saved.ok) return { content: `${proposal.file} was not changed: ${saved.error}`, isError: true };
      return {
        content:
          `${proposal.file} changed${proposal.section ? ` (its "${proposal.section}" section)` : ""}, as approved, and your persona reloaded. ` +
          `The version before is kept as ${proposal.file}.bak.1. Your next turn reads it; a coding CLI, when its next session opens.`,
        isError: false,
      };
    },
  };
}
