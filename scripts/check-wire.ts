#!/usr/bin/env bun
/**
 * The dashboard's hand-kept copies of the daemon's word lists, held to the originals.
 *
 * The dashboard may not import `@nouride/shared` or the engine (ARCHITECTURE §3; `check-arch.ts`), so every payload it
 * reads is declared again in `apps/dashboard/src/commons/lib/api*.ts` — the kinds of a chat event, a turn's statuses,
 * the retention scopes, a draft's triggers. A value added on one side and not the other fails nowhere: the page draws
 * a blank pill or a 🔧 for a kind it has never heard of, or sends a value the daemon refuses. This compares each copy
 * with the list it copies, read from both sources as TypeScript, and fails on any difference.
 *
 * Tooling may read both trees; nothing here ends up in either bundle.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");

/**
 * Where a list is written: a type alias — or the `discriminant` of each object in one, `kind` of a tagged union — an
 * interface's property, a const array, a const object's keys, or a path into one.
 */
type Source =
  | { file: string; type: string; discriminant?: string }
  | { file: string; interface: string; property: string }
  | { file: string; array: string }
  | { file: string; keys: string }
  | { file: string; path: [string, ...string[]] };

interface Pair {
  what: string;
  dashboard: Source;
  daemon: Source;
}

const LIB = "apps/dashboard/src/commons/lib";
// The types a module of calls declares live in it (`api.cron.ts`'s jobs, say); the rest are in `api.ts`.
const API = `${LIB}/api.ts`;

