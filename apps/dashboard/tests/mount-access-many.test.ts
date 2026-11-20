/**
 * The Access page once a list of thousands was let in from a file: the page is sent the newest five hundred approved
 * and how many there are, says so, and finds one beyond them among everyone when asked to. And the list's one line in
 * the history.
 */

import { expect, test } from "bun:test";
import { answer, press, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const at = Date.now() - 60_000;
const approved = (senderId: string, senderName: string | null = null) => ({ gatewayId: "whatsapp:main", senderId, senderName, status: "approved", code: null, chatId: null, requestedAt: at, expiresAt: null, resolvedAt: at, resolvedBy: "gading" });
const newest = [approved("6281200000001@s.whatsapp.net", "Pak Budi"), approved("6281200000002@s.whatsapp.net")];
const page = (senders: unknown[], approvedTotal: number) => ok({ mode: "pair", editable: true, allowlist: [], senders, approvedTotal });
const said = (host: HTMLElement) => host.querySelector("[data-approved-more]")?.textContent?.replace(/\s+/g, " ").trim() ?? "";

test("with more approved than it was sent, the Approved tab says how many, and finds another among everyone on a press", async () => {
  answer({
    "/access": page(newest, 10_000),
    "/access?q=rina": page([approved("6281200000777@s.whatsapp.net", "Bu Rina")], 10_000),
  });
  const seen = { tab: "", title: "", note: "", dead: true, found: "", foundNote: "", back: "" };
  await renderPage("/access?tab=approved", async (host) => {
    await eventually(() => said(host) !== "", 3_000, "the note");
    seen.tab = [...host.querySelectorAll("button, a")].find((one) => one.textContent?.trim().startsWith("Approved"))?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    seen.title = [...host.querySelectorAll("h2, h3")].find((one) => one.textContent?.startsWith("Approved ("))?.textContent ?? "";
    seen.note = said(host);
    const search = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((one) => one.textContent?.trim() === "Search everyone")!;
    seen.dead = search().disabled;
    // What is typed filters the five hundred it holds: nobody there is called Rina.
    type(host.querySelector<HTMLInputElement>('input[placeholder="Filter senders"]')!, "rina");
    await eventually(() => host.textContent?.includes("Nothing matches") === true && !search().disabled, 2_000, "the filter");
    press(host, "Search everyone");
    await eventually(() => host.textContent?.includes("Bu Rina") === true, 3_000, "the one found among everyone");
    seen.found = host.textContent ?? "";
    seen.foundNote = said(host);
    press(host, "Show the newest");
    await eventually(() => said(host).startsWith("The newest"), 3_000, "the newest again");
    seen.back = said(host);
  });
  expect(seen.tab).toBe("Approved10000");
  expect(seen.title).toBe("Approved (10,000)");
  expect(seen.note).toStartWith("The newest 2 of 10,000 are listed. To find another, type an id or a name in the filter, then search everyone.");
  expect(seen.dead).toBe(true);
  expect(seen.found).toContain("6281200000777@s.whatsapp.net");
  expect(seen.foundNote).toStartWith("Everyone approved whose id or name holds “rina”.");
  expect(seen.back).toStartWith("The newest 2 of 10,000 are listed.");
});

test("with everyone approved on the page, nothing is said of more", async () => {
  answer({ "/access": page(newest, 2) });
  let note = "x";
  await renderPage("/access?tab=approved", async (host) => {
    await eventually(() => host.textContent?.includes("Pak Budi") === true, 3_000, "the list");
    note = said(host);
  });
  expect(note).toBe("");
});

test("a list let in at once is one line of the history, with its counts", async () => {
  answer({
    "/access": page(newest, 2),
    "/access/history": ok({ entries: [{ action: "access_imported", actor: "gading", gatewayId: "whatsapp:main", details: { added: 9950, already: 30, blocked: 2 }, timestamp: at }] }),
  });
  let line = "";
  await renderPage("/access?tab=history", async (host) => {
    await eventually(() => host.textContent?.includes("Let in from a list") === true, 3_000, "the line");
    line = host.querySelector("li")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  });
  expect(line).toContain("A list of senders");
  expect(line).toContain("Let in from a list by gading: 9,950 new, 30 in already, 2 blocked and left out");
});
