
/**
 * What the agent is doing right now, as one line per thing — what a turn's executor says as it works.
 *
 * Observed while writing the CLI walkthrough: a turn that ran 21 seconds showed **nothing** — blank
 * screen, then a finished answer. The daemon knew it was reading a file, calling a provider and waiting
 * on a tool; none of it reached the person who asked. A long silence is indistinguishable from a hang.
 *
 * Each line goes to the turn's record (`turns/recorder.ts`): a step of the event stream, or — `thinking`
 * — a frame said to whoever is watching and kept nowhere. Until 0.7.11 it went to an in-memory window
 * of sixty lines per chat as well, with a counter of its own, which `nouride chat` polled; the stream
 * replaced it.
 */

import { elide, type ExecutorStepKind } from "@nouride/shared";

/**
 * What the executor says, by kind: `thinking` — waiting on the provider, a frame and never a step — and the step kinds
 * a turn's own work writes (`EXECUTOR_STEP_KINDS`). One list, in `@nouride/shared`, where each kind's meaning is its
 * comment in `EVENT_CONTRACT`; a map that draws them is `satisfies Record<ActivityKind, …>`, so a kind added there and
 * drawn nowhere does not compile. It was its own union here, beside seven other copies.
 */
export type ActivityKind = "thinking" | ExecutorStepKind;

/** What one tool call's arguments get, before the tool's own name is put in front; `elide` keeps both of its ends. */
const DETAIL_MAX = 120;

/**
 * A tool call as one readable line.
 *
 * Shaped like a terminal would show it — `exec bun test`, not `exec {"command":["bun","test"]}`. Someone
 * watching wants to recognise the action at a glance, and the audit log already has the full arguments
 * for when they want precision instead.
 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const summary = (): string => {
    if (Array.isArray(args.command)) return args.command.map(String).join(" ");
    if (typeof args.command === "string") return args.command;
    // The `nouride` tool's shape. Without this the step read `nouride {"args":["config","schema"]}`
    // — the raw JSON the fallback produces — in the one place a reader is skimming for what happened.
    if (Array.isArray(args.args)) return args.args.map(String).join(" ");
    /**
     * A batched `read`. Basenames, because the point of the line is *which* files, not where they live.
     *
     * The first live batch read four files and the step said `read {"paths":["/opt/projects/core/RE…` —
     * the JSON fallback, truncated mid-path. The parameter that makes turns cheap should not make the
     * step log unreadable, or the next person to look at a slow turn cannot see what it did.
     */
    // Several grep patterns read as one line: `grep error, timeout, refused`.
    if (Array.isArray(args.patterns)) return elide(args.patterns.map(String).join(", "), DETAIL_MAX);
    // A batched `web_search`: the queries themselves, which are what a reader skims for.
    if (Array.isArray(args.queries)) return elide(args.queries.map(String).join(" · "), DETAIL_MAX);
    // A batched `web_fetch`: the hosts, which is what says whose pages were read. The JSON fallback
    // cut this off after the first URL, so a two-page batch read like a one-page fetch.
    if (Array.isArray(args.urls)) {
      const hosts = args.urls.map((entry) => {
        try {
          return new URL(String(entry)).host;
        } catch {
          return String(entry);
        }
      });
      return `${hosts.length} pages: ${hosts.join(", ")}`;
    }
    if (Array.isArray(args.paths)) {
      const names = args.paths.map((entry) => String(entry).split("/").pop() || String(entry));
      const shown = names.slice(0, 4).join(", ");
      return names.length > 4 ? `${shown} +${names.length - 4} more` : shown;
    }
    // A plan, as where it stands: "step 3 of 8: check documents 31–52" is what a person waiting on the work wants to
    // know, and the JSON of eight steps said nothing (0.7.26).
    if (Array.isArray(args.steps)) return stepsSaid(args.steps);
    // `notes`: what was done to which task.
    if (typeof args.action === "string" && typeof args.title === "string") return `${args.action} "${args.title}"`;
    if (typeof args.path === "string") return args.path;
    if (typeof args.pattern === "string") return args.pattern;
    if (typeof args.url === "string") return args.url;
    if (typeof args.query === "string") return args.query;
    // Nothing recognisable: compact JSON rather than nothing, so an unfamiliar tool is still legible.
    const json = JSON.stringify(args);
    return json === "{}" ? "" : json;
  };

  const detail = summary();
  return detail ? `${name} ${elide(detail, DETAIL_MAX)}` : name;
}

