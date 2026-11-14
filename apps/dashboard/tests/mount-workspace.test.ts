/**
 * The agents' workspace in the dashboard, drawn against a stand-in for the daemon's answers: the Workspace tab beside
 * Agents and Office over all of it, an agent's Workspace tab over that agent's own folder, and the way there from the
 * agent's page. Each is the files view held to its folder: what it asks the daemon is held there too, the way back
 * ends there, and an address outside it shows the folder itself. For an admin, as System's Files is.
 */

import { describe, expect, test } from "bun:test";
import { crumbsUnder, heldTo, within } from "@/commons/lib/files/paths";
import { agentFolder, WORKSPACE_FOLDERS } from "@/modules/agents/lib/workspace";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const text = (host: HTMLElement) => (host.textContent ?? "").replace(/\s+/g, " ");
const drawn = (host: HTMLElement, words: string) => eventually(() => text(host).includes(words), 3_000, words);
const names = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-files-browser] ul > li span.font-medium")].map((name) => name.textContent ?? "");
const where = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('nav[aria-label="Where you are"] button, nav[aria-label="Where you are"] [aria-current="page"]')].map((step) => step.textContent?.trim() ?? "");
const row = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>("[data-files-browser] ul > li button")].find((button) => button.textContent?.includes(name))!;
const crumb = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Where you are"] button')].find((button) => button.textContent?.trim() === name)!;

const folder = (path: string) => ({ name: path.split("/").pop()!, path, kind: "folder", sizeBytes: null, modifiedAt: Date.now() - 60_000 });
const file = (path: string) => ({ name: path.split("/").pop()!, path, kind: "file", sizeBytes: 2048, modifiedAt: Date.now() - 7_200_000, removable: true });
const listing = (path: string, entries: object[], more = 0) => ({ status: 200, body: { path, entries, more, leftOut: false } });

/** A workspace with more beside `private` and `shared` than the tab shows, and two agents' folders under `private`. */
const FILES = {
  "/system/files/workspace": { status: 200, body: { path: "workspace" } },
  "/system/files?path=workspace&root=workspace": listing("workspace", [folder("workspace/private"), folder("workspace/shared"), folder("workspace/shots"), file("workspace/notes.md")], 1200),
  "/system/files?path=workspace/private&root=workspace": listing("workspace/private", [folder("workspace/private/nix"), folder("workspace/private/nouva")]),
  "/system/files?path=workspace/private/nouva&root=workspace/private/nouva": listing("workspace/private/nouva", [folder("workspace/private/nouva/drafts"), file("workspace/private/nouva/plan.md")]),
  "/system/files?path=workspace/private/nouva/drafts&root=workspace/private/nouva": listing("workspace/private/nouva/drafts", [file("workspace/private/nouva/drafts/one.md")]),
};

/** Every listing the page asked the daemon for, as its address said it. */
async function asking<T>(run: (asked: string[]) => Promise<T>): Promise<T> {
  const asked: string[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.startsWith("/api/control/system")) asked.push(`${url.pathname.replace("/api/control", "")}${decodeURIComponent(url.search)}`);
    return (spy as typeof fetch)(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = spy;
  }
}

const operator = () => {
  const me = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
  return { "/auth/me": { status: 200, body: { ...me, role: "operator", user: { ...me.user, role: "operator" } } } };
};

describe("a files view held to one folder", () => {
  const root = { path: "workspace/private/nouva", name: "Nouva's folder" };

  test("is where its address says inside the folder, and the folder itself for anything outside it", () => {
    expect(heldTo("workspace/private/nouva/drafts", root)).toBe("workspace/private/nouva/drafts");
    expect(heldTo("workspace/private/nouva", root)).toBe("workspace/private/nouva");
    // Nothing named yet, the folder above, another agent's, one whose name only begins the same.
    expect(["", "workspace/private", "workspace/private/nix", "workspace/private/nouva2/x", "data"].map((path) => heldTo(path, root))).toEqual(Array(5).fill("workspace/private/nouva"));
    // No folder holds System's Files: it is wherever it was asked to be, the top included.
    expect(["", "data"].map((path) => heldTo(path, undefined))).toEqual(["", "data"]);
    expect([within("workspace/shared/a", "workspace"), within("workspace", "workspace"), within("workspaces", "workspace"), within("data", "workspace")]).toEqual([true, true, false, false]);
  });

  test("names the folders on the way from the folder down, and none above it", () => {
    expect(crumbsUnder("workspace/private/nouva/drafts/one.md", root)).toEqual([
      { name: "drafts", path: "workspace/private/nouva/drafts" },
      { name: "one.md", path: "workspace/private/nouva/drafts/one.md" },
    ]);
    expect(crumbsUnder("workspace/private/nouva", root)).toEqual([]);
    expect(crumbsUnder("workspace/private", undefined).map((crumb) => crumb.name)).toEqual(["workspace", "private"]);
  });

  test("an agent's own folder is under the workspace's private one, and the tab over all of it goes into two", () => {
    expect(agentFolder("workspace", "nouva")).toBe("workspace/private/nouva");
    expect([...WORKSPACE_FOLDERS]).toEqual(["private", "shared"]);
  });
});

