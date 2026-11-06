/**
 * A coding CLI's agent on the Skills page (0.8.13): Kuro, Nix and Nox wore a yellow "!" on the `nouride` skill, telling
 * the person to add a tool no coding CLI is ever given. Such a skill is not theirs — a quiet mark with why — while an
 * agent Nouride runs itself that lacks a tool still gets the warning: a pack edit gives it the tool. In a file of its
 * own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { overrides, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const row = (id: string, displayName: string, extra: Record<string, unknown> = {}) => ({ id, displayName, enabled: true, decided: false, missingTools: [], ...extra });

test("never given a tool the skill needs: a quiet mark, not a yellow \"!\" to fix", async () => {
  const nouride = {
    name: "nouride", description: "Run Nouride itself", scope: "builtin", path: "/srv/nouride/skills/nouride/SKILL.md", requires: [], missing: [],
    needsTools: ["nouride"], offGlobally: false, lastUsedAt: null,
    agents: [row("nouva", "Nouva"), row("kuro", "Kuro", { notForCli: ["nouride"] }), row("nero", "Nero", { missingTools: ["nouride"] })],
  };
  overrides["/skills/catalog"] = { status: 200, body: { skills: [nouride], software: {}, poolDir: "/srv/skills", editable: true } };
  const html = await renderPage("/skills", async (host) => {
    ([...host.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes("Live")) as HTMLElement).click();
    await eventually(() => (host.textContent ?? "").includes("Run Nouride itself"), 2_000, "the Live list");
  });
  expect(html).toContain('title="Kuro answers through a coding CLI, which is never given nouride: this skill is not given to it."');
  expect(html).toContain("Nero has this skill but not nouride, so it will fail partway through.");
  expect(html).not.toContain("Kuro has this skill but not");
});
