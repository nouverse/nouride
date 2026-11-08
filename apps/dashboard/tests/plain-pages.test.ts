/**
 * The dashboard in plain words (0.8.19): the people who use it are not technical, so what a
 * page says, as it is drawn, holds no command, flag, file name or internal word outside a "Details" section, which is
 * for whoever runs the server. Rendered here with the engine's own answers (`fixtures/wire.json`), so the words a page
 * builds from what the daemon sends are read too, not only the ones written in its source. It reads what the default
 * answers draw; `apps/engine/tests/contracts/plain-dashboard.test.ts` holds every string in the source, a card these
 * answers never draw included.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

/**
 * What a person must never meet in a page's words: the source contract's rule, as a page draws it. A command is
 * lowercase `nouride`, as typed: the product's name starts a sentence ("Nouride restarts"). A coding CLI passes: the
 * name kept for Claude Code, Codex and their like (2026-11-05).
 */
const COMMAND = /(?<![\w/.-])nouride [a-z][a-z-]+|(?<![\w-])--[a-z]/;
const WORDS =
  /\b[\w-]+\.(?:toml|json|ya?ml|md|sh|env)\b|\b(?:daemon|gateways?|snapshots?|passphrases?|payloads?|ACP|MCP|(?<!coding )CLIs?|stdin|adapters?|registry|config(?:uration)?|inject(?:s|ed|ing|ion)?|mapped|mappings?)\b|\b(?:this|the|an?|each|every|your|its)\s+install(?:'s)?\b/i;

/**
 * What a person reads without opening a Details section: each element that holds words of its own, with what is inside
 * it, so a hit names the sentence it is in rather than the page, and words beside a link or a bold name are read too.
 */
function words(host: HTMLElement): string {
  const copy = host.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll("details")) if (details.querySelector(":scope > summary")?.textContent === "Details") details.remove();
  const TEXT = 3;
  return [...copy.querySelectorAll("*")]
    .filter((element) => [...element.childNodes].some((node) => node.nodeType === TEXT && (node.textContent ?? "").trim() !== ""))
    .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .join("\n");
}

/**
 * What a page shows that people wrote, not the dashboard: the engine's fixture missions hold a plan step and a check
 * their agent and their person wrote. Read as data, each with why.
 */
const DATA: Record<string, string> = {
  "Write report.md": "a step of a mission's plan, as its agent wrote it",
  "test -s report.md": "a check the person who started the mission wrote",
};

/** An address a person copies, like Integrations' `http://localhost/mcp`: a value, not wording. */
const ADDRESS = /^https?:\/\/\S+$/;

const offending = (text: string) =>
  text
    .split("\n")
    .filter((line) => !ADDRESS.test(line) && !Object.keys(DATA).some((data) => line.includes(data)))
    .filter((line) => COMMAND.test(line) || WORDS.test(line));

const PAGES: [name: string, path: string][] = [
  ["welcome", "/welcome"],
  ["home", "/"],
  ["chat", "/chat"],
  ["a conversation", "/chat/ses_1"],
  ["agents", "/agents"],
  ["agent settings", "/agents/settings"],
  ["an agent's files", "/agents/nouva"],
  ["an agent's model", "/agents/nouva/model"],
  ["an agent's connections", "/agents/nouva/gateways"],
  ["an agent's access", "/agents/nouva/access"],
  ["an agent's skills", "/agents/nouva/skills"],
  ["an agent's connectors", "/agents/nouva/mcp"],
  ["models", "/models"],
  ["coding CLIs", "/models?tab=clis"],
  ["update", "/update"],
  ["people", "/people"],
  ["groups", "/groups"],
  ["memory", "/memories"],
  ["skills", "/skills"],
  ["missions", "/missions"],
  ["a mission", "/missions/msn_1"],
  ["schedule", "/schedule"],
  ["integrations", "/integrations"],
  ["connectors", "/mcp"],
  ["web search", "/web-search"],
  ["access", "/access"],
  ["access, denied", "/access?tab=denied"],
  ["access, blocked", "/access?tab=blocked"],
  ["access, history", "/access?tab=history&agent=nouva"],
  ["users", "/users"],
  ["webhooks", "/webhooks"],
  ["background helpers", "/jobs"],
  ["box", "/box"],
  ["office", "/office"],
  ["account", "/account"],
  ["login", "/login"],
  // Logs and LLM Gateway are for whoever runs the server and keep their terms; Secrets is rewritten on its own (0.8.19).
];

describe("each page in plain words", () => {
  for (const [name, path] of PAGES) {
    test(name, async () => {
      answer({});
      let found: string[] = [];
      await renderPage(path, async (host) => {
        await eventually(() => (host.textContent ?? "").trim().length > 0, 2_000, "the page");
        found = offending(words(host));
      });
      expect(found).toEqual([]);
    });
  }
});
