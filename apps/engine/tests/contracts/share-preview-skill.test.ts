/**
 * The shipped `share-preview` skill puts a local port on a public address. The one thing it must never tunnel is this
 * daemon itself, and it names the dashboard's and the model gateway's ports to say so — read here from the defaults,
 * so a port that moves cannot leave the skill guarding the old one (0.8.12).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

const source = readFileSync(join(import.meta.dir, "../../../../content/skills/share-preview/SKILL.md"), "utf8");
// As one line: where Markdown wraps a sentence is not part of what it says.
const skill = source.replace(/\s+/g, " ");

test("never tunnels this daemon's own ports, named as the defaults have them", () => {
  expect(skill).toContain(`Never this daemon's own ports, the dashboard (\`${DEFAULT_CONFIG.dashboard.port}\`) and the model gateway (\`${DEFAULT_CONFIG.nougate.port}\`)`);
  expect(skill).toContain("nor a database, an admin panel or anything that answers without a login it should have");
});

test("says the link is public, and takes it down after", () => {
  expect(skill).toContain("**Anyone with the link can open it**");
  expect(skill).toContain("Send the link with one line saying it is public and temporary");
  expect(skill).toContain("stop both jobs (the tunnel and the app)");
});

test("binds the app to loopback, so the tunnel is the only way in", () => {
  expect(skill).toContain("bound to `127.0.0.1` where it lets you choose (the tunnel is the only way in)");
  expect(source).toContain("cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787");
});

/**
 * A link to a page nobody looked at (0.8.12, found reviewing browser-automation): the skill checked only that the
 * server answered, and a blank page, an error overlay or a layout broken at a phone's width all answer 200.
 */
describe("the page is looked at before the link goes", () => {
  test("through browser-automation, at a laptop's width and a phone's, with the page's own errors", () => {
    expect(skill).toContain("**And you look at the page before you send it**: a server that answers is not a page that works.");
    expect(skill).toContain("**Load the `browser-automation` skill**");
    expect(source).toContain("npx playwright-cli open http://127.0.0.1:8787/");
    expect(source).toContain("npx playwright-cli open --mobile http://127.0.0.1:8787/");
    expect(source).toContain("npx playwright-cli console error");
    expect(skill).toContain("`read` both pictures, and the errors.");
    // To read the pictures the skill needs the tool that opens them.
    expect(source).toMatch(/^needs_tools: exec, read$/m);
  });

  test("what is wrong is fixed or said — and a machine with no browser says it has not seen the page", () => {
    expect(skill).toContain("Something wrong is fixed before the link goes, or said in the message with it, never found by the person first.");
    expect(skill).toContain("say in the message that you have not seen the page, only that it answers");
  });

  test("the public link is checked to answer before it is sent", () => {
    expect(source).toContain('curl -fsS -o /dev/null --max-time 5 "$u"');
    expect(skill).toContain("Say what you saw at both widths in a few words, and anything still wrong.");
  });
});
