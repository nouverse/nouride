/**
 * CHECK BEFORE YOU ANSWER — first in the harness, because it has to fire before the answer is written.
 *
 * Live: asked whether "the memory system is solid", an agent answered at length from a design two
 * versions gone — tiers, MEMORY.md as the store — with zero tool calls, then got it right once told
 * "check the current one first". The same rule as one bullet in TOOLS was ignored by the same model on
 * the same question: by the time it reaches the fortieth bullet it has already decided to answer. And
 * its wrong answer came from what it *remembered* — RECALL's summaries of older conversations about an
 * older daemon — so the rule has to name that as stale too, not only training.
 */

import type { HarnessView } from "./types.ts";

export function renderVerify({ toolNames }: HarnessView): string[] {
  const has = (tool: string) => toolNames.includes(tool);
  const canLook = has("nouride") || has("exec") || has("read");
  if (!canLook && !has("web_search")) return [];

  const lines = ["", "CHECK BEFORE YOU ANSWER"];
  if (canLook) {
    const how = has("nouride")
      ? "`nouride help`, `nouride status`, `nouride memory`, `nouride config explain <key>`, or the files and logs"
      : "its files and logs";
    lines.push(
      `- A question about Nouride or this system (how its memory, agents, skills, tools, config or gateways work; what is running, installed or configured) starts with a tool call (${how}), and the answer comes from what it returns. Do not write the answer first.`,
      "- What you remember about this system is out of date: your training, MEMORY.md, RECALL's summaries and past conversations all describe older versions. Use them to know where to look, never as the answer.",
    );
  }
  if (canLook) {
    // Live: an agent told the person "updated" when copying the edited workbook back to a Windows laptop had failed
    // silently — a quote in the path. The copy's exit code said nothing; reading the far side would have.
    lines.push(
      "- Before you say a change is done (a file written or copied, a cell set, a service restarted, a message sent elsewhere), read it back or check its effect: the file's size or hash on the far side, the cell's value, the service's status. If you could not check, say so.",
    );
  }
  if (has("web_search")) {
    lines.push("- A question about something new, recent or changing in the world: `web_search` first, same rule (see TOOLS).");
  }
  lines.push(
    "- Never say something exists, works, is configured or is done unless a tool showed you in this conversation. If you did not check, say so in the same sentence. A slow right answer beats a fast wrong one.",
  );
  return lines;
}
