/**
 * Every skill we ship says what it asks of the machine it runs on.
 *
 * Nouride runs on boards down to 512 MB. A skill that starts a browser, a LaTeX build or an FFmpeg render there gets
 * the agent's command killed for memory halfway, and the person a reply that something "failed". So a heavy skill
 * checks the available memory before its heavy step and names a way out — another machine — and a light one says it
 * runs on a 512 MB board, so a model on one does not refuse it out of caution. A new skill must be put in one of the
 * two lists below: the last test fails until it is.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveBuiltinSkillsDir } from "@nouride/persona";

const dir = resolveBuiltinSkillsDir();
const body = (name: string) => readFileSync(join(dir!, name, "SKILL.md"), "utf8");

/** Each heavy skill: the words of its verdict for a machine too small, beside the memory check. */
const HEAVY: Record<string, string> = {
  "browser-automation": "under 600 MB available memory",
  slides: "not here, as on a 512 MB board",
  "mockup-design": "not here, as on a 512 MB board",
  "document-authoring": "Under 400 MB available, it is not for here",
  nouclip: "Under 700 MB available (any 512 MB board), render on another machine",
  "motion-graphics": "under 2 GB available memory",
  "coding-agents": "On a board of 1 GB or less, do not start one here",
};

const LIGHT = [
  "data-sheets",
  "document-reading",
  "diagrams",
  "homelab-ops",
  "home-assistant",
  "mail-calendar",
  "research",
  "network-reach",
  "share-preview",
];

describe("the skills we ship know the machine", () => {
  for (const [name, verdict] of Object.entries(HEAVY)) {
    test(`${name} checks the memory and says what to do when it is short`, () => {
      const text = body(name);
      // slides and mockup-design run browser-automation's own check rather than a copy of it.
      expect(text).toMatch(name === "slides" || name === "mockup-design" ? /browser-automation`'s step 1/ : /free -m/);
      expect(text).toContain(verdict);
      expect(text).toMatch(/another (?:of (?:the person's|their) )?machines?|step 8|step 7/);
    });
  }

  for (const name of LIGHT) {
    test(`${name} says it runs on a 512 MB board`, () => {
      expect(body(name)).toMatch(/## This machine[\s\S]*?512 MB board/);
    });
  }

  test("nouride says it runs nothing of its own", () => {
    expect(body("nouride")).toContain("Nothing here runs a program of its own");
  });

  test("every shipped skill is in one of the lists", () => {
    const names = readdirSync(dir!).filter((name) => statSync(join(dir!, name)).isDirectory() && !name.startsWith("."));
    const known = new Set([...Object.keys(HEAVY), ...LIGHT, "nouride"]);
    expect(names.filter((name) => !known.has(name))).toEqual([]);
  });
});
