/**
 * Which tool calls in one batch may run at the same time.
 *
 * The model already asks for several things at once — both wire formats let it emit a list of tool
 * calls in one message — and the executor ran that list strictly one at a time. The comment
 * justifying it named two costs of parallelism, and both are real: two tools writing the same file in
 * one batch is a race nobody asked for, and a serialized log reads in the order the model thought.
 *
 * But both are costs of parallelising *writes*. A `read` cannot interfere with another `read`, and
 * four `web_fetch` calls at three seconds each are twelve seconds serialized and three in parallel.
 * Being able to tell those apart is the argument for typed tools over a shell: a harness holding an
 * opaque command string cannot distinguish a `grep` from a `git push`, so it has to serialize both.
 *
 * ## The two conditions, and why the second one is not optional
 *
 * A call joins a parallel group only if:
 *
 * 1. its tool is marked `parallelSafe`, and
 * 2. the agent's `approval_required` list does not name it.
 *
 * The second looks redundant — nothing read-only should need approval — but an operator may list any
 * tool by name, and *this* caller must not stop for a human inside a group.
 * `ToolCaller.lastApprovalWaitMs` and `lastToolNotApproved` are instance fields reset at the top of
 * every `run` and read after it, so two concurrent runs through the approval path would report each
 * other's answer — and the one place that matters is the count of refused calls that decides what the
 * turn says at the end.
 *
 * With both conditions held, neither field is ever written to anything but its reset value, and
 * reading them after a group is safe.
 *
 * ## What the second condition is *not*
 *
 * It is not "nothing in this group can ever reach a human". `ask_agent` is parallel-safe and ungated,
 * and the turn it starts has an approval gate of its own — a peer can stop for somebody one level
 * down, where neither condition here can see it. That was the argument for keeping it serialized, and
 * it was the wrong place to answer it: whether two calls interfere is a question about the machine,
 * whether two questions can be answered at once is a question about the person, and only the second
 * one was ever true of `ask_agent`.
 *
 * The person is handled where the person is, in `tools/approval-floor.ts`: at most one prompt is in
 * front of a conversation at a time and the rest wait their turn. The fields above stay safe because
 * a nested turn has its own `ToolCaller` — these belong to this one, and this one never reaches the
 * approval path for a tool the second condition let through.
 *
 * ## Groups are consecutive, never reordered
 *
 * `[read, read, write, read]` runs as `[read, read]`, then `write`, then `read` — not as three reads
 * and a write. The model's ordering is information: a batch that reads a file, writes it, then reads
 * it back means to see its own change. Sorting the safe calls forward would break that quietly.
 */

import type { ToolCall } from "@nouride/shared";

/**
 * Split a batch into runs, each either one call or several that may run together.
 *
 * Single calls stay single so the common path is byte-for-byte the old behaviour: one tool call in a
 * batch is the overwhelming majority, and a `Promise.all` of one is a different code path to no
 * purpose.
 */
export function groupParallelCalls(
  calls: ToolCall[],
  canParallelise: (call: ToolCall) => boolean,
): ToolCall[][] {
  const groups: ToolCall[][] = [];

  for (const call of calls) {
    const safe = canParallelise(call);
    const last = groups.at(-1);
    // Extend the run only when this call and the one before it are both safe. `last[0]` is enough to
    // test the group, because a group is only ever built from calls that all passed.
    if (safe && last && last.length > 0 && canParallelise(last[0]!)) {
      last.push(call);
      continue;
    }
    groups.push([call]);
  }

  return groups;
}
