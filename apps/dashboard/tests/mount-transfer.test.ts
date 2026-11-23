/**
 * Export and import on its Settings page, and on the setup's first page. What a file will hold is said before it is
 * made, with its secrets locked by a password typed twice or left out in so many words. A file brought in is sent in
 * pieces, opened with its password only where it has secrets, shown beside what is here, and replaces nothing before
 * the word is typed. After an import the page leads with how it went and with Go live.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ExportPlan, ImportChecked, ImportReport, TransferState } from "@nouride/wire";
import { didNotCome } from "@/modules/transfer/components/ImportedCard";
import { holdsLines, waitingLine } from "@/commons/lib/transfer-words";
import { answer, dom, RESPONSES, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const STATE = RESPONSES["/transfer"] as TransferState;
const PLAN = RESPONSES["/transfer/plan"] as ExportPlan;
const ME = WIRE["/auth/me"] as Record<string, unknown>;
const CHECKED: ImportChecked = {
  version: "0.8.40", madeAt: 1_795_000_000_000, agents: ["rex", "milo"], secrets: 3, folders: false, database: 2 * 1024 * 1024,
  parts: { config: { files: 2, bytes: 2048 }, agents: { files: 9, bytes: 10_240 }, memory: { files: 12, bytes: 40_960 } },
  here: { agents: ["first"], people: 1, bytes: 1024 },
};
const REPORT: ImportReport = {
  at: 1_795_000_100_000, from: { version: "0.8.40", madeAt: 1_795_000_000_000 }, agents: ["rex", "milo"], secrets: 3, folders: false,
  parts: CHECKED.parts, passed: { links: 1, credentials: 2 }, ended: { sessions: 2, devices: 1 },
  held: { connections: ["telegram:rex"], automations: 2, missions: 1 }, missing: [{ setting: "agents.rex.roots[0]", path: "/srv/projects/shop" }],
  kept: "/home/nouride/.nouride/before-import-2026-11-20T01-00-00", live: false,
};

/**
 * Every request the page sends that is not a read, by method and path, with its body: a piece of a file by its size.
 * And each read, by its path alone: what a page asked for without being asked to.
 */
function recordWrites(answers: Record<string, (body: unknown) => { status: number; body: unknown }> = {}) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const read: string[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
    const method = init?.method ?? "GET";
    const path = `${url.pathname.replace(/^\/api\/control/, "")}${url.search}`;
    if (method === "GET") {
      read.push(path);
      return (spy as typeof fetch)(input as RequestInfo, init);
    }
    const body = init?.body instanceof Blob ? { piece: init.body.size } : init?.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, path, body });
    const reply = answers[path]?.(body) ?? { status: 200, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { sent, read, restore: () => void (globalThis.fetch = spy) };
}

let record: ReturnType<typeof recordWrites> | null = null;
afterEach(() => {
  record?.restore();
  record = null;
});

