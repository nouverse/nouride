/**
 * The System page and its Files tab, drawn against a stand-in for the daemon's answers: what each bar says in words,
 * what is said where a figure is missing, which build this is and the way to a newer one, a folder's rows and what a
 * press on one does, a file shown as what it is, a copy of it kept, what agents left behind deleted once asked, and
 * each refusal's sentence. For an admin: anyone else sees that it is an admin's, and nothing is asked.
 */

import { describe, expect, test } from "bun:test";
import { answer, buttons, dom, recordPosts, renderPage, RESPONSES, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const GiB = 1024 ** 3;
const SYSTEM = RESPONSES["/system"] as { memory: Record<string, unknown>; disk: unknown } & Record<string, unknown>;
const text = (host: HTMLElement) => (host.textContent ?? "").replace(/\s+/g, " ");
const meter = (host: HTMLElement, label: string) => host.querySelector<HTMLElement>(`[role="meter"][aria-label="${label}"]`);
const drawn = (host: HTMLElement, words: string) => eventually(() => text(host).includes(words), 3_000, words);

describe("System", () => {
  test("RAM, the disk and Nouride here, each a bar with its words: a limit set for Nouride, who holds what, the folder's largest", async () => {
    answer({ "/system/folder-sizes": { status: 200, body: { ...(RESPONSES["/system/folder-sizes"] as object), measuredAt: Date.now() - 3 * 60_000 } } });
    await renderPage("/system", async (host) => {
      await drawn(host, "2.1 GB of 6.0 GB in use");
      expect(meter(host, "RAM in use")!.getAttribute("aria-valuenow")).toBe("35");
      expect(meter(host, "RAM in use")!.getAttribute("aria-valuetext")).toBe("2.1 GB of 6.0 GB in use");
      expect(text(host)).toContain("The ceiling is a limit set for Nouride here. The machine it runs on has 8.0 GB.");
      expect(text(host)).toContain("Nouride itself412.0 MB");
      expect(text(host)).toContain("The agents' commands1.2 GB, and may hold up to 4.5 GB");
      expect(meter(host, "Disk in use")!.getAttribute("aria-valuenow")).toBe("36");
      expect(text(host)).toContain("36.0 GB of 100.0 GB in use");
      expect(text(host)).toContain("64.0 GB is free.");
      await drawn(host, "Nouride's own files take 32.0 GB.");
      expect(text(host)).toContain("Counted 3 min ago.");
      // Its largest entries, each a way into Files at that folder.
      const links = [...host.querySelectorAll<HTMLAnchorElement>('li a[href*="/files"]')].map((link) => [link.textContent?.replace(/\s+/g, " ").trim(), link.getAttribute("href")]);
      expect(links.slice(0, 3)).toEqual([
        ["workspace20.0 GB", "/dashboard/files?path=workspace"],
        ["attachments9.0 GB", "/dashboard/files?path=attachments"],
        ["data2.5 GB", "/dashboard/files?path=data"],
      ]);
      expect(text(host)).toContain("Version0.8.36");
      expect(text(host)).toContain("Running for3 h");
      expect(text(host)).toContain("Processor cores it may use4");
      expect(text(host)).toContain("/srv/nouride/.nouride");
      // Nothing is nearly full here, and nothing says so.
      expect(text(host)).not.toContain("Getting full");
      expect(text(host)).not.toContain("Nearly full");
    });
  });

  test("the version says which build it is, and has the way to a newer one beside it while there is one", async () => {
    const UPDATE = RESPONSES["/update"] as { install: object; check: object } & Record<string, unknown>;
    const version = (host: HTMLElement) => [...host.querySelectorAll("div")].find((row) => row.firstElementChild?.textContent === "Version" && row.children.length === 2)!;
    await renderPage("/system", async (host) => {
      await drawn(host, "0.8.36 (Community)");
      const way = version(host).querySelector<HTMLAnchorElement>("a")!;
      expect([way.textContent, way.getAttribute("href")]).toEqual(["0.7.10 is out", "/dashboard/update"]);
    });
    // Downloaded and waiting: the same way, in its own words.
    answer({ "/update": { status: 200, body: { ...UPDATE, install: { ...UPDATE.install, edition: "pro" }, download: { status: "ready", received: 1, total: 1, tag: "v0.7.10", artifact: "a", error: null } } } });
    await renderPage("/system", async (host) => {
      await drawn(host, "0.8.36 (Pro)");
      expect(version(host).querySelector("a")!.textContent).toBe("Update ready to install");
    });
    // Nothing newer: the version and its build, and no button.
    answer({ "/update": { status: 200, body: { ...UPDATE, check: { ...UPDATE.check, latest: "0.7.9", newer: false } } } });
    await renderPage("/system", async (host) => {
      await drawn(host, "0.8.36 (Community)");
      expect(version(host).querySelector("a")).toBeNull();
    });
    // The check did not answer: the version alone, as the machine itself gives it.
    answer({ "/update": { status: 503, body: { error: "unreachable" } } });
    await renderPage("/system", async (host) => {
      await drawn(host, "Version0.8.36");
      expect(version(host).textContent).toBe("Version0.8.36");
    });
    // A build with no update check of its own (a container) still says which it is.
    answer({ "/update": { status: 503, body: { error: "unreachable" } }, "/health": { status: 200, body: { ...(WIRE["/health"] as object), edition: "pro" } } });
    await renderPage("/system", async (host) => {
      await drawn(host, "0.8.36 (Pro)");
      expect(version(host).textContent).toBe("Version0.8.36 (Pro)");
    });
  });

  test("getting full and nearly full are said in words beside the bar, not by its colour alone", async () => {
    answer({ "/system": { status: 200, body: { ...SYSTEM, memory: { ...SYSTEM.memory, usedBytes: 4.8 * GiB }, disk: { totalBytes: 100 * GiB, freeBytes: 5 * GiB } } } });
    await renderPage("/system", async (host) => {
      await drawn(host, "4.8 GB of 6.0 GB in use");
      const said = (label: string) => meter(host, label)!.parentElement!.textContent ?? "";
      expect(said("RAM in use")).toContain("Getting full");
      expect(said("Disk in use")).toContain("95.0 GB of 100.0 GB in use");
      expect(said("Disk in use")).toContain("Nearly full");
    });
  });

  test("a figure the machine does not give has no bar: said as not known, never drawn as nothing in use", async () => {
    answer({
      "/system": { status: 200, body: { ...SYSTEM, memory: { daemonBytes: 300 * 1024 ** 2, commands: null, usedBytes: null, totalBytes: 8 * GiB, limited: false, machineBytes: 8 * GiB }, disk: null } },
      "/system/folder-sizes": { status: 200, body: { state: "unavailable", measuredAt: null, totalBytes: null, entries: [] } },
    });
    await renderPage("/system", async (host) => {
      await drawn(host, "8.0 GB in all. How much of it is in use is not something Nouride can tell here.");
      expect(meter(host, "RAM in use")).toBeNull();
      expect(meter(host, "Disk in use")).toBeNull();
      expect(text(host)).toContain("That is this machine's own RAM.");
      expect(text(host)).toContain("The agents' commandsCounted together with Nouride here.");
      expect(text(host)).toContain("Nouride cannot tell how large the disk is here.");
      await drawn(host, "How much Nouride's own files take could not be counted here.");
    });
  });

  test("while the folder is being counted the page says so, and what it will take", async () => {
    answer({ "/system/folder-sizes": { status: 200, body: { state: "measuring", measuredAt: null, totalBytes: null, entries: [] } } });
    await renderPage("/system", async (host) => {
      await drawn(host, "Counting how much Nouride's own files take. On a large folder this is a minute or so.");
    });
  });

  test("someone who is not an admin is told it is an admin's, and the machine is asked nothing", async () => {
    const asked: string[] = [];
    const spy = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      asked.push(String(input));
      return (spy as typeof fetch)(input as RequestInfo, init);
    }) as typeof fetch;
    const me = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
    answer({ "/auth/me": { status: 200, body: { ...me, role: "operator", user: { ...me.user, role: "operator" } } } });
    try {
      for (const page of ["/system", "/files?path=workspace"]) {
        await renderPage(page, async (host) => {
          await drawn(host, "For an admin");
        });
      }
    } finally {
      globalThis.fetch = spy;
    }
    expect(asked.filter((url) => url.includes("/api/control/system"))).toEqual([]);
  });
});

