/**
 * Whose missions the Missions page lists: the reader's own, and for an admin alone the picker Chats and Automations
 * have, in the board's head beside its search, whose last choice reads "Nobody's". With anything but Mine picked each
 * card says whose it is, in the column of what a person does about it.
 *
 * A mission the reader only reads says whose it is, and one of those that waits for a person waits for its own: it is
 * not "Needs you" on any page of theirs, since nothing they press would answer it.
 */

import { describe, expect, test } from "bun:test";
import type { MissionView } from "@nouride/wire";
import { missionsWaiting } from "@/commons/hooks/use-needs-you";
import { rowLine, seenAs, seenTone } from "@/modules/missions/lib/mission";
import { columnOf } from "@/modules/missions/lib/board";
import { answer, dropdown, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const LIST = WIRE["/missions"] as { missions: MissionView[] };
const [working] = LIST.missions;
const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
const signedIn = (role: string) => ({ "/auth/me": ok({ ...ME, role, user: { ...ME.user, role } }) });
const PICKER = "Whose missions";
const KEPT = "nouride-missions-whose";

/** One mission of the fixture's, at work, as another's: named by its goal, and whose it is. */
const one = (id: string, goal: string, more: Partial<MissionView> = {}): MissionView => {
  const { person: _person, ...rest } = working!;
  return { ...rest, id, goal, ...more };
};
const waiting: Partial<MissionView> = { status: "waiting", seen: "needs_you", waitKind: "input", reason: "Which folder?" };
const ended: Partial<MissionView> = { status: "done", seen: "done", endedAt: working!.createdAt, report: "All tidy." };
const SAM = { key: "sam", name: "Kak Sam" };
const RAKA = { key: "raka", name: "Raka" };
const GADING = { key: "gading", name: "Gading" };
/** Everyone's, in the daemon's order: what needs someone first, then what works, then what finished. */
const EVERYONE = [one("msn_s1", "Plan the arisan", { person: SAM, ...waiting }), one("msn_n", "Tidy the old logs"), one("msn_g", "Write the report", { person: GADING }), one("msn_r", "Count the stock", { person: RAKA }), one("msn_s2", "Book the bus", { person: SAM, ...ended })];

const cards = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-mission]")].map((card) => card.dataset.mission!);
const card = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-mission="${id}"]`);
/** Each card by its column, with whose it says it is, or null where it says nothing of it (the reader's own list). */
const whose = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-mission]")].map((one) => [one.dataset.column, one.dataset.mission, one.querySelector("[data-tag]")?.textContent ?? null]);
const columnCount = (host: HTMLElement, id: string) => host.querySelector(`[data-board-column="${id}"] header span`)?.textContent ?? null;

/** Every list of missions the Missions page asks the daemon for, by whose it asked for. The menu's own count asks too, with no days. */
function asked(): { whose: (string | null)[]; restore: () => void } {
  const whose: (string | null)[] = [];
  const harness = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input : input.url), "http://localhost");
    if (url.pathname === "/api/control/missions" && url.searchParams.has("days")) whose.push(url.searchParams.get("whose"));
    return harness(input, init);
  }) as typeof fetch;
  return { whose, restore: () => void (globalThis.fetch = harness) };
}

describe("a mission the reader only reads, that waits for a person", () => {
  const theirs = one("msn_t", "Plan the trip", { person: GADING, changeable: false, ...waiting });
  const nobodys = one("msn_x", "Old work", { changeable: false, ...waiting });
  const own = one("msn_o", "My own", { person: SAM, changeable: true, ...waiting });

  test("says who it waits for, in quiet colours, and is at work as far as the reader's lists go", () => {
    expect(seenAs(theirs)).toBe("Waiting for Gading");
    expect(seenAs(nobodys)).toBe("Waiting for an admin");
    expect(seenAs(own)).toBe("Needs you · a question");
    expect(columnOf(theirs)).toBe("working");
    expect(columnOf(own)).toBe("needs");
    expect(seenTone(theirs)).toBe(seenTone({ seen: "ended", status: "stopped", waitKind: null, startedAt: 1 }));
    expect(seenTone(own)).not.toBe(seenTone(theirs));
  });

  test("its row says who can answer it, not the buttons the reader has none of", () => {
    expect(rowLine(theirs)).toEqual({ label: "Waiting", text: "Only Gading can answer what it waits for." });
    expect(rowLine(nobodys)).toEqual({ label: "Waiting", text: "Only an admin can answer what it waits for." });
    expect(rowLine(own)?.label).toBe("Needs you");
  });

  test("is not one of the missions waiting for the reader, which Home, Work and the menu count", () => {
    expect(missionsWaiting([theirs, nobodys, own]).map((m) => m.id)).toEqual(["msn_o"]);
    // One from a daemon that does not say whether it may be changed is the reader's to answer, as it always was.
    const { changeable: _changeable, ...older } = own;
    expect(missionsWaiting([older]).length).toBe(1);
  });
});

describe("the Missions page, as an admin", () => {
  test("one picker beside the search in the row that stays, on Mine, whose last choice reads Nobody's; Mine asks for nothing but the list", async () => {
    const seen = { holds: "" as string | null, options: [] as string[], beside: false, tags: [] as unknown[] };
    const record = asked();
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the missions");
        const picker = dropdown(host, PICKER);
        seen.holds = picker.holds();
        const before = picker.button()!.previousElementSibling;
        seen.beside = before?.tagName === "LABEL" && before.querySelector('input[type="search"]') !== null;
        seen.options = await picker.open();
        seen.tags = whose(host).map((row) => row[2]);
      });
    } finally {
      record.restore();
    }
    // Their own list says nothing of whose each is.
    expect(seen).toEqual({ holds: "Mine", options: ["Mine", "Everyone", "Gading", "Kak Sam", "Raka", "Nobody's"], beside: true, tags: [null, null] });
    expect(record.whose).toEqual([null]);
  });

  test("Everyone is asked of the daemon, and each card says whose it is, in the column of what is done about it", async () => {
    answer({ "/missions?whose=everyone": ok({ missions: EVERYONE }), "/people/me": ok({ person: RAKA }) });
    let seen: unknown[] = [];
    const record = asked();
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the missions");
        await dropdown(host, PICKER).pick("Everyone");
        await eventually(() => card(host, "msn_n") !== null, 3_000, "everyone's");
        seen = whose(host);
      });
    } finally {
      record.restore();
      localStorage.removeItem(KEPT);
    }
    expect(seen).toEqual([
      ["working", "msn_n", "Nobody's"],
      ["working", "msn_g", "Gading's"],
      ["working", "msn_r", "Raka's"],
      ["needs", "msn_s1", "Kak Sam's"],
      ["finished", "msn_s2", "Kak Sam's"],
    ]);
    expect(record.whose).toEqual([null, "everyone"]);
  });

  test("one person's is asked by their key, with that person's first, and what is kept is this page's alone", async () => {
    answer({ "/missions?whose=person:sam": ok({ missions: [one("msn_g", "Write the report", { person: GADING }), one("msn_s1", "Plan the arisan", { person: SAM })] }), "/people/me": ok({ person: GADING }) });
    let seen: unknown[] = [];
    const kept: Record<string, string | null> = {};
    let automations = "" as string | null;
    const record = asked();
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the missions");
        await dropdown(host, PICKER).pick("Kak Sam");
        await eventually(() => card(host, "msn_s1") !== null, 3_000, "hers");
        seen = whose(host);
        kept.missions = localStorage.getItem(KEPT);
        kept.automations = localStorage.getItem("nouride-automations-whose");
      });
      // Automations keeps a choice of its own: it still opens on Mine.
      await renderPage("/automations", async (host) => {
        await eventually(() => dropdown(host, "Whose automations").button() !== undefined, 3_000, "the automations' picker");
        automations = dropdown(host, "Whose automations").holds();
      });
    } finally {
      record.restore();
      localStorage.removeItem(KEPT);
    }
    expect(seen).toEqual([["working", "msn_g", "Gading's"], ["working", "msn_s1", "Kak Sam's"]]);
    expect(record.whose).toEqual([null, "person:sam"]);
    expect(kept).toEqual({ missions: JSON.stringify("person:sam"), automations: null });
    expect(automations).toBe("Mine");
  });

  test("with none, the picker stays and the page says whose it looked at: a person's, nobody's, everyone's", async () => {
    const said: Record<string, string> = {};
    const held: Record<string, string | null> = {};
    for (const whose of ["person:sam", "unknown", "everyone"]) {
      localStorage.setItem(KEPT, JSON.stringify(whose));
      answer({ [`/missions?whose=${whose}`]: ok({ missions: [] }) });
      try {
        await renderPage("/missions", async (host) => {
          await eventually(() => dropdown(host, PICKER).button() !== undefined && host.querySelector('main [aria-busy="true"]') === null, 3_000, "the empty list");
          said[whose] = host.querySelector("main")?.textContent ?? "";
          held[whose] = dropdown(host, PICKER).holds();
        });
      } finally {
        localStorage.removeItem(KEPT);
      }
    }
    expect(held).toEqual({ "person:sam": "Kak Sam", unknown: "Nobody's", everyone: "Everyone" });
    expect(said["person:sam"]).toContain("They started no mission in the last 7 days, and none reports to a chat of theirs.");
    expect(said.unknown).toContain("Every mission of the last 7 days belongs to someone in People.");
    expect(said.everyone).toContain("Nobody here has started one.");
    // How to start one is for the reader's own list.
    for (const text of Object.values(said)) expect(text).not.toContain("send /mission");
  });

  test("while another list is on its way the head, the tabs and the picker stay, and the missions before are not shown as theirs", async () => {
    answer({ "/missions?whose=everyone": { status: 200, body: {}, hold: true } });
    const seen = { holds: "" as string | null, cards: -1, busy: false, title: "", search: false };
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the missions");
        await dropdown(host, PICKER).pick("Everyone");
        await eventually(() => host.querySelector('main [aria-busy="true"]') !== null, 3_000, "the shape of what is coming");
        seen.holds = dropdown(host, PICKER).holds();
        seen.cards = cards(host).length;
        seen.busy = host.querySelector('main [aria-busy="true"]') !== null;
        seen.title = host.querySelector("main h1")?.textContent ?? "";
        seen.search = host.querySelector('main input[type="search"]') !== null;
      });
    } finally {
      localStorage.removeItem(KEPT);
    }
    expect(seen).toEqual({ holds: "Everyone", cards: 0, busy: true, title: "Missions", search: true });
  });

  test("a list the daemon fails to give keeps the picker: the way back to their own", async () => {
    localStorage.setItem(KEPT, JSON.stringify("everyone"));
    answer({ "/missions?whose=everyone": { status: 500, body: { error: "the list could not be read" } } });
    const seen = { holds: "" as string | null, text: "" };
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => host.textContent?.includes("the list could not be read") === true, 4_000, "the error");
        seen.holds = dropdown(host, PICKER).holds();
        await dropdown(host, PICKER).pick("Mine");
        await eventually(() => cards(host).length > 0, 3_000, "their own");
        seen.text = host.querySelector("main")?.textContent ?? "";
      });
    } finally {
      localStorage.removeItem(KEPT);
    }
    expect(seen.holds).toBe("Everyone");
    expect(seen.text).not.toContain("the list could not be read");
  });
});

describe("what an admin's own missions leave out", () => {
  const line = (host: HTMLElement) => host.querySelector<HTMLElement>("main [data-elsewhere]");
  const showEveryone = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("main button")].find((button) => button.textContent?.trim() === "Show everyone");

  test("is said under the list with how many, and Show everyone sets the picker and asks for everyone's", async () => {
    answer({ "/missions": ok({ ...LIST, elsewhere: 3 }), "/missions?whose=everyone": ok({ missions: EVERYONE }) });
    const seen = { said: "", after: "" as string | null, tagged: 0, still: true };
    const record = asked();
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the missions");
        seen.said = line(host)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        showEveryone(host)!.click();
        await eventually(() => card(host, "msn_n") !== null, 3_000, "everyone's");
        seen.after = dropdown(host, PICKER).holds();
        seen.tagged = whose(host).filter((row) => row[2] !== null).length;
        seen.still = line(host) !== null;
      });
    } finally {
      record.restore();
      localStorage.removeItem(KEPT);
    }
    expect(seen).toEqual({ said: "3 more belong to other people or to nobody.Show everyone", after: "Everyone", tagged: 5, still: false });
    expect(record.whose).toEqual([null, "everyone"]);
  });

  test("one more is said as one, and an answer with no count has no line", async () => {
    answer({ "/missions": ok({ ...LIST, elsewhere: 1 }) });
    let said = "";
    await renderPage("/missions", async (host) => {
      await eventually(() => cards(host).length > 0, 3_000, "the missions");
      said = line(host)?.textContent ?? "";
    });
    expect(said).toStartWith("1 more belongs to someone else or to nobody.");

    answer({});
    const none = { line: true, button: true };
    await renderPage("/missions", async (host) => {
      await eventually(() => cards(host).length > 0, 3_000, "the missions");
      none.line = line(host) !== null;
      none.button = showEveryone(host) !== undefined;
    });
    expect(none).toEqual({ line: false, button: false });
  });

  test("with none of their own it is what the empty page says, in place of how to start the first", async () => {
    answer({ "/missions": ok({ missions: [], elsewhere: 2 }), "/missions?whose=everyone": ok({ missions: EVERYONE }) });
    const seen = { text: "", after: "" as string | null };
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => showEveryone(host) !== undefined, 3_000, "the empty page");
        seen.text = host.querySelector("main")?.textContent ?? "";
        showEveryone(host)!.click();
        await eventually(() => card(host, "msn_n") !== null, 3_000, "everyone's");
        seen.after = dropdown(host, PICKER).holds();
      });
    } finally {
      localStorage.removeItem(KEPT);
    }
    expect(seen.text).toContain("No missions of yours in the last 7 days");
    expect(seen.text).toContain("2 more belong to other people or to nobody.");
    expect(seen.text).not.toContain("send /mission");
    expect(seen.after).toBe("Everyone");
  });
});

describe("the Missions page, as someone who is not an admin", () => {
  test("offers no picker, and asks for their own whatever this browser kept from an admin before", async () => {
    localStorage.setItem(KEPT, JSON.stringify("everyone"));
    answer(signedIn("operator"));
    const seen = { picker: true, tagged: -1, cards: 0 };
    const record = asked();
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the missions");
        seen.picker = dropdown(host, PICKER).button() !== undefined;
        seen.tagged = whose(host).filter((row) => row[2] !== null).length;
        seen.cards = cards(host).length;
      });
    } finally {
      record.restore();
      localStorage.removeItem(KEPT);
    }
    expect(seen).toEqual({ picker: false, tagged: 0, cards: 2 });
    expect(record.whose).toEqual([null]);
  });

  test("a mission they only read says whose it is; one that waits is in Working, waiting for its person, and Needs you counts none", async () => {
    const theirs = one("msn_t", "Plan the trip", { person: GADING, changeable: false, ...waiting });
    const own = one("msn_o", "My own", { person: SAM, changeable: true });
    answer({ ...signedIn("operator"), "/missions": ok({ missions: [theirs, own] }) });
    const seen = { whose: {} as Record<string, string | null>, text: "", under: [] as unknown[], needs: "" as string | null, working: "" as string | null, opens: "" as string | null };
    await renderPage("/missions", async (host) => {
      await eventually(() => cards(host).length === 2, 3_000, "the missions");
      for (const id of ["msn_t", "msn_o"]) seen.whose[id] = card(host, id)!.querySelector("[data-tag]")?.textContent?.trim() ?? null;
      seen.text = card(host, "msn_t")!.textContent?.replace(/\s+/g, " ") ?? "";
      seen.under = whose(host).map((row) => [row[0], row[1]]);
      seen.needs = columnCount(host, "needs");
      seen.working = columnCount(host, "working");
      seen.opens = card(host, "msn_t")!.querySelector("h3 a")!.getAttribute("href");
    });
    expect(seen.whose).toEqual({ msn_t: "Gading's", msn_o: null });
    expect(seen.text).toContain("Waiting for Gading");
    expect(seen.text).toContain("Only Gading can answer what it waits for.");
    expect(seen.text).not.toContain("Needs you");
    expect(seen.under).toEqual([["working", "msn_t"], ["working", "msn_o"]]);
    expect([seen.needs, seen.working]).toEqual(["0", "2"]);
    expect(seen.opens).toBe("/dashboard/missions/msn_t");
  });
});
