/**
 * What the image holds for the built-in skills, held to three places that have to agree: the Dockerfile's package
 * line, the skills' own `requires`, and what the Docker page tells a person.
 *
 * A container that never runs as root (a pod) cannot serve `nouride-pkg`, so a program a skill names is either in the
 * image or the skill does not run there. A skill added with a new program, or a package dropped from the line, would
 * otherwise be found by somebody whose skill does nothing.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, resolveBuiltinSkillsDir } from "@nouride/persona";

const root = join(import.meta.dir, "../../../..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

/** A program a skill names, and the Alpine package the image gets it from. */
const IN_THE_IMAGE: Record<string, string> = {
  python3: "python3",
  git: "git",
  ffmpeg: "ffmpeg",
  node: "nodejs",
  npx: "npm",
  pdftotext: "poppler-utils",
};

/** Programs a built-in skill names that the image leaves to be asked for, and the skill each belongs to. */
const ASKED_FOR: Record<string, string> = {
  dot: "diagrams",
  tectonic: "document-authoring",
  pandoc: "document-authoring",
  "yt-dlp": "nouclip",
  nouclip: "nouclip",
};

/** The packages of the runtime stage's `apk add`, its continuation lines joined. */
function imagePackages(): string[] {
  const from = dockerfile.indexOf("RUN apk add --no-cache bash");
  expect(from).toBeGreaterThan(-1);
  const lines: string[] = [];
  for (const line of dockerfile.slice(from).split("\n")) {
    lines.push(line.replace(/\\$/, ""));
    if (!line.trimEnd().endsWith("\\")) break;
  }
  return lines.join(" ").replace("RUN apk add --no-cache", "").split(/\s+/).filter(Boolean);
}

function skillRequires(): Map<string, string[]> {
  const dir = resolveBuiltinSkillsDir();
  if (!dir) throw new Error("the built-in skills were not found from this checkout");
  const out = new Map<string, string[]>();
  for (const name of readdirSync(dir)) {
    let text: string;
    try {
      text = readFileSync(join(dir, name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const requires = parseFrontmatter(text).fields.requires ?? "";
    out.set(name, requires.split(",").map((part) => part.trim()).filter(Boolean));
  }
  return out;
}

describe("the programs the image holds for the built-in skills", () => {
  test("every package behind a program a skill names is on the Dockerfile's line", () => {
    const packages = imagePackages();
    for (const [program, pkg] of Object.entries(IN_THE_IMAGE)) expect({ program, inImage: packages.includes(pkg) }).toEqual({ program, inImage: true });
  });

  test("every program a built-in skill names is in the image or among those asked for, by name", () => {
    const skills = skillRequires();
    expect(skills.size).toBeGreaterThan(10);
    const unknown: string[] = [];
    for (const [skill, programs] of skills) for (const program of programs) if (!(program in IN_THE_IMAGE) && !(program in ASKED_FOR)) unknown.push(`${skill}: ${program}`);
    // A new program: add its package to the Dockerfile and to IN_THE_IMAGE, or name it in ASKED_FOR and on the Docker page.
    expect(unknown).toEqual([]);
    // And the list of what is asked for names no program a skill stopped needing, nor the wrong skill.
    for (const [program, skill] of Object.entries(ASKED_FOR)) expect({ program, named: skills.get(skill)?.includes(program) ?? false }).toEqual({ program, named: true });
  });

  test("the Docker page's count is the skills' own, in both languages", () => {
    const skills = skillRequires();
    const whole = [...skills.values()].filter((programs) => programs.every((program) => program in IN_THE_IMAGE)).length;
    const words: Record<number, [string, string]> = { 15: ["fifteen", "lima belas"], 16: ["sixteen", "enam belas"], 17: ["seventeen", "tujuh belas"], 18: ["eighteen", "delapan belas"], 19: ["nineteen", "sembilan belas"] };
    const [enWhole, idWhole] = words[whole] ?? ["?", "?"];
    const [enAll, idAll] = words[skills.size] ?? ["?", "?"];
    const en = readFileSync(join(root, "apps/site/src/content/docs/en/docs/deployment/docker.md"), "utf8");
    const id = readFileSync(join(root, "apps/site/src/content/docs/id/docs/deployment/docker.md"), "utf8");
    expect(en).toContain(`${enWhole} of the ${enAll} built-in skills`);
    expect(id).toContain(`${idWhole} dari ${idAll} skill bawaan`);
    // Each skill left out is named with what it wants, so a person knows what to ask for.
    for (const skill of new Set(Object.values(ASKED_FOR))) {
      expect(en).toContain(`**${skill}**`);
      expect(id).toContain(`**${skill}**`);
    }
  });
});