export const PAIRS: Pair[] = [
  { what: "a turn step's kind", dashboard: { file: API, interface: "TurnStep", property: "kind" }, daemon: { file: "packages/shared/src/types/events.ts", array: "TURN_STEP_KINDS" } },
  {
    what: "how a call ended",
    dashboard: { file: API, interface: "TurnStep", property: "outcome" },
    daemon: { file: "packages/shared/src/types/events.ts", path: ["EVENT_CONTRACT", "kinds", "tool_done", "outcome", "values"] },
  },
  { what: "a turn's status", dashboard: { file: API, type: "TurnStatus" }, daemon: { file: "apps/engine/src/modules/turns/turns.store.ts", type: "TurnStatus" } },
  { what: "whether a mission's tokens are known", dashboard: { file: `${LIB}/api.missions.ts`, type: "MissionTokens" }, daemon: { file: "apps/engine/src/modules/missions/page.ts", type: "MissionTokens" } },
  { what: "a chat event's kind", dashboard: { file: API, interface: "ChatEvent", property: "kind" }, daemon: { file: "apps/engine/src/modules/chat-events/chat-events.store.ts", type: "EventKind" } },
  { what: "a retention scope", dashboard: { file: `${LIB}/api.logs.ts`, type: "RetentionScope" }, daemon: { file: "apps/engine/src/modules/config/settings/memory.ts", keys: "RETENTION_SCOPES" } },
  { what: "a model tier", dashboard: { file: `${LIB}/api.tiers.ts`, type: "ModelTier" }, daemon: { file: "packages/shared/src/types/tiers.ts", array: "MODEL_TIERS" } },
  { what: "an effort level", dashboard: { file: `${LIB}/api.agents.ts`, array: "EFFORT_LEVELS" }, daemon: { file: "packages/shared/src/types/llm.ts", array: "LLM_EFFORTS" } },
  { what: "where a coding CLI's version stands", dashboard: { file: `${LIB}/api.external-agents.ts`, type: "CliStanding" }, daemon: { file: "packages/acp/src/versions.ts", type: "CliStanding" } },
  { what: "the skill learning mode", dashboard: { file: `${LIB}/api.skills.ts`, type: "LearningMode" }, daemon: { file: "packages/shared/src/types/config.ts", type: "SkillLearningMode" } },
  { what: "an approval's answer", dashboard: { file: API, type: "ApprovalDecision" }, daemon: { file: "packages/shared/src/types/config.ts", type: "ApprovalDecision" } },
  { what: "a skill draft's trigger", dashboard: { file: `${LIB}/api.skills.ts`, interface: "SkillDraft", property: "triggerKind" }, daemon: { file: "apps/engine/src/modules/reflection/types.ts", type: "TriggerKind" } },
  { what: "an MCP server's transport", dashboard: { file: API, interface: "McpServer", property: "transport" }, daemon: { file: "packages/shared/src/types/agent.ts", interface: "McpServerConfig", property: "transport" } },
  ...(["fur", "pattern", "outfit", "outfitColor", "hat", "accessory", "eyes"] as const).map((part) => ({
    what: `a look's ${part}`,
    dashboard: { file: `${LIB}/api.look.ts`, path: ["LOOK_PARTS", part, "values"] as [string, ...string[]] },
    daemon: { file: "packages/shared/src/types/look.ts", path: ["LOOK_PARTS", part, "values"] as [string, ...string[]] },
  })),
  { what: "a user's role", dashboard: { file: API, interface: "User", property: "role" }, daemon: { file: "apps/engine/src/modules/users/users.store.ts", type: "UserRole" } },
  {
    what: "what a helper model's trouble was in",
    dashboard: { file: `${LIB}/api.memory.ts`, interface: "HelperTrouble", property: "job" },
    daemon: { file: "apps/engine/src/modules/llm/helper-trouble.ts", interface: "HelperTrouble", property: "job" },
  },
  {
    what: "what a job does",
    dashboard: { file: `${LIB}/api.cron.ts`, type: "JobPayloadInput", discriminant: "kind" },
    daemon: { file: "packages/shared/src/types/cron.ts", type: "JobPayload", discriminant: "kind" },
  },
  { what: "where a job's output goes", dashboard: { file: `${LIB}/api.cron.ts`, type: "JobDeliveryMode" }, daemon: { file: "packages/shared/src/types/cron.ts", type: "CronDeliveryMode" } },
  { what: "a job's history", dashboard: { file: `${LIB}/api.cron.ts`, interface: "JobSummary", property: "session" }, daemon: { file: "packages/shared/src/types/cron.ts", type: "JobSessionMode" } },
  {
    what: "why a model call ended",
    dashboard: { file: `${LIB}/api.turns.ts`, interface: "TurnModelCall", property: "stopReason" },
    daemon: { file: "packages/shared/src/types/llm.ts", type: "StopReason" },
  },
  {
    what: "a kept plan's step state",
    dashboard: { file: `${LIB}/api.notes.ts`, interface: "NotesPlanStep", property: "state" },
    daemon: { file: "apps/engine/src/modules/notes/store.ts", type: "StepState" },
  },
  { what: "a mission's status", dashboard: { file: `${LIB}/api.missions.ts`, type: "MissionStatus" }, daemon: { file: "apps/engine/src/modules/missions/types.ts", type: "MissionStatus" } },
  { what: "why a mission waits", dashboard: { file: `${LIB}/api.missions.ts`, type: "MissionWaitKind" }, daemon: { file: "apps/engine/src/modules/missions/types.ts", type: "WaitKind" } },
  { what: "what a person sees a mission as", dashboard: { file: `${LIB}/api.missions.ts`, type: "MissionSeen" }, daemon: { file: "apps/engine/src/modules/missions/types.ts", type: "SeenAs" } },
  {
    what: "how a job that woke a turn ended",
    dashboard: { file: API, interface: "TurnCause", property: "outcome" },
    daemon: { file: "apps/engine/src/modules/turns/turns.store.ts", interface: "TurnCause", property: "outcome" },
  },
];

const parsed = new Map<string, ts.SourceFile>();
function sourceOf(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, source);
  }
  return source;
}

/** The string literals of a type: a union of them, an alias of one, a reference to an alias in the same file. */
function literalsOfType(node: ts.TypeNode, source: ts.SourceFile): string[] {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text];
  if (ts.isUnionTypeNode(node)) return node.types.flatMap((type) => literalsOfType(type, source));
  if (ts.isParenthesizedTypeNode(node)) return literalsOfType(node.type, source);
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const alias = find(source, (child): child is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(child) && child.name.text === (node.typeName as ts.Identifier).text);
    if (alias) return literalsOfType(alias.type, source);
  }
  throw new Error(`${source.fileName}: a type this cannot read as a list of words — ${node.getText(source).slice(0, 80)}`);
}

