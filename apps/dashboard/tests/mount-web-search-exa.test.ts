/**
 * Exa on the Web Search page: its card, where to get a key, and a key that is kept under Exa's own name.
 *
 * Brave and Exa each take a key, and the page has one key field. A key pasted for Exa saved under Brave's name would
 * replace Brave's key, so picking the other service carries its own usual name with it, and drops a key pasted for
 * the one left.
 */

import { expect, test } from "bun:test";
import { answer, enabled, press, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const pick = async (host: HTMLElement, title: string) => {
  const card = () => [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find((radio) => radio.textContent?.includes(title));
  if (!card()) throw new Error(`no card "${title}"`);
  card()!.click();
  await eventually(() => card()?.getAttribute("aria-checked") === "true", 2_000, `${title} picked`);
};
const valueOf = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("label")].find((element) => element.textContent?.includes(label))?.querySelector("input")?.value;

test("Exa: where to get a key, and a pasted key saved under Exa's own name", async () => {
  const record = recordPosts({ "/web-search": { status: 200, body: { ok: true, restartRequired: true, settings: WIRE["/web-search"] } } });
  let html = "";
  try {
    await renderPage("/web-search", async (host) => {
      await eventually(() => host.querySelector('[role="radio"]') !== null, 2_000, "the providers");
      await pick(host, "Exa");
      await eventually(() => (host.textContent ?? "").includes("Getting an Exa API key"), 2_000, "the Exa guide");
      // As drawn before the save: the saved settings answered below are the stock ones, and redraw the page.
      html = host.innerHTML;
      expect(valueOf(host, "Save as")).toBe("exa_api_key");
      type(host.querySelector<HTMLInputElement>('input[type="password"]')!, "exa-pasted-key");
      await enabled(host, "Save");
      press(host, "Save");
      await eventually(() => record.posts.some((post) => post.path === "/web-search"), 2_000, "the save");
    });
  } finally {
    record.restore();
  }

  expect(html).toContain("dashboard.exa.ai/api-keys");
  expect(html).toContain("exa.ai/pricing");
  expect(record.posts.find((post) => post.path === "/web-search")?.body).toEqual({
    mode: "exa",
    fallbackEnabled: true,
    apiKeySecret: "exa_api_key",
    apiKeyValue: "exa-pasted-key",
  });
});

test("moving from Brave to Exa and back carries each one's own key name, and drops a key pasted for the other", async () => {
  const saved = WIRE["/web-search"] as Record<string, unknown>;
  answer({
    "/web-search": { status: 200, body: { ...saved, mode: "brave", apiKeySecret: "brave_search_api_key", apiKeyOrigin: "store", effective: "brave" } },
    "/secrets": { status: 200, body: { secrets: [{ name: "brave_search_api_key", origin: "store", usedBy: ["web search"], shadowed: false, fields: {} }] } },
  });
  const seen: { exaName?: string; exaKey?: string; braveName?: string } = {};
  await renderPage("/web-search", async (host) => {
    await eventually(() => host.querySelector('[role="radio"]') !== null, 2_000, "the providers");
    // Brave in use, its key held in Secrets: the page starts on the saved secret.
    await eventually(() => host.querySelector<HTMLInputElement>('input[role="combobox"]')?.value === "brave_search_api_key", 2_000, "Brave's secret");

    await pick(host, "Exa");
    await eventually(() => valueOf(host, "Save as") !== undefined, 2_000, "a key to paste for Exa");
    seen.exaName = valueOf(host, "Save as");
    type(host.querySelector<HTMLInputElement>('input[type="password"]')!, "meant-for-exa");
    await eventually(() => host.querySelector<HTMLInputElement>('input[type="password"]')?.value === "meant-for-exa", 2_000, "the key typed");

    await pick(host, "Brave Search API");
    await eventually(() => host.querySelector<HTMLInputElement>('input[role="combobox"]') !== null, 2_000, "Brave's saved secret again");
    seen.braveName = host.querySelector<HTMLInputElement>('input[role="combobox"]')!.value;

    await pick(host, "Exa");
    await eventually(() => valueOf(host, "Save as") !== undefined, 2_000, "Exa's key field again");
    seen.exaKey = host.querySelector<HTMLInputElement>('input[type="password"]')!.value;
  });

  expect(seen).toEqual({ exaName: "exa_api_key", braveName: "brave_search_api_key", exaKey: "" });
});