const card = (host: HTMLElement, mark: string) => host.querySelector(`[${mark}]`) as HTMLElement | null;
const button = (root: ParentNode, label: string) => [...root.querySelectorAll("button")].find((one) => (one.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
const passwords = (root: ParentNode) => [...root.querySelectorAll('input[type="password"]')] as unknown as HTMLInputElement[];
const boxes = (root: ParentNode) => [...root.querySelectorAll('input[type="checkbox"]')] as unknown as HTMLInputElement[];
const dialog = () => dom.document.querySelector("dialog[open]") as unknown as HTMLElement | null;
/** The count asked for by its button, and waited for: what a person does before they read the sizes. */
async function counted(host: HTMLElement): Promise<void> {
  await eventually(() => button(host, "Count how large it will be") !== undefined, 3_000, "the count's button");
  button(host, "Count how large it will be")!.click();
  await eventually(() => card(host, "data-export-holds") !== null, 3_000, "the count");
}

/** A file picked in the card's hidden input, as a person's pick is: `size` bytes. */
function pick(host: HTMLElement, size: number): void {
  const input = host.querySelector('input[type="file"]') as unknown as HTMLInputElement;
  const file = new File([new Uint8Array(size)], "nouride-export-2026-11-20-01-00.tar.gz", { type: "application/gzip" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("change", { bubbles: true }));
}

describe("the words of a file", () => {
  test("what it holds: the database first, then each part that has something, in a person's order", () => {
    expect(holdsLines({ memory: { files: 40, bytes: 204_800 }, config: { files: 1, bytes: 512 }, knowledge: { files: 0, bytes: 0 }, workspace: { files: 2, bytes: 2048 } }, 5 * 1024 * 1024)).toEqual([
      "Chats, missions, automations and accounts (5.0 MB)",
      "Settings and people: 1 file, 512 B",
      "Memory: 40 files, 200 KB",
      "The agents' own folders: 2 files, 2 KB",
    ]);
    // A large install's count is read with its thousands apart.
    expect(holdsLines({ workspace: { files: 1_241_040, bytes: 38 * 1024 ** 3 } }, 0).at(-1)).toBe("The agents' own folders: 1,241,040 files, 38.0 GB");
  });

  test("what waits for Go live, and what did not come, each only where there is something of it", () => {
    expect(waitingLine({ connections: ["telegram:rex"], automations: 2 })).toBe("1 connection to chat apps and 2 automations are waiting for Go live.");
    expect(waitingLine({ connections: [], automations: 1 })).toBe("1 automation is waiting for Go live.");
    expect(waitingLine({ connections: [], automations: 0 })).toBe("Nothing is waiting. Go live says this Nouride is the one in use.");
    expect(didNotCome(REPORT)).toEqual([
      "The sign-ins of coding CLIs: sign each one in again on its agent's page",
      "The agents' own folders: the file was made without them",
      "A chat app's own session, such as a linked WhatsApp: link it again on Connections",
      "Backups, logs and installed tools: these are made again here",
      "3 files in the agents' folders that were links, or held a sign-in or a key",
    ]);
    expect(didNotCome({ ...REPORT, secrets: null, folders: true, passed: { links: 0, credentials: 0 } })).toContain("Secrets: the file held none, so each is entered again on Secrets");
  });
});

describe("making the file", () => {
  test("says what it will hold first; the button waits for a password typed twice, twelve characters or more, and sends it once", async () => {
    const seen = { lines: [] as string[], folders: "", empty: true, short: true, differ: true, ready: false, said: "" };
    await renderPage("/transfer", async (host) => {
      await counted(host);
      record = recordWrites({ "/transfer/export": () => ({ status: 202, body: { ...STATE, export: { state: "working", done: { files: 3, bytes: 1024 }, total: PLAN.bytes } } }) });
      const at = card(host, "data-export")!;
      seen.lines = [...at.querySelectorAll("[data-export-holds] li")].map((line) => line.textContent ?? "");
      seen.folders = boxes(at)[0]!.closest("label")!.textContent ?? "";
      const make = () => button(at, "Make the file")!;
      seen.empty = make().disabled;
      const [first, again] = passwords(at);
      type(first!, "too short");
      type(again!, "too short");
      await eventually(() => (at.textContent ?? "").includes("At least 12 characters."), 2_000, "the least");
      seen.short = make().disabled;
      type(first!, "a long walk to the river");
      type(again!, "a long walk to the lake");
      await eventually(() => (at.textContent ?? "").includes("The two do not match."), 2_000, "the mismatch");
      seen.differ = make().disabled;
      type(again!, "a long walk to the river");
      await eventually(() => !make().disabled, 2_000, "the button");
      seen.ready = true;
      make().click();
      await eventually(() => card(host, "data-export-working") !== null, 3_000, "the progress");
      seen.said = card(host, "data-export-working")!.textContent ?? "";
    });
    expect(seen.lines).toEqual(["Chats, missions, automations and accounts (5.0 MB)", "Settings and people: 3 files, 4 KB", "Agents and their skills: 12 files, 20 KB", "Memory: 40 files, 200 KB", "Files sent in chats: 2 files, 1 KB"]);
    expect(seen.folders).toContain("310 files, 80.0 MB");
    expect([seen.empty, seen.short, seen.differ, seen.ready]).toEqual([true, true, true, true]);
    expect(record!.sent).toEqual([{ method: "POST", path: "/transfer/export", body: { passphrase: "a long walk to the river", folders: false } }]);
    expect(seen.said).toContain("Making the file: 3 files, 1 KB of about 5.2 MB.");
  });

  /**
   * The count reads every file of the install. Made as the page opened, it was still running on the daemon after a
   * person had gone on to another page, and every page was slow until it ended.
   */
  test("nothing is counted as the page opens: it says what a file holds in words, and counts by its button, once for both sizes", async () => {
    const seen = { early: "", lines: null as Element | null, tick: "", secrets: "", sized: "", withFolders: [] as string[], larger: "", again: false };
    record = recordWrites();
    const plans = () => record!.read.filter((path) => path.startsWith("/transfer/plan")).length;
    let before = -1;
    let after = -1;
    let ticked = -1;
    let twice = -1;
    await renderPage("/transfer", async (host) => {
      await eventually(() => button(host, "Count how large it will be") !== undefined, 3_000, "the count's button");
      const at = card(host, "data-export")!;
      seen.early = card(host, "data-export-everything")!.textContent ?? "";
      seen.lines = card(host, "data-export-holds");
      seen.tick = boxes(at)[0]!.closest("label")!.textContent ?? "";
      seen.secrets = boxes(at)[1]!.closest("label")!.textContent ?? "";
      before = plans();
      button(host, "Count how large it will be")!.click();
      await eventually(() => card(host, "data-export-holds") !== null, 3_000, "the count");
      after = plans();
      seen.sized = at.textContent ?? "";
      boxes(at)[0]!.click();
      await eventually(() => (at.textContent ?? "").includes("The agents' own folders: 310 files"), 2_000, "the folders in the list");
      seen.withFolders = [...at.querySelectorAll("[data-export-holds] li")].map((line) => line.textContent ?? "");
      seen.larger = at.textContent ?? "";
      ticked = plans();
      seen.again = button(host, "Count again") !== undefined;
      button(host, "Count again")!.click();
      await eventually(() => plans() === 2, 2_000, "the second count");
      twice = plans();
    });
    expect(seen.early).toContain("Everything this Nouride keeps");
    expect(seen.lines).toBeNull();
    // The folders' tick says no size it has not counted; the secrets' count is known without one.
    expect(seen.tick).not.toMatch(/\d+ files/);
    expect(seen.secrets).toContain("The secrets (4), locked with a password");
    expect([before, after, ticked, twice]).toEqual([0, 1, 1, 2]);
    expect(seen.sized).toContain("About 5.2 MB before it is packed");
    expect(seen.withFolders.at(-1)).toBe("The agents' own folders: 310 files, 80.0 MB");
    expect(seen.larger).toContain("About 85.2 MB before it is packed");
    expect(seen.again).toBe(true);
  });

  test("a file being made says it is counting what goes in until its size is known, with no number of its own", async () => {
    answer({ "/transfer": { status: 200, body: { ...STATE, export: { state: "working", done: { files: 0, bytes: 0 } } } } });
    let said = "";
    let bar: string | null = "";
    await renderPage("/transfer", async (host) => {
      await eventually(() => card(host, "data-export-working") !== null, 3_000, "the progress");
      said = card(host, "data-export-working")!.textContent ?? "";
      bar = card(host, "data-export-working")!.querySelector("progress")!.getAttribute("value");
    });
    expect(said).toBe("Making the file: counting what goes in.");
    expect(bar).toBeNull();
  });

  test("without the secrets it says none go in before the button is pressed, and asks for no password; the folders are asked for by their tick", async () => {
    let note = "";
    let fields = -1;
    await renderPage("/transfer", async (host) => {
      await eventually(() => card(host, "data-export") !== null, 3_000, "the card");
      record = recordWrites({ "/transfer/export": () => ({ status: 202, body: STATE }) });
      const at = card(host, "data-export")!;
      const [folders, secrets] = boxes(at);
      secrets!.click();
      folders!.click();
      await eventually(() => card(host, "data-no-secrets") !== null, 2_000, "the note");
      note = card(host, "data-no-secrets")!.textContent ?? "";
      fields = passwords(at).length;
      await eventually(() => button(at, "Make the file")?.disabled === false, 2_000, "the button");
      button(at, "Make the file")!.click();
      await eventually(() => record!.sent.length === 1, 2_000, "the request");
    });
    expect(note).toContain("No secrets go into this file.");
    expect(fields).toBe(0);
    expect(record!.sent).toEqual([{ method: "POST", path: "/transfer/export", body: { secrets: false, folders: true } }]);
  });

  test("where no secret is kept there is nothing to lock: no tick, no password, and the file is asked for without them", async () => {
    // Known from the page's first answer, with nothing counted: the count is a person's to ask for.
    answer({ "/transfer": { status: 200, body: { ...STATE, secrets: 0 } }, "/transfer/plan": { status: 200, body: {}, hold: true } });
    let said = "";
    let fields = -1;
    let ticks = -1;
    await renderPage("/transfer", async (host) => {
      await eventually(() => card(host, "data-none-kept") !== null, 3_000, "the line");
      record = recordWrites({ "/transfer/export": () => ({ status: 202, body: STATE }) });
      const at = card(host, "data-export")!;
      said = card(host, "data-none-kept")!.textContent ?? "";
      fields = passwords(at).length;
      ticks = boxes(at).length;
      button(at, "Make the file")!.click();
      await eventually(() => record!.sent.length === 1, 2_000, "the request");
    });
    expect(said).toContain("No secrets are kept here, so none go into the file.");
    expect([fields, ticks]).toEqual([0, 1]);
    expect(record!.sent).toEqual([{ method: "POST", path: "/transfer/export", body: { secrets: false, folders: false } }]);
  });

  test("a file that was made is there to download, with what it holds, until it is removed", async () => {
    answer({ "/transfer": { status: 200, body: { ...STATE, export: { state: "ready", name: "nouride-export-2026-11-20-01-00.tar.gz", bytes: 3 * 1024 * 1024, madeAt: 1, secrets: true, folders: false } } } });
    let said = "";
    let labels: string[] = [];
    await renderPage("/transfer", async (host) => {
      await eventually(() => card(host, "data-export-ready") !== null, 3_000, "the file");
      said = card(host, "data-export-ready")!.textContent ?? "";
      labels = [...card(host, "data-export-ready")!.querySelectorAll("button")].map((one) => (one.textContent ?? "").trim());
    });
    expect(said).toContain("nouride-export-2026-11-20-01-00.tar.gz");
    expect(said).toContain("3.0 MB · with the secrets, locked");
    expect(labels).toEqual(["Download", "Remove it from here"]);
  });

  test("nobody but an admin has the page's cards", async () => {
    answer({ "/auth/me": { status: 200, body: { ...ME, role: "operator", user: { ...(ME.user as object), role: "operator" } } } });
    const html = await renderPage("/transfer");
    expect(html).toContain("Only an admin can do this");
    expect(html).not.toContain("Make the file");
    expect(html).not.toContain("Pick the file");
  });
});

describe("bringing a file in", () => {
  test("is sent in pieces, asks for its password only when the file has secrets, and shows what it holds beside what is here", async () => {
    const seen = { asked: false, quiet: true, holds: [] as string[], replaces: "", early: true };
    await renderPage("/transfer", async (host) => {
      await eventually(() => card(host, "data-import") !== null, 3_000, "the card");
      let arrived = 0;
      record = recordWrites({
        "/transfer/import/upload?at=0": (body) => ({ status: 200, body: { bytes: (arrived = (body as { piece: number }).piece) } }),
        "/transfer/import/upload?at=8388608": (body) => ({ status: 200, body: { bytes: (arrived += (body as { piece: number }).piece) } }),
        "/transfer/import/check": (body) =>
          (body as { passphrase?: string }).passphrase === "a long walk to the river"
            ? { status: 200, body: CHECKED }
            : { status: 422, body: { error: "the secrets did not open", plain: "That password does not open this file's secrets. It is the one typed when the file was made." } },
      });
      // Before a file is picked there is nothing to open, and no password is asked for.
      seen.early = card(host, "data-import-password") !== null;
      pick(host, 8 * 1024 * 1024 + 500);
      await eventually(() => card(host, "data-import-password") !== null, 5_000, "the password");
      seen.asked = true;
      // The first asking had no password to give: its refusal is the field, not an error on the page.
      seen.quiet = !(card(host, "data-import")!.textContent ?? "").includes("does not open");
      type(passwords(card(host, "data-import-password")!)[0]!, "a long walk to the river");
      await eventually(() => button(host, "Open the file")?.disabled === false, 2_000, "Open");
      button(host, "Open the file")!.click();
      await eventually(() => card(host, "data-import-checked") !== null, 3_000, "what it holds");
      seen.holds = [...host.querySelectorAll("[data-import-holds] li")].map((line) => line.textContent ?? "");
      seen.replaces = card(host, "data-import-checked")!.textContent ?? "";
    });
    expect(record!.sent.map((one) => [one.path, one.body])).toEqual([
      ["/transfer/import/upload?at=0", { piece: 8 * 1024 * 1024 }],
      ["/transfer/import/upload?at=8388608", { piece: 500 }],
      ["/transfer/import/check", {}],
      ["/transfer/import/check", { passphrase: "a long walk to the river" }],
    ]);
    expect([seen.early, seen.asked, seen.quiet]).toEqual([false, true, true]);
    expect(seen.holds).toEqual(["2 agents: rex, milo", "Chats, missions, automations and accounts (2.0 MB)", "Settings and people: 2 files, 2 KB", "Agents and their skills: 9 files, 10 KB", "Memory: 12 files, 40 KB", "3 secrets, opened with the password"]);
    expect(seen.replaces).toContain("It replaces everything this Nouride holds (1 agent: first).");
    expect(seen.replaces).toContain("wait until you press Go live");
  });

  test("replaces nothing before the word is typed: the dialog lists what goes, its button is dead until then and counts ten seconds after", async () => {
    const seen = { goes: [] as string[], before: false, wrong: false, counting: "", sentBefore: -1, asksPassword: true };
    await renderPage("/transfer", async (host) => {
      await eventually(() => card(host, "data-import") !== null, 3_000, "the card");
      record = recordWrites({ "/transfer/import/upload?at=0": () => ({ status: 200, body: { bytes: 100 } }), "/transfer/import/check": () => ({ status: 200, body: { ...CHECKED, secrets: null } }) });
      pick(host, 100);
      await eventually(() => button(host, "Replace everything here") !== undefined, 5_000, "what it holds");
      // A file with no secrets opens with no password asked for.
      seen.asksPassword = card(host, "data-import-password") !== null;
      button(host, "Replace everything here")!.click();
      await eventually(() => dialog() !== null && button(dialog()!, "Replace everything") !== undefined, 3_000, "the question");
      const affirm = () => [...dialog()!.querySelectorAll("button")].find((one) => (one.textContent ?? "").trim().startsWith("Replace everything")) as HTMLButtonElement;
      seen.goes = [...dialog()!.querySelectorAll("[data-what-goes] li")].map((line) => line.textContent ?? "");
      seen.before = affirm().disabled;
      const field = dialog()!.querySelector("input") as unknown as HTMLInputElement;
      type(field, "Replace");
      await eventually(() => field.value === "Replace", 2_000, "typed");
      seen.wrong = affirm().disabled && !/in \d+ s/.test(affirm().textContent ?? "");
      type(field, "replace");
      await eventually(() => /in \d+ s/.test(affirm().textContent ?? ""), 2_000, "the countdown");
      seen.counting = (affirm().textContent ?? "").trim();
      seen.sentBefore = record!.sent.filter((one) => one.path === "/transfer/import/apply").length;
      (button(dialog()!, "Keep what is here") as HTMLElement).click();
      await eventually(() => dialog() === null, 2_000, "the question closed");
      // The answer was no, and the card is at rest again: nothing was sent on the way.
      await eventually(() => button(host, "Replace everything here")?.disabled === false, 2_000, "the card at rest");
    });
    expect(seen.asksPassword).toBe(false);
    expect(seen.goes).toEqual(["1 agent: first", "Every chat, memory, mission and automation", "The accounts that sign in here, and 1 person", "Every secret"]);
    expect([seen.before, seen.wrong]).toEqual([true, true]);
    expect(seen.counting).toMatch(/^Replace everything in (10|9) s$/);
    expect(seen.sentBefore).toBe(0);
    expect(record!.sent.some((one) => one.path === "/transfer/import/apply")).toBe(false);
  });

  test("a file left ready says it goes in at the restart, and who restarts; one that failed says everything was put back", async () => {
    answer({ "/transfer": { status: 200, body: { ...STATE, staged: true, restarts: false, failed: { at: 1, error: "the disk gave out", restored: true } } } });
    let staged = "";
    let failed = "";
    let pickable = true;
    await renderPage("/transfer", async (host) => {
      await eventually(() => card(host, "data-import-staged") !== null, 3_000, "the note");
      staged = card(host, "data-import-staged")!.textContent ?? "";
      failed = card(host, "data-import-failed")?.textContent ?? "";
      pickable = button(host, "Pick the file") !== undefined;
    });
    expect(staged).toContain("The file is ready, and goes in when Nouride restarts.");
    expect(staged).toContain("Nothing on this server starts Nouride again by itself.");
    expect(staged).toContain("Take it back");
    expect(failed).toContain("The last file did not go in, and everything here was put back as it was. the disk gave out");
    expect(pickable).toBe(false);
  });
});

describe("after an import", () => {
  test("the page leads with how it went: what waits, what came, what did not, a place that is not here, and Go live", async () => {
    answer({ "/transfer": { status: 200, body: { ...STATE, imported: REPORT, held: true } } });
    const seen = { first: "", waits: "", came: [] as string[], not: [] as string[], missing: "", kept: "" };
    await renderPage("/transfer", async (host) => {
      await eventually(() => card(host, "data-imported") !== null, 3_000, "the report");
      record = recordWrites({ "/transfer/live": () => ({ status: 200, body: { report: { ...REPORT, live: true }, restarting: false, restart: true } }) });
      seen.first = host.querySelector("section h2, section h3")?.textContent ?? "";
      seen.waits = card(host, "data-go-live")!.textContent ?? "";
      seen.came = [...host.querySelectorAll("[data-came] li")].map((line) => line.textContent ?? "");
      seen.not = [...host.querySelectorAll("[data-did-not-come] li")].map((line) => line.textContent ?? "");
      seen.missing = card(host, "data-missing")!.textContent ?? "";
      seen.kept = card(host, "data-imported")!.textContent ?? "";
      button(host, "Go live")!.click();
      await eventually(() => record!.sent.length === 1, 3_000, "Go live");
    });
    expect(seen.first).toBe("Brought in, and not live yet");
    expect(seen.waits).toContain("1 connection to chat apps and 2 automations are waiting for Go live.");
    expect(seen.waits).toContain("Switch the old machine off first.");
    expect(seen.waits).toContain("1 mission that was at work is paused");
    expect(seen.came).toEqual(["2 agents: rex, milo", "Settings and people: 2 files, 2 KB", "Agents and their skills: 9 files, 10 KB", "Memory: 12 files, 40 KB", "Every chat, memory, mission, automation and account", "3 secrets, kept encrypted on this machine"]);
    expect(seen.not).toEqual(didNotCome(REPORT));
    expect(seen.missing).toContain("/srv/projects/shop");
    expect(seen.kept).toContain("2 sign-ins and 1 device were ended");
    expect(seen.kept).toContain(REPORT.kept);
    expect(record!.sent).toEqual([{ method: "POST", path: "/transfer/live", body: {} }]);
  });

  test("once live it says so, offers no Go live, and the note can be put away", async () => {
    answer({ "/transfer": { status: 200, body: { ...STATE, imported: { ...REPORT, live: true } } } });
    const seen = { live: "", goLive: true, away: false };
    await renderPage("/transfer", async (host) => {
      await eventually(() => card(host, "data-is-live") !== null, 3_000, "the report");
      seen.live = card(host, "data-is-live")!.textContent ?? "";
      seen.goLive = button(host, "Go live") !== undefined;
      seen.away = button(host, "Put this note away") !== undefined;
    });
    expect(seen.live).toContain("It is live: its connections and automations are on.");
    expect([seen.goLive, seen.away]).toEqual([false, true]);
  });
});

describe("the setup's first page", () => {
  test("offers the import to someone who is moving, and opens the same card in place", async () => {
    answer({ "/setup/state": { status: 200, body: { hasUser: true, hasProvider: false, hasAgent: false, complete: false } } });
    const seen = { line: "", card: false, title: "" };
    await renderPage("/setup", async (host) => {
      await eventually(() => card(host, "data-setup-import") !== null, 3_000, "the line");
      seen.line = card(host, "data-setup-import")!.textContent ?? "";
      button(host, "Bring its file in")!.click();
      await eventually(() => card(host, "data-import") !== null, 3_000, "the card");
      seen.card = button(host, "Pick the file") !== undefined;
      seen.title = card(host, "data-import")!.closest("section")?.textContent ?? "";
    });
    expect(seen.line).toContain("Moving from another machine? Bring its file in instead of setting up from nothing.");
    expect(seen.card).toBe(true);
    expect(seen.title).toContain("Bring your Nouride in from the other machine");
  });
});