/** The `key` of each object in a union — the tags of a tagged union. */
function discriminantsOf(node: ts.TypeNode, key: string, source: ts.SourceFile): string[] {
  if (ts.isUnionTypeNode(node)) return node.types.flatMap((type) => discriminantsOf(type, key, source));
  if (ts.isParenthesizedTypeNode(node)) return discriminantsOf(node.type, key, source);
  if (ts.isTypeLiteralNode(node)) {
    const member = node.members.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && propertyName(m.name) === key);
    if (member?.type) return literalsOfType(member.type, source);
  }
  throw new Error(`${source.fileName}: a member this cannot read a "${key}" from — ${node.getText(source).slice(0, 80)}`);
}

function find<T extends ts.Node>(source: ts.SourceFile, test: (node: ts.Node) => node is T): T | undefined {
  let found: T | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (test(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A const's initializer, past `as const` and `satisfies`. */
function initializerOf(source: ts.SourceFile, name: string): ts.Expression {
  const declaration = find(source, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  let value = declaration?.initializer;
  while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
  if (!value) throw new Error(`${source.fileName}: no const ${name}`);
  return value;
}

function stringsOf(node: ts.Expression, where: string): string[] {
  let value = node;
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
  if (!ts.isArrayLiteralExpression(value)) throw new Error(`${where}: not a list`);
  return value.elements.map((element) => {
    if (!ts.isStringLiteral(element)) throw new Error(`${where}: an element that is not a word`);
    return element.text;
  });
}

function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();
}

export function wordsOf(where: Source): string[] {
  const source = sourceOf(where.file);
  if ("type" in where) {
    const alias = find(source, (node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === where.type);
    if (!alias) throw new Error(`${where.file}: no type ${where.type}`);
    return where.discriminant ? discriminantsOf(alias.type, where.discriminant, source) : literalsOfType(alias.type, source);
  }
  if ("interface" in where) {
    const declaration = find(source, (node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === where.interface);
    const member = declaration?.members.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && propertyName(m.name) === where.property);
    if (!member?.type) throw new Error(`${where.file}: no ${where.interface}.${where.property}`);
    return literalsOfType(member.type, source);
  }
  if ("array" in where) return stringsOf(initializerOf(source, where.array), `${where.file} ${where.array}`);
  if ("keys" in where) {
    const value = initializerOf(source, where.keys);
    if (!ts.isObjectLiteralExpression(value)) throw new Error(`${where.file}: ${where.keys} is not an object`);
    return value.properties.map((property) => (property.name ? propertyName(property.name) : "")).filter(Boolean);
  }
  const [name, ...steps] = where.path;
  let value: ts.Expression = initializerOf(source, name);
  for (const step of steps) {
    while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
    if (!ts.isObjectLiteralExpression(value)) throw new Error(`${where.file}: ${where.path.join(".")} stops being an object at ${step}`);
    const next = value.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propertyName(p.name) === step);
    if (!next) throw new Error(`${where.file}: no ${where.path.join(".")}`);
    value = next.initializer;
  }
  return stringsOf(value, `${where.file} ${where.path.join(".")}`);
}

/** Each pair whose two lists differ, with what one has and the other does not. */
export function drift(pairs: readonly Pair[] = PAIRS): string[] {
  const problems: string[] = [];
  for (const pair of pairs) {
    const ours = new Set(wordsOf(pair.dashboard));
    const theirs = new Set(wordsOf(pair.daemon));
    const missing = [...theirs].filter((word) => !ours.has(word));
    const extra = [...ours].filter((word) => !theirs.has(word));
    if (missing.length || extra.length) {
      problems.push(
        `${pair.what}: the dashboard's copy in ${pair.dashboard.file}` +
          (missing.length ? ` lacks ${missing.map((w) => `"${w}"`).join(", ")}` : "") +
          (missing.length && extra.length ? " and" : "") +
          (extra.length ? ` has ${extra.map((w) => `"${w}"`).join(", ")}, which the daemon does not` : "") +
          ` (${pair.daemon.file})`,
      );
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = drift();
  if (problems.length > 0) {
    console.error(`✗ ${problems.length} hand-kept list(s) out of step with the daemon:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`✓ the dashboard's ${PAIRS.length} copied word lists match the daemon's`);
}
