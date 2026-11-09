/**
 * A skill written for any agent, turned into one Nouride can hold — the "auto adjust".
 *
 * The open format (agentskills.io) and Nouride's agree on the shape: a directory, a `SKILL.md`
 * with frontmatter, files beside it. They differ in three places, and this closes each:
 *
 * - **Frontmatter is YAML** out there and `key: value` lines here (TD-014). Parsed as YAML,
 *   flattened, and written back in Nouride's form — a folded `description: >` survives as one line.
 * - **`allowed-tools`** names Claude Code's tools (`Bash`, `Read`, `WebFetch`). Mapped to the tools
 *   Nouride has (`exec`, `read`, `web_fetch`) and written as `needs_tools`, which is what gates a
 *   skill to an agent that can actually do it. A name with no counterpart is dropped and said so.
 * - **`requires`** (host software) is Nouride's own idea. Taken from the skill when it says
 *   (`requires`, or ClawHub's `metadata.openclaw.requires.bins`), and otherwise inferred from what
 *   its scripts are written in — and the inference is listed for the reviewer, not hidden.
 *
 * Files that cannot be held are left out and listed: binaries (support files are text), paths the
 * installed-skill rule refuses, anything over the size caps. Nothing is silently dropped.
 */

import { parseYaml } from "@nouride/runtime";
import { VALID_INSTALLED_PATH, VALID_SKILL_NAME } from "@nouride/persona";
import { clip, oneLine, plural } from "@nouride/shared";
import type { FetchedSkill } from "./sources.ts";

export interface InstallCandidate {
  name: string;
  description: string;
  requires: string;
  needsTools: string;
  body: string;
  files: { path: string; content: string }[];
  /** What was changed or left out, in sentences — shown with the draft. */
  notes: string[];
}

const MAX_SKILL_MD = 256_000;
const MAX_FILE = 512_000;
const MAX_TOTAL = 3_000_000;
const MAX_DESCRIPTION = 1024;

/** Claude Code's tool names, and the Nouride tool each one is. */
const TOOL_MAP: Record<string, string> = {
  bash: "exec",
  shell: "exec",
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "multi_edit",
  glob: "glob",
  grep: "grep",
  ls: "glob",
  webfetch: "web_fetch",
  websearch: "web_search",
  task: "delegate",
  todowrite: "plan",
};
/** Already Nouride's names, accepted as they are. */
const NOURIDE_TOOLS = new Set(["exec", "read", "write", "edit", "multi_edit", "glob", "grep", "web_fetch", "web_search", "delegate", "plan", "send_file", "attachment_read", "memory_search", "memory_read", "memory_write"]);

/** What a script's extension or shebang says it needs on the host. */
const INTERPRETERS: Record<string, string> = { py: "python3", js: "node", mjs: "node", cjs: "node", ts: "bun", rb: "ruby", pl: "perl" };

