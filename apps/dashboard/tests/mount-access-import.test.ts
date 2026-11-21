/**
 * "Let in a list" on the Access page's Approved tab: a list pasted for one connection, checked first with nothing
 * written, then let in, by an admin. The daemon reads the lines: the page sends the list as it was written.
 */

import { describe, expect, test } from "bun:test";
import type { AccessImported } from "@nouride/wire";
import { HOW_TO_WRITE, checkSaid, letInSaid } from "@/modules/access/import-words";
import { answer, press, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const LISTING = ok({ mode: "pair", editable: true, allowlist: [], senders: [], approvedTotal: 0 });
const GATEWAYS = ok({
  editable: true,
  gateways: [
    { id: "whatsapp:main", platform: "whatsapp", name: "main", agent: "nouva", enabled: true, status: "connected" },
    { id: "telegram:nouva", platform: "telegram", name: "nouva", agent: "nouva", enabled: true, status: "connected" },
    { id: "discord:off", platform: "discord", name: "off", agent: "nouva", enabled: false, status: null },
  ],
});
const result = (over: Partial<AccessImported> = {}): AccessImported => ({ gateway: "whatsapp:main", dryRun: true, read: 5, added: 2, already: 1, blocked: 0, duplicates: 1, invalid: { count: 1, examples: ["0812 0000 0003"] }, ...over });
const dialog = (host: HTMLElement) => host.ownerDocument.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Let in a list"]');
const pressIn = (box: HTMLElement, label: string) => ([...box.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as HTMLElement).click();

describe("the words", () => {
  test("a check says who would be let in first, then everything left out and why", () => {
    expect(checkSaid(result({ added: 1200, already: 3, blocked: 1, duplicates: 2, invalid: { count: 7, examples: ["0812…", "ab", "x", "y", "z", "q"] } }))).toEqual([
      "1,200 people would be let in.",
      "3 are in already.",
      "1 is blocked and stays out.",
      "2 lines name somebody twice.",
      "7 lines could not be read: 0812…, ab, x, y, z, ….",
    ]);
    expect(checkSaid(result({ added: 1, already: 1, blocked: 2, duplicates: 1, invalid: { count: 1, examples: ["ab"] } }))).toEqual([
      "1 person would be let in.",
      "1 is in already.",
      "2 are blocked and stay out.",
      "1 line names somebody twice.",
      "1 line could not be read: ab.",
    ]);
    expect(checkSaid(result({ added: 0, already: 5, duplicates: 0, invalid: { count: 0, examples: [] } }))).toEqual(["Nobody new is on this list.", "5 are in already."]);
    expect(letInSaid(result({ added: 1200, dryRun: false }))).toBe("1,200 people let in on whatsapp:main");
  });

  test("how a line is written is said for each kind of connection, with no command in it", () => {
    for (const how of Object.values(HOW_TO_WRITE)) expect(`${how.line} ${how.example}`).not.toMatch(/nouride |--|config\.toml/);
    expect(HOW_TO_WRITE.whatsapp.line).toContain("with its country code");
    expect(HOW_TO_WRITE.telegram.line).toContain("A phone number cannot be used");
  });
});

describe("the panel", () => {
  test("a list is checked first, with nothing let in, and let in on a second press as it was checked", async () => {
    answer({ "/access": LISTING, "/gateways": GATEWAYS });
    const { posts, restore } = recordPosts({ "/access/import": ok(result()) });
    const seen = { connections: "", hint: "", check: [] as string[], first: "", after: "", closed: false };
    try {
      await renderPage("/access?tab=approved", async (host) => {
        await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Let in a list" && !button.disabled), 3_000, "the button");
        press(host, "Let in a list");
        await eventually(() => dialog(host) !== null, 2_000, "the panel");
        const box = dialog(host)!;
        seen.hint = box.querySelector("label span")?.textContent ?? "";
        // Nothing to check yet.
        seen.first = [...box.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "Check the list").map((button) => String(button.disabled)).join();
        type(box.querySelector("textarea")!, "+62 812 0000 0001, Bu Rina\n62 813 0000 0002\n0812 0000 0003");
        await eventually(() => [...box.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "Check the list" && !button.disabled), 2_000, "the check");
        pressIn(box, "Check the list");
        await eventually(() => box.querySelector("[data-import-check]") !== null, 3_000, "what the check said");
        seen.check = [...box.querySelectorAll("[data-import-check] li")].map((line) => line.textContent ?? "");
        pressIn(box, "Let 2 in");
        await eventually(() => dialog(host) === null, 3_000, "the panel closed");
        seen.closed = true;
      });
    } finally {
      restore();
    }
    expect(seen.hint).toStartWith("One phone number a line, with its country code.");
    expect(seen.first).toBe("true");
    expect(seen.check).toEqual(["2 people would be let in.", "1 is in already.", "1 line names somebody twice.", "1 line could not be read: 0812 0000 0003."]);
    const sent = posts.filter((post) => post.path === "/access/import").map((post) => post.body);
    const text = "+62 812 0000 0001, Bu Rina\n62 813 0000 0002\n0812 0000 0003";
    expect(sent).toEqual([
      { gateway: "whatsapp:main", text, dryRun: true },
      { gateway: "whatsapp:main", text, dryRun: false },
    ]);
    expect(seen.closed).toBe(true);
  });

  test("a list changed after its check asks for a new check before anybody is let in", async () => {
    answer({ "/access": LISTING, "/gateways": GATEWAYS });
    const { posts, restore } = recordPosts({ "/access/import": ok(result()) });
    let offered: string[] = [];
    try {
      await renderPage("/access?tab=approved", async (host) => {
        await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Let in a list" && !button.disabled), 3_000, "the button");
        press(host, "Let in a list");
        await eventually(() => dialog(host) !== null, 2_000, "the panel");
        const box = dialog(host)!;
        type(box.querySelector("textarea")!, "62 813 0000 0002");
        await eventually(() => [...box.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "Check the list" && !button.disabled), 2_000, "the check");
        pressIn(box, "Check the list");
        await eventually(() => [...box.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Let 2 in"), 3_000, "the offer");
        type(box.querySelector("textarea")!, "62 813 0000 0002\n62 813 0000 0009");
        await eventually(() => ![...box.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Let 2 in"), 2_000, "the offer gone");
        offered = [...box.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "").filter((label) => label.startsWith("Let ") || label === "Check the list");
      });
    } finally {
      restore();
    }
    expect(offered).toEqual(["Check the list"]);
    expect(posts.filter((post) => post.path === "/access/import").map((post) => (post.body as { dryRun: boolean }).dryRun)).toEqual([true]);
  });

  test("only an admin is offered it, and only connections that run take a list", async () => {
    answer({ "/access": LISTING, "/gateways": GATEWAYS, "/auth/me": ok({ kind: "user", role: "operator", actor: "sam", user: { id: "usr_2", username: "sam", displayName: "", role: "operator", createdAt: 1, updatedAt: 1, mustChangePassword: false, lastLoginAt: null, hasPassword: true } }) });
    let operator = true;
    await renderPage("/access?tab=approved", async (host) => {
      await eventually(() => host.textContent?.includes("Nobody approved yet") === true, 3_000, "the tab");
      operator = [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Let in a list");
    });
    expect(operator).toBe(false);

    answer({ "/access": LISTING, "/gateways": GATEWAYS });
    let options: string[] = [];
    await renderPage("/access?tab=approved", async (host) => {
      await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Let in a list" && !button.disabled), 3_000, "the button");
      press(host, "Let in a list");
      await eventually(() => dialog(host) !== null, 2_000, "the panel");
      const pick = [...dialog(host)!.querySelectorAll<HTMLElement>("button")].find((button) => button.getAttribute("aria-haspopup") !== null || button.textContent?.includes("whatsapp:main"))!;
      pick.click();
      await eventually(() => host.ownerDocument.body.querySelectorAll('[role="option"]').length > 0, 2_000, "the connections");
      options = [...host.ownerDocument.body.querySelectorAll('[role="option"]')].map((row) => row.textContent?.trim() ?? "");
    });
    expect(options).toEqual(["whatsapp:main", "telegram:nouva"]);
  });
});
