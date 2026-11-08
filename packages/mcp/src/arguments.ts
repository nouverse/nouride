/**
 * A model's arguments, held to the schema the server declared, before anything is sent.
 *
 * Two rules and no more: every name in `required` is there, and each declared property that was sent has the top-level
 * `type` it declares — `string`, `number`, `integer`, `boolean`, `array`, `object`, `null`, or a list of them. No `$ref`,
 * `anyOf`, `oneOf`, formats, enums, ranges or nested schemas: a schema that uses them still reaches the model as written
 * and its server still judges the call. This catches what a model gets wrong most and a server answers least usefully —
 * a field left out, a number sent as a string, one value where a list was asked for — and says each one, so the next
 * call can be right instead of a JSON-RPC error the model cannot act on.
 *
 * A type this does not know (a typo, an extension) is not checked: refusing what it cannot read would turn a working
 * tool into one that never runs.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON Schema types, with what each one is called in a sentence. */
const TYPES: Record<string, string> = {
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  array: "an array",
  object: "an object",
  null: "null",
};

/** What is wrong with `args` against `schema`, one sentence each — none when they are worth sending. */
export function argumentProblems(schema: unknown, args: Json): string[] {
  if (!isObject(schema)) return [];
  const problems: string[] = [];

  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  for (const name of required) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) problems.push(`"${name}" is required`);
  }

  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const [name, value] of Object.entries(args)) {
    const declared = properties[name];
    if (!isObject(declared) || value === undefined) continue;
    const types = typesOf(declared.type);
    if (types.length === 0 || types.some((type) => matches(type, value))) continue;
    problems.push(`"${name}" must be ${types.map((type) => TYPES[type]).join(" or ")}, not ${described(value)}`);
  }
  return problems;
}

/** The declared type as a list — empty when it is absent or names anything this does not know. */
function typesOf(type: unknown): string[] {
  const listed: unknown[] = Array.isArray(type) ? type : [type];
  return listed.length > 0 && listed.every((entry) => typeof entry === "string" && Object.hasOwn(TYPES, entry)) ? (listed as string[]) : [];
}

function matches(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return value === null;
  }
}

/** What was sent instead, in the sentence: its kind, or the value itself when that is short and says more. */
function described(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return "a string";
  return String(value);
}
