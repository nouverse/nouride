/**
 * The dashboard in plain words (0.8.19). The people who use it are not technical (the owner, 2026-11-05), so what a page
 * says holds no command (`nouride …`), flag, file name or path, and none of the words that say how Nouride is built
 * rather than what it does for them: daemon, gateway, snapshot, seal, passphrase, payload, ACP, MCP, CLI (a coding CLI
 * aside, the name the owner kept), stdin, adapter, registry, config, install as a noun, a line or track of releases,
 * token; nor a section of the config file, a setting's name as it writes it, or a `git` word (0.8.20). Every word says
 * what something means for them and what they can do on that page; `TECHNICAL` in the inventory says what is refused,
 * and the server's own replies on the dashboard's routes are held to it by `plain-replies.test.ts`.
 *
 * Read as `no-em-dash.test.ts` reads the dashboard, by the parser, through the word inventory (`scripts/dashboard-words.ts`),
 * which keeps only what reaches the screen. Let through:
 * - what sits in a "Details" section (`<Details>`, or `<details>` whose summary reads "Details"), closed by default and
 *   for whoever runs the server;
 * - the admin pages, Logs and LLM Gateway, which keep their terms under one plain line saying what each is for;
 * - a line marked `plain-words-ok: <why>`, as `em-dash-ok:` marks one: a token counted as a model's unit, a bot token
 *   in the words BotFather uses, an example a field takes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DASHBOARD, sources, technical, wordsIn, type Wording } from "../../../../scripts/dashboard-words.ts";

/** Pages for whoever runs the server, which keep their terms. */
const ADMIN_PAGES = ["modules/logs/", "modules/llm-gateway/"];

const at = (word: Wording) => relative("apps/dashboard/src", word.file);
const words = () => sources().flatMap((path) => wordsIn(path));

describe("the dashboard in plain words", () => {
  test("no command, flag, file name, path or internal word where a person reads", () => {
    const all = words();
    expect(all.length).toBeGreaterThan(3000);
    const refused = all
      .filter((word) => !ADMIN_PAGES.some((page) => at(word).startsWith(page)))
      .filter((word) => !word.inDetails && !word.kept)
      .flatMap((word) => {
        const why = technical(word);
        return why ? [`${at(word)}:${word.line} (${why}) ${word.text}`] : [];
      });
    expect(refused).toEqual([]);
  });

  test("a line kept with a technical word says why", () => {
    const marked = sources().flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) => (line.includes("plain-words-ok") && !/plain-words-ok: \S/.test(line) ? [`${relative(DASHBOARD, path)}:${index + 1}`] : [])),
    );
    expect(marked).toEqual([]);
  });

  test("Details is closed until opened, and its summary reads Details", () => {
    const source = readFileSync(join(DASHBOARD, "commons/components/ui/Details.tsx"), "utf8");
    expect(source).toMatch(/<details\b(?![^>]*\bopen\b)[^>]*>/);
    expect(source).toMatch(/<summary\b[^>]*>Details<\/summary>/);
  });

  test("the admin pages keep their terms, each under one plain line saying what it is for", () => {
    const logs = wordsIn(join(DASHBOARD, "modules/logs/index.page.tsx")).find((word) => word.where === "prop:description");
    expect(logs?.text).toStartWith("For whoever runs the server:");
    expect(technical(logs!)).toBeNull();
    const gateway = wordsIn(join(DASHBOARD, "modules/llm-gateway/index.page.tsx")).find((word) => word.text === "The AI accounts and keys your agents use, and what they cost");
    expect(gateway).toBeDefined();
    expect(technical(gateway!)).toBeNull();
  });
});
