/**
 * A tool call's arguments as the model sent them, read the same way for every wire format. Models do send JSON that
 * does not parse — a call cut off, two calls run together — and arguments that parse as something other than an
 * object. Neither aborts the turn: the call carries `argumentsError` (`ToolCall`, `@nouride/shared`), and the engine
 * answers it with what went wrong instead of running the tool, so the model can send it again. These were magic
 * `_malformed` keys nothing read: the tool said a field was missing, and the model retried the same call to the cap.
 */

import type { ToolCall } from "@nouride/shared";

/**
 * How much of an unreadable argument string is kept on the call. It is stored with the conversation, and what it is for
 * is reading afterwards what the call was — a cut-off `write` carried a whole document, 30KB of it, kept in every save.
 */
const KEPT_RAW = 2048;

export function toolArguments(raw: string): Pick<ToolCall, "arguments" | "argumentsError"> {
  if (!raw.trim()) return { arguments: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { arguments: {}, argumentsError: { raw: raw.slice(0, KEPT_RAW), reason: `not valid JSON (${err instanceof Error ? err.message : String(err)})` } };
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { arguments: parsed as Record<string, unknown> };
  return { arguments: {}, argumentsError: { raw: raw.slice(0, KEPT_RAW), reason: `a JSON ${Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed}, not an object` } };
}
