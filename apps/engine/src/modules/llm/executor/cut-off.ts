/**
 * What a tool call is answered with when its arguments did not arrive whole.
 *
 * Found live (2026-10-21, turn 44d1bdd4): a `write` of a long document stopped at exactly 8192 output tokens, three
 * calls in a row. Each was answered "not valid JSON — send the call again", so the model sent the same oversized call
 * again, and then an `exec` with no arguments at all. The reply had been cut at the output limit, and nothing said so.
 * When it was (`ChatResponse.cutAtLimit`), the answer says that, and the way out: send big content in parts.
 */

import { redact } from "@nouride/secrets";
import type { ToolCall, ToolResult } from "@nouride/shared";

/** The one way out, said the same in both answers below — and in the prompt (`prompt/sections`). */
const IN_PARTS =
  "Do not send the same call again: it would be cut off the same way. Send big content in parts (`write` the first part, " +
  "then `write` with `append: true` for each next one), or split the work into several smaller calls.";

/** How much of what arrived goes into the turn's record: enough to see what the call was, never the whole file. */
const RECORDED_CHARS = 2048;

/** A call that parsed, as nothing — what a cut left of an `exec` (2026-10-21). One with arguments is not touched. */
export function arrivedEmpty(call: ToolCall): boolean {
  return call.argumentsError === undefined && Object.keys(call.arguments).length === 0;
}

/** Arguments that are not one JSON object, answered — and recorded, so the failure can be read afterwards. */
export function malformedArguments(call: ToolCall & { argumentsError: NonNullable<ToolCall["argumentsError"]> }, cutAt?: number): ToolResult {
  const { raw, reason } = call.argumentsError;
  const content =
    cutAt === undefined
      ? `The arguments for ${call.name} were ${reason}. Send the call again with its arguments as one JSON object. What arrived: ${raw.slice(0, 300)}`
      : `Your reply was cut off at the output limit of ${cutAt} tokens, so this ${call.name} call arrived incomplete ` +
        `(its arguments were ${reason}) and did not run. ${IN_PARTS}`;
  return {
    content,
    isError: true,
    // `args` as `{}` was all the record said about such a call. What arrived, capped and redacted like any argument.
    metadata: { audit: { callId: call.id, tool: call.name, args: { unparsed: redact(raw.slice(0, RECORDED_CHARS)).text }, error: true, ms: 0 } },
  };
}

/** A call that ran with nothing — an empty `exec` — and failed: its own error, then why it was empty. */
export function withCutNote(result: ToolResult, cutAt: number): ToolResult {
  return {
    ...result,
    content: `${result.content}\n\nYour reply was cut off at the output limit of ${cutAt} tokens, so this call arrived without its arguments. ${IN_PARTS}`,
  };
}
