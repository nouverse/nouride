/**
 * A search box on Groups and Secrets (0.8.23, the owner: with many of either, the one to change was a long scroll away):
 * a room found by any name it goes by, its platform, who talks there or its agents; a secret by its name, what uses it
 * as the page words it, or what is said about it. The same box Missions, Jobs and MCP filter with, narrowing as it is
 * typed in. In a file of its own over the shared harness.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const search = (host: HTMLElement) => host.querySelector('input[type="search"]') as HTMLInputElement;

describe("a search box on Groups and Secrets", () => {
  test("Groups: a room found by its name, the name its platform gave it before a rename, its platform, who talks there and its agents; none matching said", async () => {
    answer({
      "/groups": ok({
        groups: [
          // Renamed here: Telegram still calls it Keluarga Besar.
          { gatewayId: "telegram:main", platform: "telegram", chatId: "-100200", dashboard: false, name: "Rumah", platformTitle: "Keluarga Besar", agents: ["nouva"], people: [{ key: "gading", name: "Gading" }], lastActive: 1760000000000 },
          { gatewayId: "discord:main", platform: "discord", chatId: "900", dashboard: false, name: "Ops room", platformTitle: "Ops room", agents: ["nix"], people: [{ name: "Sam" }], lastActive: 1760000000000 },
          { gatewayId: "whatsapp:main", platform: "whatsapp", chatId: "120363@g.us", dashboard: false, name: "Arisan RT 05", platformTitle: "Arisan RT 05", agents: ["nestor"], people: [{ name: "Rina" }], lastActive: 1760000000000 },
        ],
      }),
    });
    const seen: Record<string, string> = {};
    await renderPage("/groups", async (host) => {
      await eventually(() => host.textContent?.includes("Ops room") === true, 2_000, "the rooms");
      type(search(host), "ops");
      await eventually(() => !host.textContent?.includes("Rumah"), 2_000, "found by its name");
      seen.byName = host.textContent ?? "";
      type(search(host), "keluarga");
      await eventually(() => !host.textContent?.includes("Ops room"), 2_000, "found by the name its platform gave it");
      seen.byTitle = host.textContent ?? "";
      type(search(host), "whatsapp");
      await eventually(() => !host.textContent?.includes("Rumah"), 2_000, "found by its platform");
      seen.byPlatform = host.textContent ?? "";
      type(search(host), "sam");
      await eventually(() => !host.textContent?.includes("Arisan RT 05"), 2_000, "found by who talks there");
      seen.byPerson = host.textContent ?? "";
      type(search(host), "nestor");
      await eventually(() => !host.textContent?.includes("Ops room"), 2_000, "found by its agent");
      seen.byAgent = host.textContent ?? "";
      type(search(host), "no such room");
      await eventually(() => host.textContent?.includes("Nothing matches") === true, 2_000, "none matching");
      type(search(host), "");
      await eventually(() => ["Rumah", "Ops room", "Arisan RT 05"].every((name) => host.textContent?.includes(name)), 2_000, "all back");
    });
    expect(seen.byName).toContain("Ops room");
    expect(seen.byName).not.toContain("Arisan RT 05");
    expect(seen.byTitle).toContain("Rumah");
    expect(seen.byTitle).not.toContain("Arisan RT 05");
    expect(seen.byPlatform).toContain("Arisan RT 05");
    expect(seen.byPlatform).not.toContain("Ops room");
    expect(seen.byPerson).toContain("Ops room");
    expect(seen.byAgent).toContain("Arisan RT 05");
  });

  test("Secrets: one found by its name, by what uses it as the page says it, and by what is said about it; none matching said", async () => {
    answer({
      "/secrets": ok({
        secrets: [
          { name: "telegram_nouva_token", origin: "store", usedBy: ["gateway telegram:nouva"], shadowed: false, fields: {} },
          { name: "brave_search_api_key", origin: "store", usedBy: [], shadowed: false, fields: { site: "search.brave.com" } },
          { name: "github_token", origin: "env", usedBy: [], shadowed: false, fields: { account: "gadingnst" } },
        ],
        sealedInSnapshots: false,
        lock: { encrypted: true, key: { where: "/srv/nouride/data/encryption.key", level: "data" } },
      }),
    });
    const seen: Record<string, string> = {};
    await renderPage("/secrets", async (host) => {
      await eventually(() => host.textContent?.includes("github_token") === true, 2_000, "the secrets");
      type(search(host), "github");
      await eventually(() => !host.textContent?.includes("telegram_nouva_token"), 2_000, "found by its name");
      seen.byName = host.textContent ?? "";
      // The page says a gateway is a connection, so a person searches for that word.
      type(search(host), "connection");
      await eventually(() => !host.textContent?.includes("github_token"), 2_000, "found by what uses it");
      seen.byUse = host.textContent ?? "";
      type(search(host), "brave.com");
      await eventually(() => !host.textContent?.includes("telegram_nouva_token"), 2_000, "found by what is said about it");
      seen.byField = host.textContent ?? "";
      type(search(host), "no such secret");
      await eventually(() => host.textContent?.includes("Nothing matches") === true, 2_000, "none matching");
      type(search(host), "");
      await eventually(() => ["telegram_nouva_token", "brave_search_api_key", "github_token"].every((name) => host.textContent?.includes(name)), 2_000, "all back");
    });
    expect(seen.byName).toContain("github_token");
    expect(seen.byName).not.toContain("brave_search_api_key");
    expect(seen.byUse).toContain("telegram_nouva_token");
    expect(seen.byUse).not.toContain("brave_search_api_key");
    expect(seen.byField).toContain("brave_search_api_key");
    expect(seen.byField).not.toContain("github_token");
  });
});
