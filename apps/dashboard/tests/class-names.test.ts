/**
 * No class name that draws nothing.
 *
 * 158 class tokens in the dashboard generated no CSS at all. Most were
 * daisyUI 4 names — `input-bordered` in 36 files, `form-control`, `label-text` — that daisyUI 5 dropped,
 * still being added in October because they are what a hand trained on v4 types. The rest came from
 * plugins this build has never had: `animate-in fade-in slide-in-from-left` for a drawer, a toast and the
 * approval strip that never animated, and `prose-sm` for markdown that was never sized by it. Nobody
 * reading the code could tell which classes did anything, so they were deleted, and this keeps the
 * families from coming back. Using one of these effects means adding what draws it first, and then
 * taking its name out of this list.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(import.meta.path), "..", "src");

/** Each family, and where the name came from — the message is what somebody reads when this fails. */
const DEAD: { pattern: RegExp; from: string }[] = [
  { pattern: /^(input|select|textarea|file-input)-bordered$/, from: "daisyUI 4: a v5 field has its border already, and `*-ghost` removes it" },
  { pattern: /^(form-control|label-text(-alt)?)$/, from: "daisyUI 4: v5 has `fieldset`, `fieldset-legend` and `label`" },
  { pattern: /^(btn-group|input-group)$/, from: "daisyUI 4: v5 has `join`" },
  { pattern: /^card-(bordered|compact)$/, from: "daisyUI 4: v5 has `card-border` and `card-sm`" },
  { pattern: /^tabs?-(boxed|lifted|bordered)$/, from: "daisyUI 4: v5 has `tabs-box`, `tabs-lift` and `tabs-border`" },
  {
    pattern: /^(animate-(in|out|fade-in)|(fade|zoom|spin)-(in|out)(-\d+)?|slide-(in-from|out-to)-[\w-]+)$/,
    from: "tailwindcss-animate / tw-animate-css, which this build does not include",
  },
  { pattern: /^prose(-[\w-]+)?$/, from: "@tailwindcss/typography, which this build does not include" },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

/** Comments may name what was removed; only code is read. URLs keep their `//` (the `:` before it). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every whitespace-separated word inside a string literal, a template's `${…}` taken out. */
function literalWords(source: string): string[] {
  return [...code(source).matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`]*)`/g)].flatMap((m) =>
    (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean),
  );
}

/** `md:hover:!input-bordered` is `input-bordered`: a variant or `!` in front does not make a name draw. */
const bare = (word: string) => word.replace(/^(?:[^:\s]+:)+/, "").replace(/^!/, "");

describe("class names", () => {
  test("the scan reads class strings, so a clean result means something", () => {
    // The fail-open shape: a reader that stopped finding literals would pass whatever the source said.
    const words = sources(SRC).flatMap((path) => literalWords(readFileSync(path, "utf8")));
    expect(words).toContain("btn");
    expect(words.length).toBeGreaterThan(3000);
  });

  test("each is one this build generates CSS for", () => {
    const found = sources(SRC).flatMap((path) =>
      literalWords(readFileSync(path, "utf8")).flatMap((word) => {
        const hit = DEAD.find(({ pattern }) => pattern.test(bare(word)));
        return hit ? [`${relative(SRC, path)}: ${word} — ${hit.from}`] : [];
      }),
    );
    expect(found).toEqual([]);
  });

  test("the tests are not read for class names", () => {
    // Tailwind generates CSS for every class-shaped word in the project it can see, and these files are
    // full of them: this one alone named a dozen daisyUI classes in its messages and added a kilobyte to
    // the CSS every user downloads. The build reads `src`; a test's strings are not the app's.
    const styles = join(SRC, "styles");
    const excluded = [...readFileSync(join(styles, "main.css"), "utf8").matchAll(/^@source not "([^"]+)";/gm)].map((m) => join(styles, m[1]!));
    expect(excluded).toContain(join(SRC, "..", "tests"));
  });

  test("the daisyUI names listed here really are gone from the daisyUI this builds with", () => {
    // So the list cannot ban a class that works: if a later daisyUI brings a name back, this says so.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.resolve("daisyui/package.json"))), "daisyui.css"), "utf8");
    const selectors = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]!));
    const daisy = DEAD.filter(({ from }) => from.startsWith("daisyUI"));
    expect([...selectors].filter((name) => daisy.some(({ pattern }) => pattern.test(name)))).toEqual([]);
  });
});
