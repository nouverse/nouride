/**
 * The Skills Workshop's pool as two lists: Live, what some agent is offered, and Off, what none is.
 *
 * The live list held every skill in the pool, those switched off for every agent and those on for no agent among them,
 * so what the agents carry could not be told from what they do not without reading each row's switches. Mounted in a
 * real DOM with the daemon's answers as it gives them.
 */

import { describe, expect, test } from "bun:test";
import type { CatalogSkill } from "@nouride/wire";
import { skillIsLive } from "../src/modules/skills/pool.list.tsx";
import { answer, overrides, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const agent = (id: string, enabled: boolean) => ({ id, displayName: id[0]!.toUpperCase() + id.slice(1), enabled, decided: true, missingTools: [] });
const skill = (name: string, on: { nouva: boolean; nix: boolean }, offGlobally = false): CatalogSkill => ({
  name, description: `What ${name} is for`, scope: "shared", path: `/srv/nouride/.nouride/agents/skills/${name}/SKILL.md`,
  requires: [], missing: [], needsTools: [], offGlobally,
  agents: [agent("nouva", on.nouva), agent("nix", on.nix)], lastUsedAt: null, reads: 0, readsSinceChange: 0,
});
const CARRIED = skill("pdf-tools", { nouva: true, nix: false });
const ON_FOR_NONE = skill("deploy-k8s", { nouva: false, nix: false });
const OFF_FOR_EVERY = skill("android-adb", { nouva: true, nix: true }, true);

function daemon(skills: CatalogSkill[]) {
  answer({
    "/skills/catalog": { status: 200, body: { skills, software: {}, poolDir: "/srv/skills", editable: true } },
    "/skills/drafts": { status: 200, body: { enabled: true, pending: [], recent: [] } },
  });
}
const tabs = (host: HTMLElement) => [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim());
const tab = (host: HTMLElement, label: string) => ([...host.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.trim().startsWith(label)) as HTMLElement).click();
const rows = (host: HTMLElement) => [...host.querySelectorAll("li")].map((row) => row.querySelector("span.font-medium")?.textContent).filter(Boolean);

describe("which skills are live", () => {
  test("on for some agent and not switched off for every agent; anything else is off", () => {
    expect(skillIsLive(CARRIED)).toBe(true);
    expect(skillIsLive(ON_FOR_NONE)).toBe(false);
    // Its agents' own switches are kept for when it comes back on, and they do not make it live.
    expect(skillIsLive(OFF_FOR_EVERY)).toBe(false);
    expect(skillIsLive({ ...CARRIED, agents: [] })).toBe(false);
  });
});

describe("the Skills Workshop", () => {
  test("opens on Live with what the agents carry, and counts each list on its tab", async () => {
    daemon([CARRIED, ON_FOR_NONE, OFF_FOR_EVERY]);
    let listed: unknown[] = [];
    let named: unknown[] = [];
    const html = await renderPage("/skills", async (host) => {
      await eventually(() => rows(host).length > 0, 3_000, "the list");
      listed = rows(host);
      named = tabs(host);
    });
    expect(named).toEqual(["Live1", "Off2", "Pending0", "Explore"]);
    expect(listed).toEqual(["pdf-tools"]);
    expect(html).toContain("1 skill live");
  });

  test("Off lists the skills no agent is offered, and says of one switched off for every agent that it is", async () => {
    daemon([CARRIED, ON_FOR_NONE, OFF_FOR_EVERY]);
    let listed: unknown[] = [];
    let marked: unknown[] = [];
    const html = await renderPage("/skills", async (host) => {
      await eventually(() => rows(host).length > 0, 3_000, "the list");
      tab(host, "Off");
      await eventually(() => rows(host).includes("deploy-k8s"), 3_000, "the Off list");
      listed = rows(host);
      marked = [...host.querySelectorAll("li")].filter((row) => row.textContent?.includes("Off for every agent")).map((row) => row.querySelector("span.font-medium")?.textContent);
    });
    expect(listed).toEqual(["deploy-k8s", "android-adb"]);
    expect(marked).toEqual(["android-adb"]);
    expect(html).toContain("2 skills turned off");
    expect(html).toContain("Switched off for every agent, or on for none.");
  });

  test("the filter narrows the list that is showing", async () => {
    daemon([CARRIED, ON_FOR_NONE, OFF_FOR_EVERY]);
    let listed: unknown[] = [];
    await renderPage("/skills", async (host) => {
      await eventually(() => rows(host).length > 0, 3_000, "the list");
      tab(host, "Off");
      await eventually(() => Boolean(host.querySelector('input[aria-label="Filter skills"]')) && rows(host).includes("deploy-k8s"), 3_000, "the Off list");
      const input = host.querySelector('input[aria-label="Filter skills"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "android");
      input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
      await eventually(() => rows(host).length === 1, 3_000, "the filtered list");
      listed = rows(host);
    });
    expect(listed).toEqual(["android-adb"]);
  });

  test("a skill switched on for an agent from Off goes to Live", async () => {
    daemon([CARRIED, ON_FOR_NONE]);
    overrides["/skills/deploy-k8s/agents/nix"] = { status: 200, body: { ok: true, skill: "deploy-k8s", agentId: "nix", enabled: true } };
    let after: { off: unknown[]; named: unknown[] } = { off: [], named: [] };
    await renderPage("/skills", async (host) => {
      await eventually(() => rows(host).length > 0, 3_000, "the list");
      tab(host, "Off");
      await eventually(() => rows(host).includes("deploy-k8s"), 3_000, "the Off list");
      // The daemon's next answer is the one after the switch.
      overrides["/skills/catalog"] = { status: 200, body: { skills: [CARRIED, skill("deploy-k8s", { nouva: false, nix: true })], software: {}, poolDir: "/srv/skills", editable: true } };
      ([...host.querySelectorAll("li button")].find((button) => button.getAttribute("title") === "Off for Nix. Click to switch on") as HTMLElement).click();
      await eventually(() => tabs(host).includes("Live2"), 3_000, "the counts after the switch");
      after = { off: rows(host), named: tabs(host) };
    });
    expect(after.named).toEqual(["Live2", "Off0", "Pending0", "Explore"]);
    expect(after.off).toEqual([]);
  });
});
