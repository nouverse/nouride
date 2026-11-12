/**
 * The skill tools, sent to a model as one.
 *
 * Every tool an agent holds is sent whole with every request of every step. The six that manage its skills weigh about
 * a seventh of all the built-in schemas together, and on a month of a live install (13,823 tool calls) they were
 * called once. So a model is sent one entry, `skill`, that names what each does in a line; called with an `action`
 * alone it answers with that action's own description and arguments, and called again with them it is that tool's
 * call.
 *
 * Only what the model is sent changes. The tools keep their names everywhere a name is read: a pack's `[tools]`, a
 * standing grant, an approval, the audit log, a turn's steps. The call is given its tool's name back before anything
 * runs (`unfoldCall`), and one made by the old name still runs.
 */

import type { ToolCall, ToolDefinition, ToolResult } from "@nouride/shared";

/** The entry's name. */
const SKILL_ENTRY = "skill";

/** Each action of the entry, and the tool it is. In the order a person meets them. */
const ACTIONS: readonly (readonly [string, string])[] = [
  ["create", "skill_create"],
  ["improve", "skill_improve"],
  ["toggle", "skill_toggle"],
  ["search", "skill_search"],
  ["install", "skill_install"],
  ["root", "skill_root"],
];

/** One tool behind an entry costs a round trip and saves little: from two up. */
const FOLD_FROM = 2;

const heldActions = (names: readonly string[]) => ACTIONS.filter(([, tool]) => names.includes(tool));

/** Whether these tools are sent as the one entry. */
function folds(names: readonly string[]): boolean {
  return heldActions(names).length >= FOLD_FROM && !names.includes(SKILL_ENTRY);
}

/**
 * How a tool is called as the model is sent it: its own name, or the entry and its action where it is one of the
 * folded ones. For every sentence that tells a model which tool to reach for.
 */
export function asCalled(name: string, names: readonly string[]): string {
  const action = folds(names) && names.includes(name) ? ACTIONS.find(([, tool]) => tool === name)?.[0] : undefined;
  return action ? `${SKILL_ENTRY}\` with action \`${action}` : name;
}

/** A tool's own words with the other folded tools named as the model can call them. */
function inWords(text: string, names: readonly string[]): string {
  return text.replace(/\bskill_(create|improve|toggle|search|install|root)\b/g, (whole, action: string) => (names.includes(whole) ? `\`${SKILL_ENTRY}\` (action \`${action}\`)` : whole));
}

const firstSentence = (text: string): string => text.split(/(?<=\.)\s/)[0] ?? text;

/**
 * What one of the folded tools answered, with the other folded tools named as the model can call them: "write one with
 * skill_create" names a tool it was not sent. Only those tools' own answers: a file an agent reads keeps its words.
 */
export function inFoldedWords(tool: string, text: string, names: readonly string[]): string {
  return folds(names) && ACTIONS.some(([, name]) => name === tool) ? inWords(text, names) : text;
}

/** What a provider is sent for these tools: the same list, the skill tools as the one entry where they fold. */
export function foldDefinitions(definitions: ToolDefinition[]): ToolDefinition[] {
  const names = definitions.map((definition) => definition.name);
  if (!folds(names)) return definitions;
  const actions = heldActions(names);
  const of = (tool: string) => definitions.find((definition) => definition.name === tool)!;
  const entry: ToolDefinition = {
    name: SKILL_ENTRY,
    description: [
      "Your skills, in one tool. Call it with `action` alone to read what that action takes, then again with its `args`.",
      ...actions.map(([action, tool]) => `- ${action}: ${inWords(firstSentence(of(tool).description), names)}`),
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions.map(([action]) => action) },
        args: { type: "object", description: "That action's arguments. Leave it out the first time: the answer says what they are." },
      },
      required: ["action"],
    },
  };
  const held = new Set(actions.map(([, tool]) => tool));
  return [...definitions.filter((definition) => !held.has(definition.name)), entry].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The entry's call as the call of the tool it names, where it carries that tool's arguments: under `args`, or beside
 * `action` as a model that skipped the nesting writes them. Any other call is handed back as it is.
 */
export function unfoldCall(call: ToolCall, names: readonly string[]): ToolCall {
  if (call.name !== SKILL_ENTRY || !folds(names)) return call;
  const { action, args, ...beside } = call.arguments;
  const tool = heldActions(names).find(([name]) => name === action)?.[1];
  if (!tool) return call;
  const nested = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
  if (!nested && Object.keys(beside).length === 0) return call;
  return { ...call, name: tool, arguments: nested ?? beside };
}

/**
 * The entry called with an action alone: that action's description and arguments, as its own tool states them. Null
 * for any other call, which is some tool's to answer.
 */
export function openFolded(call: ToolCall, definitions: ToolDefinition[]): ToolResult | null {
  const names = definitions.map((definition) => definition.name);
  if (call.name !== SKILL_ENTRY || !folds(names)) return null;
  const actions = heldActions(names);
  // Arguments that were not one JSON object: said as that, where "takes an action" would send the same call back.
  if (call.argumentsError) {
    return { content: `The arguments of \`${SKILL_ENTRY}\` were not one JSON object (${call.argumentsError.reason}). Send \`action\`, one of ${actions.map(([name]) => name).join(", ")}, and \`args\` as an object.`, isError: true };
  }
  const tool = actions.find(([name]) => name === call.arguments.action)?.[1];
  if (!tool) {
    return { content: `\`${SKILL_ENTRY}\` takes an \`action\`, one of: ${actions.map(([name]) => name).join(", ")}. Call it with the action alone to read what it takes.`, isError: true };
  }
  const definition = definitions.find((one) => one.name === tool)!;
  return {
    content: [
      `\`${SKILL_ENTRY}\` with action \`${String(call.arguments.action)}\`. Nothing was done yet: call it again with \`args\`.`,
      "",
      inWords(definition.description, names),
      "",
      "`args`:",
      inWords(JSON.stringify(definition.parameters), names),
    ].join("\n"),
    isError: false,
  };
}