describe("the Workspace tab beside Agents and Office", () => {
  test("opens on the workspace, lists private and shared alone, goes into them, and its way back ends at the workspace", async () => {
    answer(FILES);
    await asking(async (asked) => {
      await renderPage("/workspace", async (host, app) => {
        await drawn(host, "shared");
        expect(host.querySelector('[data-workspace="all"]')).not.toBeNull();
        // The workspace is the top: named for what it is, with nothing above it to press.
        expect(where(host)).toEqual(["Workspace"]);
        expect(text(host)).not.toContain("Nouride's files");
        // `shots` and `notes.md` are kept beside the two, and are not this page's to show; nor is a count of them.
        expect(names(host)).toEqual(["private", "shared"]);
        expect(text(host)).not.toContain("more here");
        row(host, "private").click();
        await eventually(() => app.location() === "/workspace" && (app.search() as { path?: string }).path === "workspace/private", 3_000, "the folder's address");
        await drawn(host, "nouva");
        // Below the top, everything there.
        expect(names(host)).toEqual(["nix", "nouva"]);
        expect(where(host)).toEqual(["Workspace", "private"]);
        crumb(host, "Workspace").click();
        await eventually(() => (app.search() as { path?: string }).path === "workspace", 3_000, "back at the workspace");
        await eventually(() => names(host).join() === "private,shared", 3_000, "the two folders again");
      });
      // Every listing was asked held to the workspace, so the daemon refuses what the page should never ask.
      expect(asked.filter((ask) => ask.startsWith("/system/files?"))).toEqual(["/system/files?path=workspace&root=workspace", "/system/files?path=workspace/private&root=workspace"]);
    });
  });

  test("an address outside the workspace shows the workspace, and the daemon is never asked for what it named", async () => {
    answer(FILES);
    await asking(async (asked) => {
      for (const outside of ["data", "config.toml", "workspaces"]) {
        await renderPage(`/workspace?path=${outside}`, async (host) => {
          await drawn(host, "shared");
          expect(where(host)).toEqual(["Workspace"]);
          expect(names(host)).toEqual(["private", "shared"]);
        });
      }
      expect([...new Set(asked.filter((ask) => ask.startsWith("/system/files?")))]).toEqual(["/system/files?path=workspace&root=workspace"]);
    });
  });

  test("is among the section's tabs for an admin, marked as the page; anyone else has no such tab and is told it is an admin's", async () => {
    answer(FILES);
    const tabs = (host: HTMLElement) => [...host.ownerDocument.querySelectorAll<HTMLAnchorElement>("main a")].filter((link) => ["/dashboard/agents", "/dashboard/office", "/dashboard/workspace"].includes(link.getAttribute("href") ?? ""));
    await renderPage("/workspace", async (host) => {
      await drawn(host, "shared");
      expect(tabs(host).map((tab) => tab.textContent)).toEqual(["Agents", "Office", "Workspace"]);
      expect(tabs(host).find((tab) => tab.getAttribute("aria-current") === "page")?.textContent).toBe("Workspace");
      // Agents in the menu is the page you are on.
      const menu = [...host.ownerDocument.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Menu"] a')].filter((link) => link.getAttribute("href") === "/dashboard/agents");
      expect(menu.some((link) => link.getAttribute("aria-current") === "page")).toBe(true);
    });
    answer({ ...FILES, ...operator() });
    await asking(async (asked) => {
      await renderPage("/office", async (host) => {
        await eventually(() => tabs(host).length > 0, 3_000, "the section's tabs");
        expect(tabs(host).map((tab) => tab.textContent)).toEqual(["Agents", "Office"]);
      });
      await renderPage("/workspace", async (host) => {
        await drawn(host, "For an admin");
      });
      expect(asked).toEqual([]);
    });
  });

  test("a server that keeps the workspace apart from Nouride's files says so, and lists nothing", async () => {
    answer({ ...FILES, "/system/files/workspace": { status: 200, body: { path: null } } });
    await asking(async (asked) => {
      await renderPage("/workspace", async (host) => {
        await drawn(host, "Not shown here");
        expect(host.querySelector("[data-files-browser]")).toBeNull();
      });
      expect(asked).toEqual(["/system/files/workspace"]);
    });
  });
});

describe("an agent's Workspace tab", () => {
  const tab = (host: HTMLElement) => [...host.ownerDocument.querySelectorAll<HTMLAnchorElement>("main a")].find((link) => link.getAttribute("href")?.startsWith("/dashboard/agents/nouva/workspace"));

  test("shows that agent's own folder, named for the agent, goes down into it, and never above or beside it", async () => {
    answer(FILES);
    await asking(async (asked) => {
      await renderPage("/agents/nouva/workspace", async (host, app) => {
        await drawn(host, "plan.md");
        expect(host.querySelector('[data-workspace="agent"]')).not.toBeNull();
        // The last of the agent's tabs, and the one you are on.
        const tabs = [...host.ownerDocument.querySelectorAll<HTMLAnchorElement>("main a")].filter((link) => /^\/dashboard\/agents\/nouva(\/[a-z]+)?(\?|$)/.test(link.getAttribute("href") ?? ""));
        expect(tabs.at(-1)).toBe(tab(host)!);
        expect(tab(host)!.textContent).toBe("Workspace");
        expect(tabs.filter((link) => link.getAttribute("aria-current") === "page")).toEqual([tab(host)!]);
        // Its folder is the top: `workspace` and `private` are not on the way, so they are not a press away.
        expect(where(host)).toEqual(["Nouva's folder"]);
        expect(names(host)).toEqual(["drafts", "plan.md"]);
        row(host, "drafts").click();
        await eventually(() => (app.search() as { path?: string }).path === "workspace/private/nouva/drafts", 3_000, "the folder's address");
        await drawn(host, "one.md");
        expect(app.location()).toBe("/agents/nouva/workspace");
        expect(where(host)).toEqual(["Nouva's folder", "drafts"]);
        crumb(host, "Nouva's folder").click();
        await eventually(() => (app.search() as { path?: string }).path === "workspace/private/nouva", 3_000, "back at its folder");
      });
      expect(asked.filter((ask) => ask.startsWith("/system/files?"))).toEqual([
        "/system/files?path=workspace/private/nouva&root=workspace/private/nouva",
        "/system/files?path=workspace/private/nouva/drafts&root=workspace/private/nouva",
      ]);
    });
  });

  test("another agent's folder, the folder above and the top, written into the address, all show this agent's own", async () => {
    answer(FILES);
    await asking(async (asked) => {
      for (const outside of ["workspace/private/nix", "workspace/private", "workspace", "data"]) {
        await renderPage(`/agents/nouva/workspace?path=${outside}`, async (host) => {
          await drawn(host, "plan.md");
          expect(where(host)).toEqual(["Nouva's folder"]);
        });
      }
      expect([...new Set(asked.filter((ask) => ask.startsWith("/system/files?")))]).toEqual(["/system/files?path=workspace/private/nouva&root=workspace/private/nouva"]);
    });
  });

  test("is an admin's: anyone else's agent page has no such tab, and its address says it is an admin's and asks nothing", async () => {
    answer({ ...FILES, ...operator() });
    await asking(async (asked) => {
      await renderPage("/agents/nouva", async (host) => {
        await eventually(() => [...host.ownerDocument.querySelectorAll("main a")].some((link) => link.getAttribute("href") === "/dashboard/agents/nouva/model"), 3_000, "the agent's tabs");
        expect(tab(host)).toBeUndefined();
      });
      await renderPage("/agents/nouva/workspace", async (host) => {
        await drawn(host, "For an admin");
      });
      expect(asked).toEqual([]);
    });
  });
});
