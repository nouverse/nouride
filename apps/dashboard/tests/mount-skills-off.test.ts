/**
 * The Skills Workshop's pool as two lists: Live, what some agent is given now, and Off, what none is.
 *
 * The live list held every skill in the pool, those switched off for every agent and those on for no agent among them,
 * so what the agents carry could not be told from what they do not without reading each row's switches. Which is which
 * is the daemon's word, `offered`, per agent: an agent's own switch on is not enough where the skill is off for every
 * agent or a coding CLI lacks a tool it needs. Mounted in a real DOM with the daemon's answers as it gives them.
 */

import { describe, expect, test } from "bun:test";
import type { CatalogSkill } from "@nouride/wire";
import { skillIsLive } from "../src/modules/skills/pool.list.tsx";
import { answer, overrides, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

type Agent = CatalogSkill["agents"][number];
const agent = (id: string, enabled: boolean, more: Partial<Agent> = {}): Agent => ({ id, displayName: id[0]!.toUpperCase() + id.slice(1), enabled, decided: true, missingTools: [], offered: enabled, ...more });
const skill = (name: string, agents: Agent[], offGlobally = false): CatalogSkill => ({
  name, description: `What ${name} is for`, scope: "shared", path: `/srv/nouride/.nouride/agents/skills/${name}/SKILL.md`,
  requires: [], missing: [], needsTools: [], offGlobally, agents, lastUsedAt: null, reads: 0, readsSinceChange: 0,
});
const CARRIED = skill("pdf-tools", [agent("nouva", true), agent("nix", false)]);
const ON_FOR_NONE = skill("deploy-k8s", [agent("nouva", false), agent("nix", false)]);
// Its agents' own switches are on, kept for when it comes back: given to none all the same.
const OFF_FOR_EVERY = skill("android-adb", [agent("nouva", true, { offered: false }), agent("nix", true, { offered: false })], true);
// On only for a coding CLI that is never given a tool it needs: its switch is on, and it is not given it.
const CLI_ONLY = skill("self-update", [agent("nouva", false), agent("kuro", true, { notForCli: ["nouride"], offered: false })]);

function daemon(skills: CatalogSkill[]) {
  answer({
    "/skills/catalog": { status: 200, body: { skills, software: {}, poolDir: "/srv/skills", editable: true } },
    "/skills/drafts": { status: 200, body: { enabled: true, pending: [], recent: [] } },
  });
}
const tabs = (host: HTMLElement) => [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim());
const tab = (host: HTMLElement, label: string) => ([...host.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.trim().startsWith(label)) as HTMLElement).click();
const rows = (host: HTMLElement) => [...host.querySelectorAll("li")].map((row) => row.querySelector("span.font-medium")?.textContent).filter(Boolean);
/** Typed into a field as a person does: through React's own setter, then an input event. */
const typeInto = (input: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
  input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
};

describe("which skills are live", () => {
  test("given to some agent now, by the daemon's word; an agent's switch on alone does not make it live", () => {
    expect(skillIsLive(CARRIED)).toBe(true);
    expect(skillIsLive(ON_FOR_NONE)).toBe(false);
    expect(skillIsLive(OFF_FOR_EVERY)).toBe(false);
    expect(skillIsLive(CLI_ONLY)).toBe(false);
    expect(skillIsLive({ ...CARRIED, agents: [] })).toBe(false);
  });
});

describe("the Skills Workshop", () => {
  test("opens on Live with what the agents are given, and counts each list on its tab", async () => {
    daemon([CARRIED, ON_FOR_NONE, OFF_FOR_EVERY, CLI_ONLY]);
    let listed: unknown[] = [];
    let named: unknown[] = [];
    const html = await renderPage("/skills", async (host) => {
      await eventually(() => rows(host).length > 0, 3_000, "the list");
      listed = rows(host);
      named = tabs(host);
    });
    expect(named).toEqual(["Live1", "Off3", "Pending0", "Explore"]);
    expect(listed).toEqual(["pdf-tools"]);
    expect(html).toContain("1 skill live");
  });

  test("Off lists the skills no agent is given, says of one off for every agent that it is, and how each comes back", async () => {
    daemon([CARRIED, ON_FOR_NONE, OFF_FOR_EVERY, CLI_ONLY]);
    let listed: unknown[] = [];
    let marked: unknown[] = [];
    let badgeTitle = "";
    const html = await renderPage("/skills", async (host) => {
      await eventually(() => rows(host).length > 0, 3_000, "the list");
      tab(host, "Off");
      await eventually(() => rows(host).includes("deploy-k8s"), 3_000, "the Off list");
      listed = rows(host);
      const badges = [...host.querySelectorAll("li span.badge")].filter((badge) => badge.textContent?.trim() === "Off for every agent");
      marked = badges.map((badge) => badge.closest("li")?.querySelector("span.font-medium")?.textContent);
      badgeTitle = badges[0]?.getAttribute("title") ?? "";
    });
    expect(listed).toEqual(["deploy-k8s", "android-adb", "self-update"]);
    expect(marked).toEqual(["android-adb"]);
    expect(badgeTitle).toContain("power button");
    expect(html).toContain("3 skills turned off");
    expect(html).toContain("One marked Off for every agent comes back with its power button; any other, by switching it on for an agent that can use it.");
  });

  test("the filter narrows the list that is showing, and not the other", async () => {
    // "deploy" names one skill under each list: a filter over the whole pool would show both here.
    daemon([CARRIED, skill("deploy-docs", [agent("nouva", true)]), ON_FOR_NONE, OFF_FOR_EVERY]);
    let listed: unknown[] = [];
    await renderPage("/skills", async (host) => {
      await eventually(() => rows(host).length > 0, 3_000, "the list");
      tab(host, "Off");
      await eventually(() => Boolean(host.querySelector('input[aria-label="Filter skills"]')) && rows(host).includes("android-adb"), 3_000, "the Off list");
      typeInto(host.querySelector('input[aria-label="Filter skills"]') as HTMLInputElement, "deploy");
      await eventually(() => rows(host).length === 1, 3_000, "the Off list narrowed to one");
      listed = rows(host);
    });
    expect(listed).toEqual(["deploy-k8s"]);
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
      overrides["/skills/catalog"] = { status: 200, body: { skills: [CARRIED, skill("deploy-k8s", [agent("nouva", false), agent("nix", true)])], software: {}, poolDir: "/srv/skills", editable: true } };
      ([...host.querySelectorAll("li button")].find((button) => button.getAttribute("title") === "Off for Nix. Click to switch on") as HTMLElement).click();
      await eventually(() => tabs(host).includes("Live2"), 3_000, "the counts after the switch");
      after = { off: rows(host), named: tabs(host) };
    });
    expect(after.named).toEqual(["Live2", "Off0", "Pending0", "Explore"]);
    expect(after.off).toEqual([]);
  });

  test("a skill's text typed and not saved is still there when a switch moves its row to the other list", async () => {
    daemon([CARRIED, ON_FOR_NONE]);
    overrides["/skills/pdf-tools/source"] = { status: 200, body: { name: "pdf-tools", description: "What pdf-tools is for", scope: "shared", path: CARRIED.path, requires: [], missing: [], needsTools: [], source: "---\nname: pdf-tools\n---\nThe saved text.\n" } };
    overrides["/skills/pdf-tools/agents/nouva"] = { status: 200, body: { ok: true, skill: "pdf-tools", agentId: "nouva", enabled: false } };
    let kept = "";
    await renderPage("/skills", async (host) => {
      await eventually(() => rows(host).includes("pdf-tools"), 3_000, "the Live list");
      (host.querySelector('button[aria-label="Read pdf-tools"]') as HTMLElement).click();
      await eventually(() => Boolean(host.querySelector('textarea[aria-label="pdf-tools: the skill\'s text"]')), 3_000, "the editor");
      typeInto(host.querySelector('textarea[aria-label="pdf-tools: the skill\'s text"]') as HTMLTextAreaElement, "---\nname: pdf-tools\n---\nHalf a new paragraph");
      // Taken as typing, not yet saved: Save is pressable.
      await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Save" && !button.disabled), 3_000, "Save pressable");
      // Its last agent switched off: the daemon's next answer has it given to none, and it goes to Off.
      overrides["/skills/catalog"] = { status: 200, body: { skills: [skill("pdf-tools", [agent("nouva", false), agent("nix", false)]), ON_FOR_NONE], software: {}, poolDir: "/srv/skills", editable: true } };
      ([...host.querySelectorAll("li button")].find((button) => button.getAttribute("title")?.startsWith("On for Nouva")) as HTMLElement).click();
      await eventually(() => tabs(host).includes("Off2"), 3_000, "the row moved to Off");
      tab(host, "Off");
      await eventually(() => rows(host).includes("pdf-tools"), 3_000, "the row under Off");
      // Opened again where it is now, as a person who looks for it there does.
      (host.querySelector('button[aria-label="Read pdf-tools"]') as HTMLElement | null)?.click();
      await eventually(() => Boolean(host.querySelector('textarea[aria-label="pdf-tools: the skill\'s text"]')), 3_000, "the editor under Off");
      kept = (host.querySelector('textarea[aria-label="pdf-tools: the skill\'s text"]') as HTMLTextAreaElement).value;
    });
    expect(kept).toBe("---\nname: pdf-tools\n---\nHalf a new paragraph");
  });
});
