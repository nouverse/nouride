/**
 * Whose automations the Automations page lists: the reader's own, and for an admin alone one picker beside the search,
 * the control Chats has, whose last choice reads "Nobody's" here. With anything but Mine picked the list is set apart
 * by person. A row the reader only reads says whose it is and offers nothing that changes it.
 *
 * Each case is a way the page would show one person what is another's to change, or leave an admin without the way
 * back to their own: the picker offered to someone the daemon answers with their own anyway, a switch on a row the
 * daemon would refuse, the picker gone with the last row.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationSummary } from "@nouride/wire";
import { byPerson } from "@/commons/lib/by-person";
import { answer, dropdown, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const LIST = WIRE["/automations"] as { automations: AutomationSummary[]; timezone: string };
const [brief] = LIST.automations;
const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
const signedIn = (role: string) => ({ "/auth/me": ok({ ...ME, role, user: { ...ME.user, role } }) });
const PICKER = "Whose automations";
const KEPT = "nouride-automations-whose";

/** One automation of the fixture's, as another's: named, and whose it is. */
const one = (id: string, name: string, more: Partial<AutomationSummary> = {}): AutomationSummary => {
  const { person: _person, ...rest } = brief!;
  return { ...rest, id, name, ...more };
};
const SAM = { key: "sam", name: "Kak Sam" };
const RAKA = { key: "raka", name: "Raka" };
const GADING = { key: "gading", name: "Gading" };
/** Everyone's, as the daemon sends them: in no person's order, what is nobody's first. */
const EVERYONE = [one("cron_n", "Old backup"), one("cron_s1", "Arisan reminder", { person: SAM }), one("cron_g", "Morning brief", { person: GADING }), one("cron_r", "Shop report", { person: RAKA }), one("cron_s2", "School run", { person: SAM })];