export function normalizeSkill(fetched: FetchedSkill): InstallCandidate | { error: string } {
  const notes: string[] = [];
  const skillMd = fetched.files.find((file) => file.path === "SKILL.md");
  if (!skillMd) return { error: "it has no SKILL.md" };
  if (skillMd.bytes.byteLength > MAX_SKILL_MD) return { error: `its SKILL.md is over ${MAX_SKILL_MD / 1000} KB` };
  const text = decodeText(skillMd.bytes);
  if (text === null) return { error: "its SKILL.md is not text" };

  const { meta, body } = splitFrontmatter(text);
  if (!body.trim()) return { error: "its SKILL.md has no instructions after the frontmatter" };

  const name = slug(str(meta.name) || fetched.dirName);
  if (!VALID_SKILL_NAME.test(name)) return { error: `"${str(meta.name) || fetched.dirName}" cannot be made into a skill name` };
  if (str(meta.name) && str(meta.name) !== name) notes.push(`Named "${name}" (was "${str(meta.name)}"), since skill names are lowercase with hyphens here.`);

  let description = oneLine(str(meta.description));
  if (!description) {
    description = oneLine(body.replace(/^#.*$/gm, "").trim().split(/\n\s*\n/)[0] ?? "").slice(0, 300);
    notes.push("It had no description; the first paragraph is used. Edit it, since it is how agents find the skill.");
  }
  description = clip(description, MAX_DESCRIPTION);

  // Files first: what is kept decides what the scripts say about `requires`.
  const files: InstallCandidate["files"] = [];
  const left: string[] = [];
  let total = text.length;
  for (const file of fetched.files) {
    if (file.path === "SKILL.md") continue;
    if (!VALID_INSTALLED_PATH.test(file.path)) {
      left.push(`${file.path} (path)`);
      continue;
    }
    if (file.bytes.byteLength > MAX_FILE) {
      left.push(`${file.path} (over ${MAX_FILE / 1000} KB)`);
      continue;
    }
    const content = decodeText(file.bytes);
    if (content === null) {
      left.push(`${file.path} (binary)`);
      continue;
    }
    if (!content.trim()) continue;
    if (total + content.length > MAX_TOTAL) {
      left.push(`${file.path} (the skill is over ${MAX_TOTAL / 1_000_000} MB)`);
      continue;
    }
    total += content.length;
    files.push({ path: file.path, content });
  }
  if (left.length) notes.push(`Left out ${left.length} ${plural(left.length, "file")} it cannot hold: ${left.slice(0, 12).join(", ")}${left.length > 12 ? ", …" : ""}.`);

  const tools = needsTools(meta, files, body, notes);
  const requires = hostRequires(meta, files, notes);

  return { name, description, requires, needsTools: tools, body: body.trim(), files, notes };
}

function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text };
  const body = text.slice(match[0].length);
  try {
    const parsed = parseYaml(match[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { meta: parsed as Record<string, unknown>, body };
  } catch {
    // Not YAML — Nouride's own `key: value` form, which YAML usually accepts but not always.
  }
  const meta: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body };
}

function needsTools(meta: Record<string, unknown>, files: InstallCandidate["files"], body: string, notes: string[]): string {
  const declared = list(meta.needs_tools);
  if (declared.length) return declared.join(", ");

  const allowed = list(meta["allowed-tools"] ?? meta.allowed_tools ?? meta.tools);
  if (allowed.length) {
    const mapped = new Set<string>();
    const unknown: string[] = [];
    for (const raw of allowed) {
      // `Bash(git:*)` scopes a tool in Claude Code; here the scope is the agent's exec policy.
      const bare = raw.replace(/\(.*\)$/, "").trim();
      const tool = NOURIDE_TOOLS.has(bare) ? bare : TOOL_MAP[bare.toLowerCase().replace(/[^a-z]/g, "")];
      if (tool) mapped.add(tool);
      else unknown.push(bare);
    }
    notes.push(`Tools mapped from allowed-tools: ${allowed.join(", ")} → ${[...mapped].join(", ") || "none"}${unknown.length ? ` (no counterpart here: ${unknown.join(", ")})` : ""}.`);
    return [...mapped].join(", ");
  }

  // Nothing declared: what the skill evidently does. Scripts mean running them; a shell block in the
  // instructions means the same.
  const runs = files.some((file) => file.path.startsWith("scripts/") || /\.(sh|py|js|mjs|ts|rb)$/.test(file.path)) || /```(bash|sh|shell|zsh|console)\b/.test(body);
  const tools = runs ? ["read", "exec"] : ["read"];
  notes.push(`It declares no tools; needs_tools is inferred as ${tools.join(", ")}.`);
  return tools.join(", ");
}

function hostRequires(meta: Record<string, unknown>, files: InstallCandidate["files"], notes: string[]): string {
  const declared = new Set<string>(list(meta.requires));
  const openclaw = (meta.metadata as { openclaw?: { requires?: { bins?: unknown } }; clawdbot?: { requires?: { bins?: unknown } } } | undefined) ?? {};
  for (const bin of list(openclaw.openclaw?.requires?.bins ?? openclaw.clawdbot?.requires?.bins)) declared.add(bin);

  const inferred = new Set<string>();
  for (const file of files) {
    const shebang = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:\S*\/)?([\w.+-]+)/.exec(file.content)?.[1];
    const fromShebang = shebang && !["sh", "bash", "zsh"].includes(shebang) ? shebang.replace(/^python$/, "python3") : undefined;
    const fromExtension = file.path.startsWith("scripts/") ? INTERPRETERS[file.path.split(".").pop() ?? ""] : undefined;
    for (const bin of [fromShebang, fromExtension]) if (bin && !declared.has(bin)) inferred.add(bin);
  }
  if (inferred.size) notes.push(`requires inferred from its scripts: ${[...inferred].join(", ")}.`);
  return [...declared, ...inferred].join(", ");
}

/** A string, or the strings in a list, or a comma/space-separated string split. */
function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => (typeof item === "string" ? [item.trim()] : [])).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+(?![^(]*\))/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function slug(text: string): string {
  let out = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(out)) out = `skill-${out}`;
  return out.slice(0, 48).replace(/-+$/, "");
}

/** UTF-8 text, or `null` for what is not: invalid UTF-8, or a NUL byte anywhere. */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
