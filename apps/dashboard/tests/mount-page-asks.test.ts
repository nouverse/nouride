/**
 * "Ask Nouva" on every page that has a job a person can hand to the orchestrator: a button in the page's header that
 * opens the floating chat on that page, with the orchestrator and the page's request already written in the box, for
 * the person to finish and send. The page stays where it is, and nothing is sent from it. A viewer, who can send
 * nothing, sees none; nor does a box with no orchestrator.
 *
 * Which page draws which request is read from the source, not listed here: each request in `PAGE_ASKS` is found in the
 * page that names it, and the page's address in the route that draws it. A request renamed, or moved to another page,
 * is still checked, and one that no page draws fails by its name.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { answer, recordPosts, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { AT_REST, boxIn, card } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

useMountHarness();

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A route file's address: `agents.index.tsx` is `/agents`, `memories_.graph.tsx` is `/memories/graph`; none for one with a parameter. */
function addressOf(routeFile: string): string | null {
  const parts = routeFile.replace(/\.tsx$/, "").split(".").map((part) => part.replace(/_$/, ""));
  if (parts.some((part) => part.startsWith("$") || part.startsWith("__"))) return null;
  return `/${parts.filter((part) => part !== "index").join("/")}`;
}

const ROUTES = readdirSync(join(SRC, "routes")).map((file) => ({ address: addressOf(file), code: readFileSync(join(SRC, "routes", file), "utf8") }));

/** The addresses of the pages that name `PAGE_ASKS.<key>`: the routes that import a page whose source does. */
function pagesAsking(key: string): string[] {
  const named = new RegExp(`\\bPAGE_ASKS\\.${key}\\b`);
  const pages = sources(join(SRC, "modules")).filter((path) => named.test(readFileSync(path, "utf8")));
  const specifiers = pages.map((path) => `@/${relative(SRC, path).split("\\").join("/").replace(/\.tsx?$/, "")}`);
  return ROUTES.filter((route) => route.address !== null && specifiers.some((specifier) => route.code.includes(`"${specifier}"`))).map((route) => route.address!);
}

const status = WIRE["/status"] as Record<string, unknown>;
const me = WIRE["/auth/me"] as { user: Record<string, unknown> };
const asViewer = { "/auth/me": { status: 200, body: { ...me, role: "viewer", user: { ...me.user, role: "viewer" } } } };

/** The header's ask button: what it says, and its title for a phone, where it says only who. */
const askButton = (host: HTMLElement) => [...host.querySelectorAll("header button")].find((button) => button.textContent?.trim().startsWith("Ask ")) as HTMLButtonElement | undefined;

const KEYS = Object.keys(PAGE_ASKS) as (keyof typeof PAGE_ASKS)[];

describe("Ask Nouva on each page", () => {
  test("the addresses are read from the source: a page's request is found where a person would open it", () => {
    expect(addressOf("agents.index.tsx")).toBe("/agents");
    expect(addressOf("memories_.graph.tsx")).toBe("/memories/graph");
    expect(addressOf("index.tsx")).toBe("/");
    expect(addressOf("agents.$agentId.model.tsx")).toBeNull();
    expect(addressOf("__root.tsx")).toBeNull();
    expect(KEYS.length).toBeGreaterThan(10);
    // Every request is some page's: one that no page draws would be words nobody can reach.
    expect(KEYS.filter((key) => pagesAsking(key).length === 0)).toEqual([]);
  });

  for (const key of KEYS) {
    for (const path of pagesAsking(key)) {
      test(`${path}: opens the chat over the page, with the orchestrator and the page's request in the box, nothing sent`, async () => {
        answer(AT_REST);
        const posted = recordPosts();
        try {
          await renderPage(path, async (host, app) => {
            await eventually(() => askButton(host) !== undefined, 2_000, "the ask button");
            const ask = askButton(host)!;
            expect(ask.getAttribute("title")).toBe(`Ask Nouva ${PAGE_ASKS[key].task}`);
            // On a phone it says only who; the rest is from sm up.
            const words = ask.textContent?.replace(/\s+/g, " ").trim() ?? "";
            expect(words).toContain("Ask Nouva");
            expect(words).toContain(PAGE_ASKS[key].task);
            // A button, not a link away: there is nowhere it goes.
            expect(host.querySelector('header a[href*="/chat"]')).toBeNull();

            ask.click();
            await eventually(() => boxIn(card())?.value === PAGE_ASKS[key].message, 3_000, "the page's request in the box");
            expect(card()!.getAttribute("aria-label")).toBe("Chat with Nouva");
            expect(boxIn(card())!.getAttribute("placeholder")).toBe("Message Nouva…");
            // The page asked about is still the page.
            expect(app.location()).toBe(path);
          });
          expect(posted.posts.filter((post) => post.path === "/chat/send")).toEqual([]);
        } finally {
          posted.restore();
        }
      });
    }
  }

  test("a viewer, who can send nothing, is not offered it; nor is a box with no orchestrator", async () => {
    const [path] = pagesAsking("agents");
    answer({ ...AT_REST, ...asViewer });
    let viewer: HTMLButtonElement | undefined;
    await renderPage(path!, async (host) => {
      await eventually(() => host.querySelector("main")?.textContent?.includes("Nix") === true, 2_000, "the page, with its agents");
      viewer = askButton(host);
    });
    expect(viewer).toBeUndefined();
    answer({ "/status": { status: 200, body: { ...status, orchestrator: null } } });
    let none: HTMLButtonElement | undefined;
    await renderPage(path!, async (host) => {
      await eventually(() => host.querySelector("main")?.textContent?.includes("Nouva") === true, 2_000, "the page, with its agents");
      none = askButton(host);
    });
    expect(none).toBeUndefined();
  });
});
