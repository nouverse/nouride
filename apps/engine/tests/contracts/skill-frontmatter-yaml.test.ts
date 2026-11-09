/**
 * Every shipped skill's frontmatter is YAML another parser reads too (0.8.12). Nouride's own reader splits each line at
 * its first colon and takes a value whole, so `description: …: …` passed here — and a strict YAML parser refused it,
 * "mapping values are not allowed in this context", for network-reach, nouclip and coding-agents: it showed in
 * a tool that reads skills as YAML. The rules a plain (unquoted) YAML scalar breaks are checked, with no YAML library.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKILLS = join(import.meta.dir, "../../../../content/skills");

/** Why a frontmatter value is not one strict YAML reads as the same string, or null. */
function yamlProblem(value: string): string | null {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return "a double-quoted value that does not end in a double quote";
    const inner = value.slice(1, -1);
    // Nouride strips one pair of quotes and unescapes nothing, so an escape would read differently here and there.
    if (/["\\]/.test(inner)) return "a double quote or a backslash inside a double-quoted value";
    return null;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return "a single-quoted value that does not end in a single quote";
    return value.slice(1, -1).includes("'") ? "a single quote inside a single-quoted value" : null;
  }
  if (/^[[\]{}&*!|>%@`#,?-]/.test(value) && !/^-[^ ]/.test(value)) return "a plain value starting with a YAML indicator";
  if (value.includes(": ") || value.endsWith(":")) return "': ' in a plain value — quote it";
  if (value.includes(" #")) return "' #' in a plain value starts a comment — quote it";
  return null;
}

describe("shipped skills' frontmatter is strict YAML", () => {
  const names = readdirSync(SKILLS).filter((name) => statSync(join(SKILLS, name)).isDirectory());
  for (const name of names) {
    test(name, () => {
      const source = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
      const block = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? "";
      const problems = block
        .split("\n")
        .filter((line) => /^[\w-]+:\s/.test(line))
        .map((line) => {
          const value = line.slice(line.indexOf(":") + 1).trim();
          const why = yamlProblem(value);
          return why ? `${line.slice(0, line.indexOf(":"))}: ${why}` : null;
        })
        .filter(Boolean);
      expect(problems).toEqual([]);
    });
  }
});

test("the check refuses what strict YAML refuses, and passes what it reads", () => {
  expect(yamlProblem("Reach a device: at home or away")).toContain("': '");
  expect(yamlProblem('"Reach a device: at home or away"')).toBeNull();
  expect(yamlProblem('"a "quoted" word"')).toContain("double quote");
  expect(yamlProblem("exec, read, write")).toBeNull();
  expect(yamlProblem("[x]")).toContain("indicator");
  expect(yamlProblem("a value # with a comment")).toContain("comment");
});
