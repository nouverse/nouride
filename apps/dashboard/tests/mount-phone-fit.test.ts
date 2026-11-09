/**
 * What an iPhone showed breaking, held by the classes that fix it (a DOM here has no layout to measure):
 * - a skill's tool list spilled out of its badge's fixed height over the description, and the description and the
 *   agents' switches ran in the third of the row the chevron, the icon and the two switches left;
 * - Home's "Everything is working · v… · Pro · Up for …" was one pill, and a phone broke both halves in two;
 * - the page showed in the strip between the floating tab bar and the screen's foot, under the browser's toolbar;
 * - a secret's note was cut to an ellipsis whose rest only a mouse's tooltip showed, and a provider's "Key Active" broke
 *   in two inside its badge.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const classes = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/);

const skill = {
  name: "armbian-hardware-selection",
  description: "Use when choosing, vetting or sourcing ARM TV boxes to run Armbian.",
  scope: "shared",
  path: "/srv/nouride/skills/armbian-hardware-selection/SKILL.md",
  requires: [],
  missing: [],
  needsTools: ["exec", "web_fetch", "web_search", "read"],
  offGlobally: false,
  agents: [{ id: "nouva", displayName: "Nouva", enabled: true, decided: false, missingTools: [] }],
  lastUsedAt: null,
};

describe("on a phone, nothing spills out of its box", () => {
  test("a skill's tool list grows a line, and its description and switches run below the name, not beside the row's buttons", async () => {
    // No draft waiting, so the page opens on Live, the pool.
    answer({
      "/skills/catalog": ok({ skills: [skill], software: [], poolDir: "/srv/nouride/skills", editable: true }),
      "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }),
    });
    const seen: Record<string, string[] | boolean> = {};
    await renderPage("/skills", async (host) => {
      await eventually(() => host.textContent?.includes("web_search") === true, 2_000, "the skill");
      const tools = [...host.querySelectorAll("span")].find((span) => span.textContent?.includes("web_fetch, web_search"));
      seen.tools = classes(tools);
      const power = host.querySelector(`button[aria-label="Switch off ${skill.name} for every agent"]`);
      const description = [...host.querySelectorAll("p")].find((p) => p.textContent === skill.description);
      seen.besideButtons = Boolean(power?.parentElement?.contains(description ?? null));
      seen.found = Boolean(power && description);
    });
    expect(seen.found).toBe(true);
    expect(seen.tools).toEqual(expect.arrayContaining(["h-auto", "whitespace-normal"]));
    expect(seen.besideButtons).toBe(false);
  });

  test("Home's status and its version are two pieces, each kept on one line", async () => {
    const seen: { status: string[]; version: string[]; together: boolean } = { status: [], version: [], together: true };
    await renderPage("/", async (host) => {
      await eventually(() => host.textContent?.includes("Up for") === true, 2_000, "the box line");
      const status = [...host.querySelectorAll("span.font-semibold")].find((span) => span.textContent?.trim() === "Everything is working")?.parentElement;
      const version = [...host.querySelectorAll("span")].find((span) => /^v\d.*Up for/.test(span.textContent?.trim() ?? ""));
      seen.status = classes(status);
      seen.version = classes(version);
      seen.together = Boolean(status?.textContent?.includes("Up for"));
    });
    expect(seen.together).toBe(false);
    expect(seen.status).toContain("whitespace-nowrap");
    expect(seen.version).toContain("whitespace-nowrap");
  });

  test("under the tab bar the page's ground runs to the screen's foot, on a phone only", async () => {
    let ground: string[] = [];
    await renderPage("/", async (host) => {
      ground = classes(host.ownerDocument.querySelector('nav[aria-label="Tabs"]')?.previousElementSibling);
    });
    expect(ground).toEqual(expect.arrayContaining(["bg-app-foot", "fixed", "bottom-0", "lg:hidden", "pointer-events-none"]));
    const css = readFileSync(join(import.meta.dir, "../src/styles/main.css"), "utf8");
    expect(css).toMatch(/@utility bg-app-foot \{\s*background: linear-gradient\(to top, color-mix\(in oklab, var\(--color-base-200\) 50%, var\(--color-base-100\)\)/);
  });

  test("a secret's note grows a line, whole, and a provider's key badge stays on one", async () => {
    const secrets = WIRE["/secrets"] as { secrets: Record<string, unknown>[] };
    const note = "Telegram bot for agent Reno on the Nouride box, made for the support group";
    answer({
      "/secrets": ok({ ...secrets, secrets: [{ ...secrets.secrets[0], fields: { "used for": note } }] }),
      "/providers": ok({ providers: [{ name: "test", kind: "openai", baseUrl: "https://fake.test/v1", apiKeySecret: "testkey", hasCredential: true, builtIn: false }] }),
    });
    let secret: string[] = [];
    let whole = false;
    await renderPage("/secrets", async (host) => {
      await eventually(() => host.textContent?.includes("support group") === true, 2_000, "the note");
      const badge = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(note));
      secret = classes(badge);
      whole = badge?.textContent?.includes(note) === true;
    });
    expect(whole).toBe(true);
    expect(secret).toEqual(expect.arrayContaining(["h-auto", "whitespace-normal"]));
    expect(secret).not.toContain("truncate");
    let key: string[] = [];
    await renderPage("/models", async (host) => {
      await eventually(() => host.textContent?.includes("Key Active") === true, 2_000, "the badge");
      key = classes([...host.querySelectorAll("span")].find((span) => span.textContent?.trim() === "Key Active"));
    });
    expect(key).toEqual(expect.arrayContaining(["whitespace-nowrap", "shrink-0"]));
  });
});
