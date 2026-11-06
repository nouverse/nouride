/**
 * A credential the person sends in the chat is kept with `secret_save` (0.7.17) — the daemon takes it out of the
 * message, the agent gets a `$TMP_SECRET_…` handle, and the value never passes through the model. Three shipped skills
 * still said a password is "never typed into the chat" and gave `nouride secret set … --stdin` as the only way, so an
 * agent sent a person to a shell on the machine for what one chat message does (0.8.12).
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..", "content", "skills");
const pages = readdirSync(root, { recursive: true })
  .map(String)
  .filter((path) => path.endsWith(".md"))
  // As one line: where Markdown wraps a sentence is not part of what it says.
  .map((path) => ({ path, text: readFileSync(join(root, path), "utf8").replace(/\s+/g, " ") }));

test("no shipped skill gives the CLI as the only way to store a credential", () => {
  const cliOnly = pages
    .filter(({ text }) => text.includes("nouride secret set"))
    .filter(({ text }) => !text.includes("`secret_save`") || !text.includes("dashboard's Secrets page"))
    .map(({ path }) => path);
  expect(cliOnly).toEqual([]);
});

test("no shipped skill says a credential is never sent in the chat", () => {
  expect(pages.filter(({ text }) => /never typed into the chat/i.test(text)).map(({ path }) => path)).toEqual([]);
});

test("the skills that store a device's or a site's password say how, and keep it out of what they print", () => {
  const page = (path: string) => pages.find((one) => one.path === path)?.text ?? "";
  expect(page("browser-automation/SKILL.md")).toContain("If the person sends it here, it reaches you as a `$TMP_SECRET_…` handle");
  expect(page("browser-automation/SKILL.md")).toContain("Keep it with `secret_save` as `shop_pass`");
  expect(page("browser-automation/SKILL.md")).toContain("A password never goes into a command in the clear, and you never repeat it.");
  expect(page("network-reach/SKILL.md")).toContain("If the person sends it here, it reaches you as a `$TMP_SECRET_…` handle: keep it with `secret_save` as `cam_front`");
  expect(page("network-reach/SKILL.md")).toContain("Use it from there, never in a file, your notes or a reply.");
  expect(page("coding-agents/references/claude-code.md")).toContain("keep it with `secret_save` under that name");
});
