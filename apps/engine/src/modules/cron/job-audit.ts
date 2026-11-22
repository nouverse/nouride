/**
 * What the audit log keeps of what a job does, when one is made or changed: every command whole. An unattended command
 * is the single most important thing to be able to read back later, and for a script the log is the only place a text
 * a change replaced is still kept.
 */

import type { CommandRuns, JobPayload, JobStep, TogetherStep } from "@nouride/shared";

/** A command: its line whole, and a script's text whole with who wrote it. */
const commandAudit = (command: Pick<CommandRuns, "argv" | "script">): Record<string, unknown> => ({
  argv: command.argv,
  ...(command.script ? { script: { text: command.script.text, about: command.script.about, by: command.script.by ?? null, secrets: command.script.secrets ?? [] } } : {}),
});

/** A step: a command whole, any other by its kind, and the same of each step it starts together. */
const stepAudit = (step: JobStep | TogetherStep): Record<string, unknown> =>
  step.kind === "command" ? { kind: step.kind, ...commandAudit(step) } : step.kind === "parallel" ? { kind: step.kind, steps: step.steps.map(stepAudit) } : { kind: step.kind };

/** What a job does: its kind, its command whole where it is one, and every step's where it is several. */
export const payloadAudit = (payload: JobPayload): Record<string, unknown> => ({
  payload_kind: payload.kind,
  ...(payload.kind === "command" ? commandAudit(payload) : {}),
  ...(payload.kind === "steps" ? { steps: payload.steps.map(stepAudit) } : {}),
});
