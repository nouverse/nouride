/**
 * `nouride memory tags` — the tags memory counts by, and the tidy: what the rules would merge and trim,
 * applied when asked, undone the same way. Over the control API, like every memory command; the daemon
 * backs the vault up before it writes.
 */

import type { Client } from "@nouride/cli-kit";
import { flagValue, hasFlag, BOLD, DIM, GREEN, RESET, YELLOW, fail, say, usageError } from "@nouride/cli-kit";

interface TagList {
  tags: { tag: string; n: number; aliases: string[] }[];
  once: number;
}

interface Change {
  id: string;
  kind: "merge" | "trim" | "cap";
  from: string[];
  into?: string;
  episodes: number;
  why: string;
  reason?: string;
}

interface Plan {
  changes: Change[];
  tags: number;
  once: number;
  last: { at: string; changes: number; episodes: number } | null;
}

const SHOWN = 30;

function describe(change: Change): string {
  if (change.kind === "merge") return `merge ${change.from.join(", ")} → ${BOLD}${change.into}${RESET} ${DIM}(${change.why}, ${change.episodes} conversation(s))${change.why === "R5" ? ", only with --only R5" : ""}${RESET}`;
  const what = change.kind === "cap" ? "cap at 4 tags" : change.id === "trim:archive" ? "trim one-off tags from imported days" : "trim extra one-off tags from conversations";
  return `${what}: ${change.from.length} tag(s) on ${change.episodes} conversation(s) ${DIM}(${change.why})${RESET}`;
}

export async function memoryTags(client: Client, args: string[]): Promise<void> {
  const [action, ...rest] = args;

  if (action === undefined) {
    const list = await client.get<TagList>("/memory/tags");
    say(`${BOLD}${list.tags.length} tag(s)${RESET}${DIM}, ${list.once} on one conversation only${RESET}`);
    for (const entry of list.tags.slice(0, SHOWN)) {
      say(`  ${String(entry.n).padStart(4)}  ${entry.tag}${entry.aliases.length ? ` ${DIM}(also ${entry.aliases.join(", ")})${RESET}` : ""}`);
    }
    if (list.tags.length > SHOWN) say(`  ${DIM}… ${list.tags.length - SHOWN} more${RESET}`);
    return say(`${DIM}nouride memory tags tidy: what can be merged and trimmed${RESET}`);
  }

  if (action === "tidy") {
    const plan = await client.get<Plan>("/memory/tags/tidy");
    const only = flagValue(args, "--only")?.split(",").map((kind) => kind.trim());
    // R5 folds a narrower tag into a broad one, which may be a subject of its own — and the alias it leaves
    // folds that tag every night after. So it is applied only when named, never by `merge` or by default.
    const chosen = plan.changes.filter((change) => (only ? only.includes(change.why) || (only.includes(change.kind) && change.why !== "R5") : change.why !== "R5"));
    if (!hasFlag(args, "--apply")) {
      if (plan.changes.length === 0) return say(`${GREEN}✓${RESET} nothing to tidy: ${plan.tags} tag(s), ${plan.once} on one conversation only`);
      say(`${BOLD}${plan.changes.length} change(s)${RESET} ${DIM}over ${plan.tags} tag(s), ${plan.once} on one conversation only${RESET}`);
      for (const change of plan.changes) say(`  ${describe(change)}`);
      return say(`${DIM}apply: nouride memory tags tidy --apply [--only merge,trim,cap,R5] (R5 only when named); the vault is backed up first, and undo puts it back${RESET}`);
    }
    if (chosen.length === 0) return say(`${YELLOW}!${RESET} nothing to apply`);
    const done = await client.post<{ changes: number; episodes: number }>("/memory/tags/tidy", { ids: chosen.map((change) => change.id) });
    return say(`${GREEN}✓${RESET} tidied: ${done.changes} change(s) over ${done.episodes} conversation(s) ${DIM}(nouride memory tags undo puts it back)${RESET}`);
  }

  // The model's view of which tags mean one subject — what the rules cannot see. Shown, never applied:
  // each group comes with the hand merge that would apply it.
  if (action === "suggest") {
    const { changes, dropped = [], readable = true } = await client.post<{ changes: Change[]; dropped?: { from: string[]; into: string; why: string }[]; readable?: boolean }>("/memory/tags/tidy/model", {});
    if (!readable) fail("The model's answer could not be read, so nothing was suggested.", "Try again, or set a stronger model for the pass: nouride memory set pass_model <provider>/<model>");
    if (changes.length === 0 && dropped.length === 0) return say(`${GREEN}✓${RESET} the model found no tags that mean one subject`);
    if (changes.length) say(`${BOLD}${changes.length} group(s) the model would merge${RESET} ${DIM}(checked, not applied)${RESET}`);
    for (const change of changes) {
      say(`  ${change.from.join(", ")} → ${BOLD}${change.into}${RESET}${change.reason ? ` ${DIM}(${change.reason})${RESET}` : ""}`);
      say(`    ${DIM}nouride memory tags merge ${change.from.join(" ")} --into ${change.into}${RESET}`);
    }
    if (dropped.length) say(`${DIM}${dropped.length} more the checks dropped:${RESET}`);
    for (const group of dropped) say(`  ${DIM}${group.from.join(", ")} → ${group.into || "?"}: ${group.why}${RESET}`);
    return;
  }

  if (action === "merge") {
    const into = flagValue(args, "--into");
    const from = rest.filter((word, i) => !word.startsWith("--") && rest[i - 1] !== "--into");
    if (!into || from.length === 0) usageError("nouride memory tags merge <tag…> --into <tag>");
    const done = await client.post<{ episodes: number }>("/memory/tags/merge", { from, into });
    return say(`${GREEN}✓${RESET} merged ${from.join(", ")} into ${into} on ${done.episodes} conversation(s)`);
  }

  if (action === "undo") {
    const done = await client.post<{ restored: number; skipped: string[] }>("/memory/tags/tidy/undo", {});
    say(`${GREEN}✓${RESET} put back ${done.restored} conversation(s)`);
    if (done.skipped.length) say(`${DIM}left as they are, changed since: ${done.skipped.join(", ")}${RESET}`);
    return;
  }

  usageError(`unknown: nouride memory tags ${action}`, "nouride memory tags · tags tidy [--apply] [--only merge,trim,cap,R5] · tags suggest · tags merge <tag…> --into <tag> · tags undo");
}
