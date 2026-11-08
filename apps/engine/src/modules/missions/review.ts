/**
 * What a mission's reviewer is handed, and how its answer is read. It gets the goal, what it is to verify,
 * the agent's report and the result files — the report as the claim under review, never as evidence — and answers PASS,
 * or FAIL with what is missing: a reviewer that cannot say "pass" plainly has not passed it. One that ran out of its clock,
 * or answered neither — "NO VERDICT", "Not a PASS. I ran out of time" — has not judged the work (`checking.ts`): what it
 * wrote is where the next pass goes on from.
 */

import { clip } from "@nouride/shared";
import type { HelperBrief } from "@/modules/tools/builtins/delegate-brief.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import type { Review } from "./checking.ts";
import { toldBy, type Mission } from "./types.ts";

/**
 * Told words the reviewer is shown, the latest, each whole (0.8.11): the person's later word, which the work followed. Cut
 * to 500 characters, a longer instruction was judged by its first part.
 */
const TOLD_REVIEWED = 5;
/** An unfinished pass's notes, handed to the next: what it checked and what it left, which a finding's 1,500 would cut. */
const NOTES_CHARS = 6000;

export function reviewBrief(mission: Pick<Mission, "goal" | "review" | "report" | "files" | "workdir" | "checks" | "told">, earlier?: string): HelperBrief {
  // A person's words while it worked (`tell`, 0.8.10): without them, work that followed a change of direction reads as
  // work that strayed from the goal.
  const told = mission.told.slice(-TOLD_REVIEWED).map((one) => `${toldBy(one)}: "${one.text}"`);
  return {
    goal: "Review whether this mission's work is really done, and say plainly if it is not.",
    context: [
      `The mission's goal: ${mission.goal}`,
      `What to verify: ${mission.review ?? "that the goal is met, completely"}`,
      ...(told.length > 0 ? [`What a person told it while it worked (their later word, which wins over the details of the goal): judge the work against the goal with these applied.\n${told.join("\n")}`] : []),
      `The agent's report (the claim under review, not evidence): ${mission.report ?? "(none)"}`,
      `Result files: ${mission.files.length > 0 ? mission.files.join(", ") : "(none named)"}`,
      `Its folder: ${mission.workdir}`,
      mission.checks.length > 0 ? `These commands already passed: ${mission.checks.join("; ")}. They may be weaker than the goal.` : "No commands checked it.",
      ...(earlier ? [`An earlier pass of this review ran out of time before it judged the work. What it checked and found is below: take what it checked as checked, go on with what it left, then judge the whole.\n${earlier}`] : []),
    ].join("\n"),
    constraints:
      "You only check. Read the results, open the files, sample a few items rather than all of them, and change nothing: " +
      "you hold only tools that read. Be sceptical: a report that says it is done is what you are checking.",
    deliverable:
      "First line exactly PASS or FAIL. After FAIL, what is missing or wrong, item by item, in a few short lines. If you cannot " +
      "finish checking in your time, first line NO VERDICT, then what you checked and what is left: the next pass goes on from it.",
  };
}

/**
 * A review from the reviewer's hand-off. Out of its clock or its rounds (`incomplete`, `tools/handoff.ts`) — or stopped by
 * itself before the deadline with neither PASS nor FAIL first, which hands back as finished — it has not judged the work:
 * its words are notes for the next pass, never a fail. "NO VERDICT: the review ran out of time" and "Not a PASS. I ran out
 * of time before finishing" were both read as one (msn_b97876, live, 0.8.10).
 */
export function reviewOf(handoff: Pick<SubAgentHandoff, "status" | "summary">, tokens: number): Review {
  if (handoff.status === "incomplete" || !judged(handoff.summary)) return { pass: false, findings: reviewNotes(handoff.summary), tokens, unfinished: true };
  return { ...verdictOf(handoff.summary), tokens };
}

/** Its answer's first line, as a verdict is read from it: what dresses it — `**`, `#`, a full stop — off, in capitals. */
const headOf = (summary: string): string => (summary.trim().split("\n")[0] ?? "").trim().replace(/^[*#\s`]+|[*`\s.:!]+$/g, "").toUpperCase();

/** Whether its first line is a verdict: PASS, or FAIL with or without what fails after it. */
function judged(summary: string): boolean {
  const head = headOf(summary);
  return head === "PASS" || /^FAIL\b/.test(head);
}

/** What a pass that ran out of its clock wrote, for the next pass and a person: its words, clipped long. */
export function reviewNotes(summary: string): string {
  const text = summary.trim();
  return clip(text, NOTES_CHARS) || "it wrote nothing before its time ran out";
}

/** The reviewer's answer: PASS on its first line passes; anything else fails, its words the finding. */
export function verdictOf(summary: string): { pass: boolean; findings: string } {
  const text = summary.trim();
  const rest = text.split("\n").slice(1);
  const head = headOf(text);
  if (head === "PASS") return { pass: true, findings: "" };
  const findings = (head === "FAIL" ? rest.join("\n") : text).trim();
  return { pass: false, findings: findings.slice(0, 1500) || "it did not say what is missing" };
}
