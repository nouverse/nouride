/**
 * What a person is told after pressing Run on a job or Test on a webhook: the daemon's answer, as one toast.
 *
 * Both pages ignored it. A refused "that job is already running" came back as HTTP 200 and read exactly like success,
 * and a run that went well said nothing either.
 */

import type { ToastRequest } from "@/commons/components/ui/toast";
import type { RunNowOutcome } from "./api";

/** A reply or a command's output can be pages long; a toast carries the start of it. */
const DETAIL_CHARS = 240;

function clip(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS).trimEnd()}…` : text;
}

export function runOutcomeToast(name: string, outcome: RunNowOutcome): ToastRequest {
  const detail = clip(outcome.result);
  const said = (request: ToastRequest): ToastRequest => (detail ? { ...request, detail } : request);
  switch (outcome.status) {
    case "success":
      return said({ kind: "success", message: `${name} ran` });
    case "running":
      return {
        kind: "info",
        message: `${name} is still running`,
        detail: "How it ends will show in its runs.",
      };
    case "skipped":
      return said({ kind: "info", message: `${name} skipped this run` });
    case "interrupted":
      return said({ kind: "warning", message: `${name} was cut off by a restart` });
    case "unavailable":
      return said({ kind: "warning", message: `${name} did not start` });
    case "error":
      return said({ kind: "error", message: `${name} failed` });
  }
}
