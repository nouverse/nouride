/**
 * A success's own words, said in the page's (0.8.23). Some routes answer a success with words of their own the page
 * shows: a sender approved but not linked, the model's tag groups that failed the checks, what an install from a hub came
 * to, why web search is not working. Those are written for the command line, a file's or a setting's name among them,
 * so each route answers the page's words beside them as `plain`; the page says those, and folds the route's own under
 * Details or leaves them for whoever runs the server. In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, buttons, press, recordPosts, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });

test("Access: approved but not linked says so in the page's words, not the server's reason", async () => {
  const now = Date.now();
  answer({
    "/access": ok({
      mode: "pair",
      editable: true,
      allowlist: [],
      senders: [{ gatewayId: "telegram:nouva", senderId: "814", senderName: "Sam", status: "pending", code: "ABC123", chatId: "814", requestedAt: now, expiresAt: now + 600_000, resolvedAt: null, resolvedBy: null }],
    }),
  });
  let toast = "";
  await renderPage("/access", async (host) => {
    await eventually(() => buttons(host).includes("Approve"), 2_000, "the pending sender");
    const record = recordPosts({
      "/access/approve": ok({ ok: true, warning: 'approved, but not linked: no person "ghost"', plain: "Approved, but not linked to the person you chose. Whoever runs the server can see why." }),
    });
    press(host, "Approve");
    await eventually(() => document.body.textContent?.includes("not linked to the person you chose") === true, 2_000, "the toast");
    toast = document.body.textContent ?? "";
    record.restore();
  });
  expect(toast).toContain("Approved, but not linked to the person you chose.");
  expect(toast).not.toContain('no person "ghost"');
});

test("Memory, Tidy tags: the model's groups that failed the checks are said in the page's words, not the checks'", async () => {
  answer({ "/memory/tags/tidy": ok({ changes: [], tags: 4, once: 0, last: null }) });
  let toast = "";
  await renderPage("/memories", async (host) => {
    await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Tidy tags") && !button.disabled), 2_000, "Tidy tags");
    ([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Tidy tags")) as HTMLElement).click();
    // Over the page, outside it.
    await eventually(() => buttons(document.body).some((label) => label.includes("Also ask the model")), 2_000, "the review dialog");
    const record = recordPosts({
      "/memory/tags/tidy/model": ok({
        changes: [],
        dropped: [{ from: ["no-such-tag"], into: "homelab", why: "not in use: no-such-tag" }],
        readable: true,
        plain: "Some of the groups it proposed named tags that are not in use or were already grouped. Try again, or set a stronger model for the pass.",
      }),
    });
    ([...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Also ask the model")) as HTMLElement).click();
    await eventually(() => document.body.textContent?.includes("none passed the checks") === true, 2_000, "the toast");
    toast = document.body.textContent ?? "";
    record.restore();
  });
  expect(toast).toContain("Some of the groups it proposed named tags that are not in use or were already grouped.");
  expect(toast).not.toContain("not in use: no-such-tag");
});

test("Skills, Explore: an install says what it came to in the page's words, the hub's own under a closed Details", async () => {
  answer({
    "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }),
    "/skills/hub/popular": ok({ hits: [{ ref: "github:o/r", source: "github", name: "r", description: "two skills", url: "https://github.com/o/r" }] }),
  });
  let said = "";
  let folded = false;
  await renderPage("/skills", async (host) => {
    ([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes("Explore")) as HTMLElement).click();
    await eventually(() => buttons(host).some((label) => label.includes("Install")), 2_000, "a hit to install");
    const record = recordPosts({
      "/skills/hub/install": ok({
        ok: false,
        drafts: [],
        refused: [{ name: "notes", reason: "it has no SKILL.md" }],
        notes: ["o/r has 12 skills; the first 10 were taken. Name a path for the others."],
        plain: "Nothing was added to Pending. One was left out. Not everything there was taken. Why is under Details.",
      }),
    });
    ([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Install")) as HTMLElement).click();
    await eventually(() => (host.textContent ?? "").includes("Nothing was added to Pending."), 2_000, "the outcome");
    said = host.textContent ?? "";
    folded = [...host.querySelectorAll("details")].some((one) => one.textContent?.includes("it has no SKILL.md") && !one.hasAttribute("open"));
    record.restore();
  });
  expect(said).toContain("Nothing was added to Pending. One was left out. Not everything there was taken. Why is under Details.");
  // The hub's words, a file's name among them, folded under Details rather than said.
  expect(folded).toBe(true);
});

test("Web Search: a search that is not working says what it needs in the page's words, the settings file's under a closed Details", async () => {
  const saved = WIRE["/web-search"] as Record<string, unknown>;
  const problem = '[security.web] search_kind = "searxng" needs a search_endpoint: it has no public default.';
  answer({ "/web-search": { status: 200, body: { ...saved, mode: "searxng", endpoint: "", effective: "unavailable", problem, plain: "It needs the address of your search service." } } });
  let folded = false;
  const html = await renderPage("/web-search", async (host) => {
    const details = [...host.querySelectorAll("details")].find((one) => one.textContent?.includes("search_endpoint"));
    folded = details !== undefined && !details.hasAttribute("open");
  });
  expect(html).toContain("It needs the address of your search service.");
  // There, and folded: not what the page says.
  expect(folded).toBe(true);
});