/** Where a plan stands, from the steps a call sent: the active one, else how many are done. */
function stepsSaid(steps: unknown[]): string {
  const read = steps.map((step) =>
    typeof step === "string" ? { text: step, state: "pending" } : { text: String((step as { text?: unknown })?.text ?? ""), state: String((step as { state?: unknown })?.state ?? "pending") },
  );
  if (read.length === 0) return "cleared";
  const at = read.findIndex((step) => step.state === "active");
  if (at >= 0) return `step ${at + 1} of ${read.length}: ${read[at]!.text}`;
  const done = read.filter((step) => step.state === "done" || step.state === "skipped").length;
  return `${done} of ${read.length} steps done`;
}

/**
 * How a call ended, as a reader decides on it (`tool_done.outcome`): a command that answered with a non-zero exit is
 * an answer — `which` saying no — where a refusal, a throw, a timeout or a kill is the call not doing its job. The
 * dashboard read this off the line's words, and a reworded line would have turned a red row green.
 */
export function toolOutcome(result: { isError: boolean; metadata?: Record<string, unknown> | undefined }): "ok" | "exit" | "failed" | "timed_out" | "killed" {
  if (!result.isError) return "ok";
  if (result.metadata?.timedOut === true) return "timed_out";
  if (result.metadata?.aborted === true) return "killed";
  const code = result.metadata?.exitCode;
  return typeof code === "number" && code !== 0 ? "exit" : "failed";
}

/**
 * How a tool call went, in two or three words.
 *
 * `ok` alone was misleading in a way that cost real debugging time: a `glob` that matched nothing
 * reported `glob ok`, so a search that had found nothing looked like a search that had worked. The
 * operator concluded the agent was confused when in fact its workspace root did not exist.
 *
 * A tool that reports a count in its metadata gets it shown. Everything else keeps `ok`, because
 * inventing a number would be worse than not having one.
 *
 * ## Why `failed` is not the word for a non-zero exit
 *
 * The same misreading as `glob ok`, in the other direction. An operator watching a turn saw
 *
 *     exec which chromium chromium-browser google-chrome
 *     exec failed · 3ms
 *
 * and asked what had broken. Nothing had. `which` exits 1 when it finds nothing, so that pair is the
 * agent asking "is a browser installed here?" and being told no — the command did exactly its job.
 * Three of the four "failures" on that screen were `which` probes and the fourth was an
 * `import playwright` check; the turn went on to succeed through another route.
 *
 * So a command that *ran* reports its exit code, which is the fact, and reads correctly to anybody:
 * `exit 1` is an answer, `failed` is an accusation. The word is kept for the cases where it is true —
 * a tool that was refused, threw, or never ran at all.
 */
export function describeToolResult(result: {
  isError: boolean;
  metadata?: Record<string, unknown> | undefined;
}): string {
  if (result.isError) {
    // Ordered by what the reader most needs to know. A killed command has an exit code too, and
    // reporting `exit 143` for a timeout would send somebody looking for the signal's meaning.
    if (result.metadata?.timedOut === true) return "timed out";
    if (result.metadata?.aborted === true) return "killed";
    const code = result.metadata?.exitCode;
    if (typeof code === "number" && code !== 0) return `exit ${code}`;
    return "failed";
  }

  // A batch of pages: how many came back, and the slowest one — set against the call's own duration,
  // which follows this, it shows whether they ran together (about equal) or one after another.
  const pages = result.metadata?.pages;
  if (typeof pages === "number") {
    const failed = typeof result.metadata?.failed === "number" ? result.metadata.failed : 0;
    const slowest = result.metadata?.slowestMs;
    return `${pages - failed}/${pages} pages${typeof slowest === "number" ? ` · slowest ${slowest}ms` : ""}`;
  }

  const count = result.metadata?.count ?? result.metadata?.matches;
  if (typeof count === "number") return count === 0 ? "no matches" : `${count} found`;

  return "ok";
}
