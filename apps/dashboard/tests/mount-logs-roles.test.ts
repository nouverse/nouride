/**
 * Who reads what on the Logs page (`modules/logs/index.page.tsx`). The daemon's log and the audit log hold every line
 * of everybody's chats, commands and decisions, so the server answers them to an admin alone. Through the whole app.
 *
 * Each case is a way the page would disagree with the server: a tab offered that opens on a refusal, the page opened
 * on one, or the two logs asked for by an account that will be refused them.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
const signedIn = (role: string) => ({ "/auth/me": ok({ ...ME, role, user: { ...ME.user, role } }) });
const REFUSED = { status: 403, body: { error: "admin only", plain: "Only an admin can read the logs." } };

const tabs = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('main [role="tab"]')];
const picked = (host: HTMLElement) => tabs(host).find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ?? null;

/** Which of the control API's paths the page asked for while it was drawn. */
function asked(): { paths: string[]; restore: () => void } {
  const paths: string[] = [];
  const harness = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input : input.url), "http://localhost");
    if (url.pathname.startsWith("/api/control/")) paths.push(url.pathname.slice("/api/control".length));
    return harness(input, init);
  }) as typeof fetch;
  return { paths, restore: () => void (globalThis.fetch = harness) };
}

describe("the Logs page", () => {
  test("an admin has the four records, and the page opens on the daemon's log", async () => {
    const seen = { tabs: [] as string[], on: null as string | null, says: "" };
    await renderPage("/logs", async (host) => {
      await eventually(() => tabs(host).length > 0, 3_000, "the tabs");
      seen.tabs = tabs(host).map((tab) => tab.textContent ?? "");
      seen.on = picked(host);
      seen.says = host.querySelector("main")?.textContent ?? "";
    });
    expect(seen.tabs).toEqual(["Daemon", "Audit", "Schedule", "Helpers"]);
    expect(seen.on).toBe("Daemon");
    expect(seen.says).toContain("For whoever runs the server");
  });

  for (const role of ["operator", "viewer"]) {
    test(`a ${role} has what ran on a schedule and what still runs, opens on the first, and is never sent for the two logs`, async () => {
      // As the server answers such an account: were the page to ask, the test would see the refusal drawn.
      answer({ ...signedIn(role), "/logs/stored": REFUSED, "/audit": REFUSED });
      const seen = { tabs: [] as string[], on: null as string | null, says: "", after: null as string | null };
      const record = asked();
      try {
        await renderPage("/logs", async (host) => {
          await eventually(() => tabs(host).length > 0, 3_000, "the tabs");
          seen.tabs = tabs(host).map((tab) => tab.textContent ?? "");
          seen.on = picked(host);
          seen.says = host.querySelector("main")?.textContent ?? "";
          tabs(host)
            .find((tab) => tab.textContent === "Helpers")!
            .click();
          await eventually(() => picked(host) === "Helpers", 2_000, "the other tab");
          seen.after = picked(host);
        });
      } finally {
        record.restore();
      }
      expect(seen.tabs).toEqual(["Schedule", "Helpers"]);
      expect(seen.on).toBe("Schedule");
      expect(seen.after).toBe("Helpers");
      expect(seen.says).not.toContain("For whoever runs the server");
      expect(seen.says).not.toContain("Only an admin can read the logs.");
      expect(record.paths.filter((path) => path === "/logs/stored" || path === "/audit" || path === "/logs")).toEqual([]);
    });
  }
});
