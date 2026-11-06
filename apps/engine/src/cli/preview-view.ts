/**
 * An approval summary, drawn for a terminal.
 *
 * The counterpart to the chat renderer in `notify.ts`: same decision about what matters, different
 * drawing. A terminal gets colour and a diff; a chat bubble gets three lines of markdown.
 *
 * What this replaced: `JSON.stringify(params, null, 2)`, which for a `write` printed the entire file. A
 * 3KB landing page scrolled past three times in one turn and the operator answered `y` without reading
 * any of it — the gate was technically working and practically off.
 */

import { previewHeadline, type ApprovalPreview } from "@nouride/shared";

const RESET = "\x1b[0m";
const DIM = "\x1b[90m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

/**
 * The lines to print for one pending approval.
 *
 * Returns lines rather than printing them so the caller owns output — and so this is testable without
 * capturing stdout, which is the difference between a test that checks the rendering and a test that
 * checks that something was printed.
 */
export function renderPreview(
  preview: ApprovalPreview | undefined,
  params: Record<string, unknown>,
): string[] {
  if (!preview) {
    // No summary: a request stored before previews existed, or parameters with no shape worth
    // summarising. The raw arguments are still better than nothing, but compact — the pretty-printed
    // version is what made this unreadable.
    return [`${DIM}  ${JSON.stringify(params)}${RESET}`];
  }

  const lines = [`  ${previewHeadline(preview)}`];

  if (preview.kind === "edit") {
    lines.push("");
    for (const line of preview.hunk) {
      const colour = line.sign === "-" ? RED : line.sign === "+" ? GREEN : DIM;
      lines.push(`  ${colour}${line.sign} ${line.text}${RESET}`);
    }
    if (preview.clipped) lines.push(`${DIM}  … clipped (nouride approvals shows it in full)${RESET}`);
  }

  if (preview.kind === "overwrite") {
    // Said out loud, because it is the one case where approving destroys something and the headline
    // alone reads like any other write.
    lines.push(`${DIM}  the existing file is replaced entirely${RESET}`);
  }

  if (preview.kind === "command" && preview.shell) {
    // The line above looks like one command. It is a shell, and everything after `-c` is a program in
    // its own right — pipes, redirection, chained `&&`. Approving it "always" binds the exact string,
    // but reading it as a single tidy command is how a human skims past the second half.
    lines.push(`${DIM}  this runs a shell: everything after -c is executed${RESET}`);
  }

  if ((preview.kind === "command" || preview.kind === "params") && preview.clipped) {
    lines.push(`${DIM}  … clipped (nouride approvals shows it in full)${RESET}`);
  }

  return lines;
}
