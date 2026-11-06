/**
 * A tool call's arguments, as its schema declares them.
 *
 * Some models send an array parameter as the **JSON text** of the array: `exec` received
 * `{"command": "[\"pwd\"]"}` instead of `{"command": ["pwd"]}`. The string reached `normalizeCommand`,
 * which read its brackets and quotes as shell syntax and refused it with "ask for a shell explicitly:
 * ["bash", "-lc", "[\"pwd\"]"]" — and the model, following that advice with the same encoding, got the
 * same refusal forever. Every `exec` on that install failed, `pwd` included, with no config change:
 * it is the model that changed. `nouride` (`args`) had the same hole and failed the same way.
 *
 * Undone here, once, for every tool, rather than in each one: only where the schema says `array`,
 * only for a string that parses as a JSON array. Anything else is left as sent for the tool to judge —
 * `[ -f x ]` is a shell test, not JSON, and does not parse.
 *
 * And the same slip in the other scalar shapes, since 0.7.13 holds an MCP call to its schema before it is sent (G4):
 * a number sent as its digits (`"5"` for an integer), a boolean as its word (`"true"`), an object as its JSON text. A
 * lenient server took each and went on, and refused locally each would cost the turn a round trip to fix a value
 * nobody doubts. Only where the schema declares exactly that one type, and only when the text is unambiguous — a
 * plain decimal, one of the two words, a JSON object — so `"1e5"`, `"yes"` or a sentence still reach the check, which
 * says what is wrong.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coerceArguments(args: Json, parameters: unknown): Json {
  const properties = isObject(parameters) && isObject(parameters.properties) ? parameters.properties : null;
  if (!properties) return args;

  let coerced: Json | null = null;
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (typeof value !== "string" || !isObject(schema) || typeof schema.type !== "string") continue;
    const parsed = fromText(value.trim(), schema.type);
    if (parsed === undefined) continue;
    coerced ??= { ...args };
    coerced[key] = parsed;
  }
  return coerced ?? args;
}

/** What `text` unambiguously is as `type`, or `undefined` to leave it as sent. */
function fromText(text: string, type: string): unknown {
  switch (type) {
    case "array":
    case "object": {
      if (!text.startsWith(type === "array" ? "[" : "{")) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return undefined;
      }
      return (type === "array" ? Array.isArray(parsed) : isObject(parsed)) ? parsed : undefined;
    }
    case "number":
      return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : undefined;
    case "integer":
      return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
    case "boolean": {
      const word = text.toLowerCase();
      return word === "true" ? true : word === "false" ? false : undefined;
    }
    default:
      return undefined;
  }
}