const cards = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-automation]")];
const card = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-automation="${id}"]`);
const sections = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("main section[data-whose]")].map((section) => [section.getAttribute("aria-label"), [...section.querySelectorAll<HTMLElement>("[data-automation]")].map((row) => row.dataset.automation)]);

/** Every list of automations the page asks the daemon for, by what it asked. */
function asked(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const harness = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input : input.url), "http://localhost");
    if (url.pathname === "/api/control/automations") urls.push(url.search);
    return harness(input, init);
  }) as typeof fetch;
  return { urls, restore: () => void (globalThis.fetch = harness) };
}

describe("a list set apart by person", () => {
  const rows = [{ id: "n" }, { id: "s1", person: SAM }, { id: "g", person: GADING }, { id: "r", person: RAKA }, { id: "s2", person: SAM }];
  const groups = (first?: string) => byPerson(rows, (row) => row.person, first).map((group) => [group.label, group.items.map((row) => row.id)]);

  test("the reader's own first, every other person by name, what is nobody's last, each in the order it came", () => {
    expect(groups("raka")).toEqual([["Raka", ["r"]], ["Gading", ["g"]], ["Kak Sam", ["s1", "s2"]], ["Nobody's", ["n"]]]);
  });

  test("a reader who is nobody in People, or has nothing there, has no part first", () => {
    expect(groups()).toEqual([["Gading", ["g"]], ["Kak Sam", ["s1", "s2"]], ["Raka", ["r"]], ["Nobody's", ["n"]]]);
    expect(groups("rina")).toEqual([["Gading", ["g"]], ["Kak Sam", ["s1", "s2"]], ["Raka", ["r"]], ["Nobody's", ["n"]]]);
  });

  test("no heading for nobody where every one is somebody's", () => {
    expect(byPerson([{ id: "g", person: GADING }], (row) => row.person, undefined).map((group) => group.label)).toEqual(["Gading"]);
  });
});

describe("the Automations page, as an admin", () => {
  test("one picker beside the search, on Mine, whose last choice reads Nobody's; Mine asks for nothing but the list", async () => {
    const seen = { holds: "" as string | null, options: [] as string[], beside: false, sections: -1 };
    const record = asked();
    try {
      await renderPage("/automations", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the rows");
        const picker = dropdown(host, PICKER);
        seen.holds = picker.holds();
        // In the search's row, right after it, as on Chats.
        const before = picker.button()!.previousElementSibling;
        seen.beside = before?.tagName === "LABEL" && before.querySelector('input[type="search"]') !== null;
        seen.options = await picker.open();
        seen.sections = sections(host).length;
      });
    } finally {
      record.restore();
    }
    expect(seen).toEqual({ holds: "Mine", options: ["Mine", "Everyone", "Gading", "Kak Sam", "Raka", "Nobody's"], beside: true, sections: 0 });
    expect(record.urls).toEqual([""]);
  });

  test("Everyone is asked of the daemon, and listed by person: the reader's own, the others by name, Nobody's last", async () => {
    answer({ "/automations?whose=everyone": ok({ ...LIST, automations: EVERYONE }), "/people/me": ok({ person: RAKA }) });
    let seen: (string | (string | undefined)[] | null)[][] = [];
    let counts: string[] = [];
    const record = asked();
    try {
      await renderPage("/automations", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the rows");
        await dropdown(host, PICKER).pick("Everyone");
        await eventually(() => card(host, "cron_n") !== null, 3_000, "everyone's");
        seen = sections(host);
        counts = [...host.querySelectorAll("main section[data-whose] > p")].map((heading) => heading.textContent?.replace(/\s+/g, " ").trim() ?? "");
      });
    } finally {
      record.restore();
      // The choice is kept in this browser: the next test opens on Mine.
      localStorage.removeItem(KEPT);
    }
    expect(seen).toEqual([["Raka", ["cron_r"]], ["Gading", ["cron_g"]], ["Kak Sam", ["cron_s1", "cron_s2"]], ["Nobody's", ["cron_n"]]]);
    expect(counts).toEqual(["Raka · 1", "Gading · 1", "Kak Sam · 2", "Nobody's · 1"]);
    expect(record.urls).toEqual(["", "?whose=everyone"]);
  });

  test("one person's is asked by their key, with that person's first, and what is kept is this page's alone", async () => {
    answer({ "/automations?whose=person:sam": ok({ ...LIST, automations: [one("cron_g", "Morning brief", { person: GADING }), one("cron_s1", "Arisan reminder", { person: SAM })] }), "/people/me": ok({ person: GADING }) });
    let seen: unknown[] = [];
    const kept: Record<string, string | null> = {};
    let chats = "" as string | null;
    const record = asked();
    try {
      await renderPage("/automations", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the rows");
        await dropdown(host, PICKER).pick("Kak Sam");
        await eventually(() => card(host, "cron_s1") !== null, 3_000, "hers");
        seen = sections(host);
        kept.automations = localStorage.getItem(KEPT);
        kept.chat = localStorage.getItem("nouride-chat-whose");
      });
      // Chats keeps a choice of its own: it still opens on Mine.
      await renderPage("/chat", async (host) => {
        await eventually(() => dropdown(host, "Whose chats").button() !== undefined, 3_000, "the chats' picker");
        chats = dropdown(host, "Whose chats").holds();
      });
    } finally {
      record.restore();
      localStorage.removeItem(KEPT);
    }
    // Hers first, though the reader's own name comes before it.
    expect(seen).toEqual([["Kak Sam", ["cron_s1"]], ["Gading", ["cron_g"]]]);
    expect(record.urls).toEqual(["", "?whose=person%3Asam"]);
    expect(kept).toEqual({ automations: JSON.stringify("person:sam"), chat: null });
    expect(chats).toBe("Mine");
  });

  test("a person with none: the picker stays, the page says whose it looked at, and offers no way to make one for them", async () => {
    localStorage.setItem(KEPT, JSON.stringify("person:sam"));
    answer({ "/automations?whose=person:sam": ok({ automations: [], timezone: "UTC" }) });
    const seen = { holds: "" as string | null, text: "", search: true, create: true };
    try {
      await renderPage("/automations", async (host) => {
        await eventually(() => host.textContent?.includes("Nothing of theirs yet") === true, 3_000, "the empty list");
        seen.holds = dropdown(host, PICKER).holds();
        seen.text = host.querySelector("main")?.textContent ?? "";
        seen.search = host.querySelector('input[aria-label="Find an automation"]') !== null;
        // The page's own button stays in its head; the empty list offers none of its own.
        seen.create = [...host.querySelectorAll("main a")].filter((a) => a.textContent?.includes("New automation")).length > 1;
      });
    } finally {
      localStorage.removeItem(KEPT);
    }
    expect(seen.holds).toBe("Kak Sam");
    expect(seen.text).toContain("They have made no automation, and none reports to a chat of theirs.");
    expect(seen.text).not.toContain("No automations yet");
    expect(seen).toMatchObject({ search: false, create: false });
  });

  test("nobody's with none, and everyone's with none, each say so in their own words", async () => {
    const said: Record<string, string> = {};
    for (const whose of ["unknown", "everyone"]) {
      localStorage.setItem(KEPT, JSON.stringify(whose));
      answer({ [`/automations?whose=${whose}`]: ok({ automations: [], timezone: "UTC" }) });
      try {
        await renderPage("/automations", async (host) => {
          await eventually(() => dropdown(host, PICKER).button() !== undefined && host.querySelector('main [aria-busy="true"]') === null, 3_000, "the empty list");
          said[whose] = host.querySelector("main")?.textContent ?? "";
        });
      } finally {
        localStorage.removeItem(KEPT);
      }
    }
    expect(said.unknown).toContain("None without a person");
    expect(said.everyone).toContain("Nobody here has made one.");
  });

  test("while another person's list is on its way the head and the picker stay, and the rows before are not shown as theirs", async () => {
    answer({ "/automations?whose=everyone": { status: 200, body: {}, hold: true } });
    const seen = { holds: "" as string | null, rows: -1, busy: false, title: "" };
    try {
      await renderPage("/automations", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the rows");
        await dropdown(host, PICKER).pick("Everyone");
        await eventually(() => host.querySelector('main [aria-busy="true"]') !== null, 3_000, "the shape of what is coming");
        seen.holds = dropdown(host, PICKER).holds();
        seen.rows = cards(host).length;
        seen.busy = host.querySelector('main [aria-busy="true"]') !== null;
        seen.title = host.querySelector("main h1")?.textContent ?? "";
      });
    } finally {
      localStorage.removeItem(KEPT);
    }
    expect(seen).toEqual({ holds: "Everyone", rows: 0, busy: true, title: "Automations" });
  });

  test("a list the daemon fails to give keeps the picker: the way back to their own", async () => {
    localStorage.setItem(KEPT, JSON.stringify("everyone"));
    answer({ "/automations?whose=everyone": { status: 500, body: { error: "the list could not be read" } } });
    const seen = { holds: "" as string | null, text: "" };
    try {
      await renderPage("/automations", async (host) => {
        await eventually(() => host.textContent?.includes("the list could not be read") === true, 6_000, "the error");
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
    // The page asks twice more before it says a list failed: longer than a test's usual five seconds allow for.
  }, 15_000);
});

describe("what an admin's own list leaves out", () => {
  const line = (host: HTMLElement) => host.querySelector<HTMLElement>("main [data-elsewhere]");
  const showEveryone = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("main button")].find((button) => button.textContent?.trim() === "Show everyone");

  test("is said under the list with how many, and Show everyone sets the picker and asks for everyone's", async () => {
    answer({ "/automations": ok({ ...LIST, elsewhere: 3 }), "/automations?whose=everyone": ok({ ...LIST, automations: EVERYONE }) });
    const seen = { said: "", after: "" as string | null, sections: 0, still: true };
    const record = asked();
    try {
      await renderPage("/automations", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the rows");
        seen.said = line(host)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        showEveryone(host)!.click();
        await eventually(() => card(host, "cron_n") !== null, 3_000, "everyone's");
        seen.after = dropdown(host, PICKER).holds();
        seen.sections = sections(host).length;
        // Everyone's answer carries no count: nothing more is left out.
        seen.still = line(host) !== null;
      });
    } finally {
      record.restore();
      localStorage.removeItem(KEPT);
    }
    expect(seen).toEqual({ said: "3 more belong to other people or to nobody.Show everyone", after: "Everyone", sections: 4, still: false });
    expect(record.urls).toEqual(["", "?whose=everyone"]);
  });

  test("one more is said as one, and an answer with no count has no line", async () => {
    answer({ "/automations": ok({ ...LIST, elsewhere: 1 }) });
    let one = "";
    await renderPage("/automations", async (host) => {
      await eventually(() => cards(host).length > 0, 3_000, "the rows");
      one = line(host)?.textContent ?? "";
    });
    expect(one).toStartWith("1 more belongs to someone else or to nobody.");

    answer({});
    const none = { line: true, button: true };
    await renderPage("/automations", async (host) => {
      await eventually(() => cards(host).length > 0, 3_000, "the rows");
      none.line = line(host) !== null;
      none.button = showEveryone(host) !== undefined;
    });
    expect(none).toEqual({ line: false, button: false });
  });

  test("with none of their own it is what the empty page says, in place of how to make the first", async () => {
    answer({ "/automations": ok({ automations: [], timezone: "UTC", elsewhere: 2 }), "/automations?whose=everyone": ok({ ...LIST, automations: EVERYONE }) });
    const seen = { text: "", after: "" as string | null };
    try {
      await renderPage("/automations", async (host) => {
        await eventually(() => showEveryone(host) !== undefined, 3_000, "the empty page");
        seen.text = host.querySelector("main")?.textContent ?? "";
        showEveryone(host)!.click();
        await eventually(() => card(host, "cron_n") !== null, 3_000, "everyone's");
        seen.after = dropdown(host, PICKER).holds();
      });
    } finally {
      localStorage.removeItem(KEPT);
    }
    expect(seen.text).toContain("No automations of yours yet");
    expect(seen.text).toContain("2 more belong to other people or to nobody.");
    expect(seen.text).not.toContain("No automations yet");
    expect(seen.text).not.toContain("ask an agent in a chat");
    expect(seen.after).toBe("Everyone");
  });
});

describe("the Automations page, as someone who is not an admin", () => {
  test("offers no picker, and asks for their own whatever this browser kept from an admin before", async () => {
    localStorage.setItem(KEPT, JSON.stringify("everyone"));
    answer(signedIn("operator"));
    const seen = { picker: true, sections: -1, rows: 0 };
    const record = asked();
    try {
      await renderPage("/automations", async (host) => {
        await eventually(() => cards(host).length > 0, 3_000, "the rows");
        seen.picker = dropdown(host, PICKER).button() !== undefined;
        seen.sections = sections(host).length;
        seen.rows = cards(host).length;
      });
    } finally {
      record.restore();
      localStorage.removeItem(KEPT);
    }
    expect(seen).toEqual({ picker: false, sections: 0, rows: 5 });
    expect(record.urls).toEqual([""]);
  });

  test("a row they only read says whose it is where its switch would be, takes no press that changes it, and still opens", async () => {
    const theirs = one("cron_theirs", "Rent reminder", { person: GADING, changeable: false });
    const nobodys = one("cron_nobodys", "Old backup", { changeable: false });
    const proposed = one("cron_asked", "Water the plants", { person: GADING, changeable: false, enabled: false, proposal: { by: "nouva", at: 1 } });
    const own = one("cron_own", "Morning brief", { person: SAM, changeable: true });
    answer({ ...signedIn("operator"), "/automations": ok({ ...LIST, automations: [theirs, nobodys, proposed, own] }) });
    const seen: Record<string, { switches: number; buttons: string[]; whose: string | null; href: string | null }> = {};
    await renderPage("/automations", async (host) => {
      await eventually(() => cards(host).length === 4, 3_000, "the rows");
      for (const row of cards(host)) {
        seen[row.dataset.automation!] = {
          switches: row.querySelectorAll('[role="switch"]').length,
          buttons: [...row.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? ""),
          whose: row.querySelector("[data-tag]")?.textContent?.trim() ?? null,
          href: row.querySelector("h2 a")?.getAttribute("href") ?? null,
        };
      }
    });
    expect(seen.cron_theirs).toEqual({ switches: 0, buttons: [], whose: "Gading's", href: "/dashboard/automations/cron_theirs" });
    expect(seen.cron_nobodys).toEqual({ switches: 0, buttons: [], whose: "Nobody's", href: "/dashboard/automations/cron_nobodys" });
    // One an agent proposed that is not theirs to answer has neither answer.
    expect(seen.cron_asked).toEqual({ switches: 0, buttons: [], whose: "Gading's", href: "/dashboard/automations/cron_asked" });
    // Their own keeps its switch and says nothing of whose: it is on their list.
    expect(seen.cron_own).toEqual({ switches: 1, buttons: [], whose: null, href: "/dashboard/automations/cron_own" });
  });

  test("a row from a daemon that does not say whether it may be changed keeps its switch", async () => {
    const { changeable: _changeable, ...older } = one("cron_older", "Morning brief", { person: GADING });
    answer({ ...signedIn("operator"), "/automations": ok({ ...LIST, automations: [older] }) });
    let switches = -1;
    await renderPage("/automations", async (host) => {
      await eventually(() => cards(host).length === 1, 3_000, "the row");
      switches = host.querySelectorAll('main [role="switch"]').length;
    });
    expect(switches).toBe(1);
  });
});
