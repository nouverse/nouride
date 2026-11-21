/**
 * Every field that suggests says when its whole list is shown. A model's field shows it on a press in a wide window
 * (`listOnPress={wide}`), and waits for typing or its arrow on a phone, where a list opened on a press moves under the
 * keyboard; a field answered by picking from what is listed shows it on focus. One that said neither listed nothing
 * until something was typed: an agent's Coding CLI page had a model field that looked empty of choices.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".tsx") ? [join(dir, entry.name)] : []));
}

/** Each `<Combobox … />` in the dashboard, by its file, with its own attributes as written. */
function fields(): { file: string; tag: string }[] {
  return sources(SRC).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/<Combobox\b[\s\S]*?\/>/g)].map((match) => ({ file: relative(SRC, path), tag: match[0] }));
  });
}

/** The fields that suggest models: a provider's, a coding CLI's. */
const MODEL_FIELDS = [
  "modules/agents/cli.page.tsx",
  "modules/agents/model.page.tsx",
  "modules/agents/components/AgentModelTiers.tsx",
  "modules/agents/components/NewAgentForm.tsx",
  "modules/agents/components/AgentFallbacks.tsx",
  "modules/models/components/ModelTiers.tsx",
  "modules/memories/model-field.tsx",
  "modules/setup/index.page.tsx",
  "modules/chat/components/ChatChoice.tsx",
];

describe("a field that suggests", () => {
  test("a model's field shows its whole list on a press, in a wide window only", () => {
    const found = fields();
    for (const file of MODEL_FIELDS) {
      const tags = found.filter((field) => field.file === file);
      expect({ file, fields: tags.length > 0 }).toEqual({ file, fields: true });
      for (const { tag } of tags) expect({ file, onPress: tag.includes("listOnPress={wide}") }).toEqual({ file, onPress: true });
    }
  });

  test("none is left that says neither: a new field picks when its list is shown", () => {
    const silent = fields().filter(({ tag }) => !tag.includes("listOnPress") && !tag.includes("listOnFocus"));
    expect(silent.map((field) => field.file)).toEqual([]);
  });

  test("the window's width is read where the field is drawn, never assumed", () => {
    for (const file of MODEL_FIELDS) {
      const text = readFileSync(join(SRC, file), "utf8");
      expect({ file, reads: text.includes("const wide = useWide();") }).toEqual({ file, reads: true });
    }
  });
});