describe("System in the menu", () => {
  const item = (host: HTMLElement) => [...host.ownerDocument.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Menu"] a')].filter((link) => link.getAttribute("href") === "/dashboard/system");

  test("an admin has it, marked as the page they are on across its four tabs; anyone else does not have it", async () => {
    answer({});
    for (const page of ["/system", "/logs", "/files", "/update"]) {
      await renderPage(page, async (host) => {
        await eventually(() => item(host).length > 0, 3_000, "System in the menu");
        expect(item(host).some((link) => link.getAttribute("aria-current") === "page")).toBe(true);
        // Its tabs over the page, the one you are on marked.
        const tabs = [...host.ownerDocument.querySelectorAll<HTMLAnchorElement>("main a")].filter((link) => ["System", "Logs", "Files", "Update"].includes(link.textContent ?? "") && ["/dashboard/system", "/dashboard/logs", "/dashboard/files", "/dashboard/update"].includes(link.getAttribute("href") ?? ""));
        expect(tabs.map((tab) => tab.textContent)).toEqual(["System", "Logs", "Files", "Update"]);
        expect(tabs.find((tab) => tab.getAttribute("aria-current") === "page")?.getAttribute("href")).toBe(`/dashboard${page}`);
      });
    }
    const me = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
    answer({ "/auth/me": { status: 200, body: { ...me, role: "operator", user: { ...me.user, role: "operator" } } } });
    await renderPage("/logs", async (host) => {
      await eventually(() => host.ownerDocument.querySelector('nav[aria-label="Menu"]') !== null && text(host).includes("Logs"), 3_000, "the Logs page");
      expect(item(host)).toEqual([]);
      // No bar of one tab over it.
      expect(host.ownerDocument.querySelector('a[href="/dashboard/files"]')).toBeNull();
    });
  });
});

describe("Files", () => {
  const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("ul > li")].map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? "");

  test("the data folder: folders first, each row its size and when it changed, and nothing said of what is not listed", async () => {
    const listed = RESPONSES["/system/files"] as { entries: { name: string }[] } & Record<string, unknown>;
    const changed: Record<string, number> = { data: 60_000, workspace: 3 * 86_400_000, "config.toml": 5 * 3_600_000 };
    // By its query, the folder itself alone: an answer by the bare path would be every folder's.
    answer({ "/system/files?path=": { status: 200, body: { ...listed, entries: listed.entries.map((entry) => ({ ...entry, modifiedAt: Date.now() - changed[entry.name]! })) } } });
    await renderPage("/files", async (host, app) => {
      await drawn(host, "config.toml");
      expect(host.querySelector('nav[aria-label="Where you are"]')!.textContent).toBe(" Nouride's files");
      expect(rows(host)).toEqual(["data1 min ago", "workspace3 days ago", "config.toml7 KB5 h ago"]);
      // Left out there (`leftOut`), and the page does not bring it up.
      expect(text(host)).not.toContain("kept private");
      expect(text(host)).not.toContain("not listed");
      // Nouride's own: no row here has anything to delete, and no room is kept for a button.
      expect(host.querySelectorAll('ul > li button[aria-label^="Delete "]')).toHaveLength(0);
      expect(host.querySelectorAll("ul > li span.size-8")).toHaveLength(0);
      // A press on a folder is its address: a link to it, and the browser's Back to leave it.
      [...host.querySelectorAll<HTMLButtonElement>("ul > li button")].find((row) => row.textContent?.includes("workspace"))!.click();
      await eventually(() => app.location() === "/files" && (app.search() as { path?: string }).path === "workspace", 3_000, "the folder's address");
      await drawn(host, "notes.md");
      expect(host.querySelector('nav[aria-label="Where you are"] [aria-current="page"]')!.textContent).toBe("workspace");
      expect(text(host)).toContain("And 1,200 more here that this list does not show.");
      // What agents left behind: each row has its delete, named for what it deletes.
      expect([...host.querySelectorAll('ul > li button[aria-label^="Delete "]')].map((button) => button.getAttribute("aria-label"))).toEqual(["Delete shots", "Delete notes.md", "Delete run.sh", "Delete shot.png"]);
    });
  });

  test("the database is a row that says what it is and does not open", async () => {
    const data = RESPONSES["/system/files?path=data"] as { entries: object[] } & Record<string, unknown>;
    answer({ "/system/files?path=data": { status: 200, body: { ...data, entries: data.entries.map((entry) => ({ ...entry, modifiedAt: Date.now() - 30_000 })) } } });
    await renderPage("/files?path=data", async (host) => {
      await drawn(host, "nouride.db");
      expect(rows(host)).toEqual(["nouride.dbThe database: it does not open here87.0 MBjust now"]);
      expect(host.querySelectorAll("ul > li button")).toHaveLength(0);
    });
  });

  test("a file's address opens that file: a page of markdown drawn as one, what was hidden said, its source a press away", async () => {
    const at = RESPONSES["/system/files?path=workspace/notes.md"] as { file: object } & Record<string, unknown>;
    answer({ "/system/files?path=workspace/notes.md": { status: 200, body: { ...at, file: { ...at.file, modifiedAt: Date.now() - 7_200_000 } } } });
    await renderPage("/files?path=workspace/notes.md", async (host, app) => {
      await drawn(host, "Deploy notes");
      // Drawn as a page: its first line is a heading, not a line that starts with a hash.
      expect([...host.querySelectorAll("h1, h2, h3")].map((heading) => heading.textContent)).toContain("Deploy notes");
      expect(text(host)).not.toContain("# Deploy notes");
      expect(text(host)).toContain("2 KB · changed 2 h ago");
      expect(text(host)).toContain("Something in this file looked like a credential, and is hidden where it was. A file like this is read here, and not downloaded.");
      // A copy would be its bytes as they are: there is no button for one.
      expect(buttons(host)).not.toContain("Download");
      expect(buttons(host)).toContain("Delete");
      expect(text(host)).toContain("The key is [hidden: GitHub token].");
      expect(text(host)).not.toContain("This is the beginning of the file");
      const toggle = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => /Show (its source|as a page)/.test(button.textContent ?? ""))!;
      expect(toggle().textContent).toBe("Show its source");
      toggle().click();
      await eventually(() => toggle().textContent === "Show as a page", 2_000, "its source");
      expect(host.querySelector("pre")!.textContent).toContain("# Deploy notes");
      // Back to the folder it is in.
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Back to its folder"))!.click();
      await eventually(() => (app.search() as { path?: string }).path === "workspace", 3_000, "its folder");
    });
  });

  test("code is a block with its button, a long file says it is cut short, a picture is a picture, and the rest says what it is", async () => {
    const entry = (name: string, sizeBytes: number) => ({ name, path: `workspace/${name}`, kind: "file", sizeBytes, modifiedAt: Date.now() - 7_200_000 });
    const at = (name: string, sizeBytes: number) => ({ status: 200, body: { path: `workspace/${name}`, entries: [], more: 0, leftOut: false, file: entry(name, sizeBytes) } });
    answer({
      "/system/files?path=workspace/run.sh": at("run.sh", 500 * 1024),
      "/system/files/read?path=workspace/run.sh": { status: 200, body: { entry: entry("run.sh", 500 * 1024), kind: "text", text: "echo hello\n", truncated: true, masked: false } },
      "/system/files?path=workspace/shot.png": at("shot.png", 300 * 1024),
      "/system/files/read?path=workspace/shot.png": { status: 200, body: { entry: entry("shot.png", 300 * 1024), kind: "picture" } },
      "/system/files?path=workspace/blob.bin": at("blob.bin", 12),
      "/system/files/read?path=workspace/blob.bin": { status: 200, body: { entry: entry("blob.bin", 12), kind: "other" } },
    });
    await renderPage("/files?path=workspace/run.sh", async (host) => {
      await drawn(host, "echo hello");
      expect(host.querySelector("pre")!.textContent).toContain("echo hello");
      expect(buttons(host)).toContain("Copy");
      expect(text(host)).toContain("This is the beginning of the file: it is longer than what is shown here.");
      expect(text(host)).not.toContain("looked like a credential");
      expect(buttons(host).some((label) => label.startsWith("Show "))).toBe(false);
    });
    await renderPage("/files?path=workspace/shot.png", async (host) => {
      await eventually(() => host.querySelector("img[alt='shot.png']") !== null, 3_000, "the picture");
      expect(host.querySelector("img[alt='shot.png']")!.getAttribute("src")).toBe("/api/control/system/files/raw?path=workspace%2Fshot.png");
    });
    await renderPage("/files?path=workspace/blob.bin", async (host) => {
      await drawn(host, "Not something to show here");
      // In its middle, the way to it; and nothing to delete, where the daemon did not mark it.
      expect(text(host)).toContain("Download it to open it with something that can.");
      expect(buttons(host).filter((label) => label === "Download")).toHaveLength(2);
      expect(buttons(host)).not.toContain("Delete");
    });
  });

  test("from a laptop's width up the page is held to the window, and the list or the file scrolls inside its card", async () => {
    answer({});
    await renderPage("/files?path=workspace", async (host) => {
      await drawn(host, "notes.md");
      const list = host.querySelector("ul")!;
      const area = list.closest(".lg\\:overflow-y-auto") as HTMLElement;
      expect(area).not.toBeNull();
      expect(area.className).toContain("lg:flex-1");
      // Where you are is outside what scrolls, in the same card.
      const crumbs = host.querySelector('nav[aria-label="Where you are"]')!;
      expect(area.contains(crumbs)).toBe(false);
      expect(crumbs.closest("section")).toBe(area.closest("section"));
      expect(area.closest("section")!.className).toContain("lg:flex-1");
      // The page's root takes the window's height, which the layout holds it to.
      expect((area.closest("section")!.parentElement as HTMLElement).className).toContain("flex min-h-0 flex-1 flex-col");
      expect((host.querySelector("main > div") as HTMLElement).className).toContain("lg:h-full");
    });
    await renderPage("/files?path=workspace/notes.md", async (host) => {
      await drawn(host, "Deploy notes");
      const area = [...host.querySelectorAll("h1, h2, h3")].find((heading) => heading.textContent === "Deploy notes")!.closest(".lg\\:overflow-y-auto") as HTMLElement;
      expect(area).not.toBeNull();
      // The file's own bar stays: its way back and what can be done with it.
      const back = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Back to its folder"))!;
      expect(area.contains(back)).toBe(false);
      expect(back.closest("section")).toBe(area.closest("section"));
    });
  });

  test("a video and a sound are played where they stand, and a PDF opens in the browser's reader", async () => {
    const entry = (name: string) => ({ name, path: `workspace/${name}`, kind: "file", sizeBytes: 5 * 1024 ** 2, modifiedAt: Date.now() - 7_200_000 });
    const at = (name: string, kind: string) => ({
      [`/system/files?path=workspace/${name}`]: { status: 200, body: { path: `workspace/${name}`, entries: [], more: 0, leftOut: false, file: entry(name) } },
      [`/system/files/read?path=workspace/${name}`]: { status: 200, body: { entry: entry(name), kind } },
    });
    answer({ ...at("demo.mp4", "video"), ...at("voice.oga", "audio"), ...at("report.pdf", "pdf") });
    await renderPage("/files?path=workspace/demo.mp4", async (host) => {
      await eventually(() => host.querySelector("video") !== null, 3_000, "the player");
      const video = host.querySelector("video")!;
      expect(video.getAttribute("src")).toBe("/api/control/system/files/raw?path=workspace%2Fdemo.mp4");
      expect([video.hasAttribute("controls"), video.getAttribute("preload"), video.hasAttribute("playsinline")]).toEqual([true, "metadata", true]);
      expect(buttons(host).filter((label) => label === "Download")).toHaveLength(1);
      // A form this browser does not play: said, with the file offered in the middle.
      video.dispatchEvent(new dom.Event("error") as unknown as Event);
      await drawn(host, "This browser cannot play it");
      expect(host.querySelector("video")).toBeNull();
      expect(buttons(host).filter((label) => label === "Download")).toHaveLength(2);
    });
    await renderPage("/files?path=workspace/voice.oga", async (host) => {
      await eventually(() => host.querySelector("audio") !== null, 3_000, "the player");
      expect(host.querySelector("audio")!.getAttribute("src")).toBe("/api/control/system/files/raw?path=workspace%2Fvoice.oga");
      expect(host.querySelector("audio")!.hasAttribute("controls")).toBe(true);
    });
    await renderPage("/files?path=workspace/report.pdf", async (host) => {
      await drawn(host, "It opens in a tab of its own, in the browser's reader.");
      const open = [...host.querySelectorAll<HTMLAnchorElement>("main a")].find((link) => link.textContent?.trim() === "Open it")!;
      expect([open.getAttribute("href"), open.getAttribute("target")]).toEqual(["/api/control/system/files/raw?path=workspace%2Freport.pdf", "_blank"]);
      expect(buttons(host).filter((label) => label === "Download")).toHaveLength(2);
    });
  });

  /** Every download the page hands the browser: where from, and the name it is saved under. */
  const recordSaves = () => {
    const saves: { href: string | null; name: string | null }[] = [];
    const proto = (dom as unknown as { HTMLAnchorElement: { prototype: { click: () => void } } }).HTMLAnchorElement.prototype;
    const click = proto.click;
    proto.click = function (this: HTMLAnchorElement) {
      if (this.hasAttribute("download")) saves.push({ href: this.getAttribute("href"), name: this.getAttribute("download") });
      else click.call(this);
    };
    return { saves, restore: () => void (proto.click = click) };
  };
  /** Every request of the files routes, in the order asked. */
  const recordAsks = () => {
    const asked: string[] = [];
    const spy = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
      if (url.pathname.startsWith("/api/control/system/files")) asked.push(`${init?.method ?? "GET"} ${url.pathname.replace("/api/control", "")}${decodeURIComponent(url.search)}`);
      return (spy as typeof fetch)(input as RequestInfo, init);
    }) as typeof fetch;
    return { asked, restore: () => void (globalThis.fetch = spy) };
  };
  const dialog = () => dom.document.body.querySelector("dialog[open]");
  const inDialog = (label: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;

  test("Download asks first whether the file would be handed over, then leaves the fetching to the browser", async () => {
    const entry = { name: "run.sh", path: "workspace/run.sh", kind: "file", sizeBytes: 120, modifiedAt: Date.now() - 7_200_000 };
    answer({
      "/system/files?path=workspace/run.sh": { status: 200, body: { path: "workspace/run.sh", entries: [], more: 0, leftOut: false, file: entry } },
      "/system/files/read?path=workspace/run.sh": { status: 200, body: { entry, kind: "text", text: "echo hello\n", truncated: false, masked: false } },
    });
    const saved = recordSaves();
    const asks = recordAsks();
    try {
      await renderPage("/files?path=workspace/run.sh", async (host) => {
        await drawn(host, "echo hello");
        [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Download")!.click();
        await eventually(() => saved.saves.length === 1, 3_000, "the download");
        expect(saved.saves).toEqual([{ href: "/api/control/system/files/download?path=workspace%2Frun.sh", name: "run.sh" }]);
        expect(asks.asked.filter((ask) => ask.includes("/download"))).toEqual(["GET /system/files/download?path=workspace/run.sh&check=1"]);
      });
    } finally {
      saved.restore();
      asks.restore();
    }
  });

  test("a file the daemon will not hand over says why, and the browser is given nothing to fetch", async () => {
    const entry = { name: "long.log", path: "workspace/long.log", kind: "file", sizeBytes: 9 * 1024 ** 2, modifiedAt: Date.now() - 7_200_000 };
    answer({
      "/system/files?path=workspace/long.log": { status: 200, body: { path: "workspace/long.log", entries: [], more: 0, leftOut: false, file: entry } },
      // Nothing masked in the beginning that is shown: what is further down, only the whole reading finds.
      "/system/files/read?path=workspace/long.log": { status: 200, body: { entry, kind: "text", text: "a line\n", truncated: true, masked: false } },
      "/system/files/download": { status: 403, body: { error: "masked", reason: "masked", plain: "Something in this file looks like a credential, so it is not downloaded from here." } },
    });
    const saved = recordSaves();
    try {
      await renderPage("/files?path=workspace/long.log", async (host) => {
        await drawn(host, "a line");
        [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Download")!.click();
        await drawn(host, "Something in this file looks like a credential, so it is not downloaded from here.");
        expect(saved.saves).toEqual([]);
      });
    } finally {
      saved.restore();
    }
  });

  test("a row's delete asks first, naming what would go and how much; said no, nothing is sent", async () => {
    answer({});
    const posted = recordPosts({ "/system/files/delete": { status: 200, body: { ok: true, path: "workspace/shots" } } });
    try {
      await renderPage("/files?path=workspace", async (host) => {
        await drawn(host, "notes.md");
        host.querySelector<HTMLButtonElement>('button[aria-label="Delete shots"]')!.click();
        await eventually(() => inDialog("Delete") !== undefined, 3_000, "the question");
        const said = (dialog()!.textContent ?? "").replace(/\s+/g, " ");
        expect(said).toContain("Delete shots?");
        expect(said).toContain("The folder and everything in it will be gone from this machine: 1,204 files, 3.2 GB. This cannot be undone.");
        inDialog("Cancel")!.click();
        await eventually(() => dialog() === null, 2_000, "the question closed");
        expect(posted.posts).toEqual([]);
        // Asked again and said yes: deleted by its path, and the folder is read again.
        const again = () => host.querySelector<HTMLButtonElement>('button[aria-label="Delete shots"]')!;
        await eventually(() => !again().disabled, 2_000, "the row's delete, free again");
        again().click();
        await eventually(() => inDialog("Delete") !== undefined, 3_000, "the question again");
        const asks = recordAsks();
        try {
          inDialog("Delete")!.click();
          await eventually(() => posted.posts.length === 1, 3_000, "the delete");
          expect(posted.posts).toEqual([{ path: "/system/files/delete", body: { path: "workspace/shots" } }]);
          await eventually(() => asks.asked.includes("GET /system/files?path=workspace"), 3_000, "the folder read again");
        } finally {
          asks.restore();
        }
      });
    } finally {
      posted.restore();
    }
  });

  test("a delete the daemon holds back says why on its row, and nothing is asked of the person", async () => {
    answer({ "/system/files/weigh?path=workspace/shots": { status: 409, body: { error: "in-use", reason: "in-use", plain: "A mission is still working here. Delete it once the mission has ended." } } });
    const posted = recordPosts();
    try {
      await renderPage("/files?path=workspace", async (host) => {
        await drawn(host, "notes.md");
        host.querySelector<HTMLButtonElement>('button[aria-label="Delete shots"]')!.click();
        await drawn(host, "A mission is still working here. Delete it once the mission has ended.");
        expect(dialog()).toBeNull();
        expect(posted.posts).toEqual([]);
        // Said on the row it was asked of.
        expect(host.querySelector('button[aria-label="Delete shots"]')!.closest("li")!.textContent).toContain("A mission is still working here.");
      });
    } finally {
      posted.restore();
    }
  });

  test("an open file that is deleted leaves the page on the folder it was in", async () => {
    const at = RESPONSES["/system/files?path=workspace/notes.md"] as { file: object } & Record<string, unknown>;
    answer({ "/system/files?path=workspace/notes.md": { status: 200, body: at } });
    const posted = recordPosts({ "/system/files/delete": { status: 200, body: { ok: true, path: "workspace/notes.md" } } });
    try {
      await renderPage("/files?path=workspace/notes.md", async (host, app) => {
        await drawn(host, "Deploy notes");
        [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Delete")!.click();
        await eventually(() => inDialog("Delete") !== undefined, 3_000, "the question");
        expect((dialog()!.textContent ?? "").replace(/\s+/g, " ")).toContain("It is 2 KB, and will be gone from this machine. This cannot be undone.");
        inDialog("Delete")!.click();
        await eventually(() => (app.search() as { path?: string }).path === "workspace", 3_000, "its folder");
        expect(posted.posts).toEqual([{ path: "/system/files/delete", body: { path: "workspace/notes.md" } }]);
      });
    } finally {
      posted.restore();
    }
  });

  test("what is kept private, and what is gone, each say so with a way back", async () => {
    answer({ "/system/files?path=data/.control-token": { status: 403, body: { error: "left-out", reason: "left-out", plain: "This is kept private: credentials and secrets are not shown here." } } });
    await renderPage("/files?path=data/.control-token", async (host, app) => {
      await drawn(host, "This is kept private: credentials and secrets are not shown here.");
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Back to Nouride's files"))!.click();
      await eventually(() => (app.search() as { path?: string }).path === "", 3_000, "the data folder");
    });
    answer({ "/system/files?path=workspace/gone.md": { status: 404, body: { error: "missing", reason: "missing", plain: "It is no longer there." } } });
    await renderPage("/files?path=workspace/gone.md", async (host) => {
      await drawn(host, "It is no longer there.");
    });
  });
});

describe("a path of the data folder is a link to its file", () => {
  const hrefs = (host: HTMLElement) => [...host.querySelectorAll<HTMLAnchorElement>('main a[href^="/dashboard/files?path="]')].map((link) => [link.textContent?.trim(), link.getAttribute("href")]);
  const notes = (words: string) => {
    const file = { name: "notes.md", path: "workspace/notes.md", kind: "file", sizeBytes: 300, modifiedAt: Date.now() - 60_000 };
    return {
      "/system/files?path=workspace/notes.md": { status: 200, body: { path: "workspace/notes.md", entries: [], more: 0, leftOut: false, file } },
      "/system/files/read?path=workspace/notes.md": { status: 200, body: { entry: file, kind: "text", text: words, truncated: false, masked: false } },
    };
  };
  const WORDS = "See `.nouride/workspace/shot.png` and `/srv/nouride/.nouride/workspace/run.sh:12`, not `/etc/passwd` or `.nouride/../x`.\n\n[the report](.nouride/workspace/reports/week.md) and [a page](/dashboard/agents).\n";

  test("in what an agent wrote: a span of code that is such a path, and a link written to one; nothing else", async () => {
    answer(notes(WORDS));
    await renderPage("/files?path=workspace/notes.md", async (host, app) => {
      await drawn(host, "the report");
      expect(hrefs(host)).toEqual([
        [".nouride/workspace/shot.png", "/dashboard/files?path=workspace%2Fshot.png"],
        ["/srv/nouride/.nouride/workspace/run.sh:12", "/dashboard/files?path=workspace%2Frun.sh"],
        ["the report", "/dashboard/files?path=workspace%2Freports%2Fweek.md"],
      ]);
      // The others are the code they were, and a link to a page is still that page's.
      const codes = [...host.querySelectorAll("main code")].filter((code) => !code.closest("a")).map((code) => code.textContent);
      expect(codes).toEqual(["/etc/passwd", ".nouride/../x"]);
      expect(host.querySelector('main a[href="/dashboard/agents"]')?.textContent).toBe("a page");
      // A press opens that file here, in place.
      host.querySelector<HTMLAnchorElement>('main a[href="/dashboard/files?path=workspace%2Fshot.png"]')!.click();
      await eventually(() => app.location() === "/files" && (app.search() as { path?: string }).path === "workspace/shot.png", 3_000, "the file it names");
    });
  });

  test("a mission's result files, by their names on its page, and the folder it works in", async () => {
    const mission = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> } & Record<string, unknown>;
    const workdir = "/srv/nouride/.nouride/workspace/shared/report";
    answer({ "/missions/msn_1": { status: 200, body: { ...mission, mission: { ...mission.mission, status: "done", workdir, report: "Done.", files: [`${workdir}/out/report.pdf`, "/tmp/elsewhere.txt"] } } } });
    await renderPage("/missions/msn_1", async (host) => {
      await drawn(host, "out/report.pdf");
      expect(hrefs(host)).toEqual([
        ["out/report.pdf", "/dashboard/files?path=workspace%2Fshared%2Freport%2Fout%2Freport.pdf"],
        // Under what it is judged by: its folder, opened in Files as a folder.
        [workdir, "/dashboard/files?path=workspace%2Fshared%2Freport"],
      ]);
      // One outside the folder is its name, as it was.
      expect(text(host)).toContain("/tmp/elsewhere.txt");
    });
    // A mission that works in a folder outside Nouride's own: its folder is said, and leads nowhere.
    answer({ "/missions/msn_1": { status: 200, body: { ...mission, mission: { ...mission.mission, status: "done", workdir: "/srv/repo/app", report: "Done.", files: [] } } } });
    await renderPage("/missions/msn_1", async (host) => {
      await drawn(host, "/srv/repo/app");
      expect(hrefs(host)).toEqual([]);
    });
  });

  test("a command in a turn's steps: each word that is such a path, the rest of the command as written", async () => {
    const live = WIRE["/sessions/ses_1/live"] as { turn: { steps: Record<string, unknown>[] } } & Record<string, unknown>;
    const command = "node /srv/nouride/.nouride/workspace/kopi/render.mjs --out '.nouride/workspace/kopi/out.png' /etc/hosts";
    answer({
      "/sessions/ses_1/live": {
        status: 200,
        body: { ...live, turn: { ...live.turn, steps: [{ seq: 10, at: 0, kind: "tool", text: command, callId: "c10", name: "exec", ms: 7_000 }, { seq: 11, at: 0, kind: "tool_done", text: "ok", callId: "c10", name: "exec", ms: 40 }], cursor: 12 } },
      },
    });
    await renderPage("/chat/ses_1", async (host) => {
      const line = () => host.querySelector<HTMLButtonElement>("button[aria-controls][aria-expanded]");
      await eventually(() => line() !== null, 3_000, "the step line");
      line()!.click();
      await eventually(() => hrefs(host).length === 2, 3_000, "the paths as links");
      expect(hrefs(host)).toEqual([
        ["/srv/nouride/.nouride/workspace/kopi/render.mjs", "/dashboard/files?path=workspace%2Fkopi%2Frender.mjs"],
        [".nouride/workspace/kopi/out.png'", "/dashboard/files?path=workspace%2Fkopi%2Fout.png"],
      ]);
      expect(text(host)).toContain("node /srv/nouride/.nouride/workspace/kopi/render.mjs --out '.nouride/workspace/kopi/out.png' /etc/hosts");
    });
  });

  test("a command long enough to be folded to three lines has its paths as links too", async () => {
    const live = WIRE["/sessions/ses_1/live"] as { turn: { steps: Record<string, unknown>[] } } & Record<string, unknown>;
    const command = `cd /srv/nouride/.nouride/workspace/kopi && ${"npx remotion render src/index.ts Main out/video.mp4 --concurrency=4 && ".repeat(4)}ls -la .nouride/workspace/kopi/out/video.mp4`;
    expect(command.length).toBeGreaterThan(240);
    answer({
      "/sessions/ses_1/live": {
        status: 200,
        body: { ...live, turn: { ...live.turn, steps: [{ seq: 10, at: 0, kind: "tool", text: command, callId: "c10", name: "exec", ms: 7_000 }, { seq: 11, at: 0, kind: "tool_done", text: "ok", callId: "c10", name: "exec", ms: 40 }], cursor: 12 } },
      },
    });
    await renderPage("/chat/ses_1", async (host) => {
      const line = () => host.querySelector<HTMLButtonElement>("button[aria-controls][aria-expanded]");
      await eventually(() => line() !== null, 3_000, "the step line");
      line()!.click();
      await eventually(() => hrefs(host).length === 2, 3_000, "the paths as links");
      expect(hrefs(host).map(([, href]) => href)).toEqual(["/dashboard/files?path=workspace%2Fkopi", "/dashboard/files?path=workspace%2Fkopi%2Fout%2Fvideo.mp4"]);
      expect(buttons(host)).toContain("Show all");
    });
  });

  test("for someone who is not an admin nothing is a link: Files is not theirs to open", async () => {
    const me = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
    const mission = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> } & Record<string, unknown>;
    const workdir = "/srv/nouride/.nouride/workspace/shared/report";
    answer({
      "/auth/me": { status: 200, body: { ...me, role: "operator", user: { ...me.user, role: "operator" } } },
      "/missions/msn_1": { status: 200, body: { ...mission, mission: { ...mission.mission, status: "done", workdir, report: "See `.nouride/workspace/shared/report/out/report.pdf`.", files: [`${workdir}/out/report.pdf`] } } },
    });
    await renderPage("/missions/msn_1", async (host) => {
      await drawn(host, "out/report.pdf");
      expect(hrefs(host)).toEqual([]);
      expect([...host.querySelectorAll("main code")].map((code) => code.textContent)).toContain(".nouride/workspace/shared/report/out/report.pdf");
    });
  });
});
