/**
 * What skill learning holds and what it did lately, under the drafts on the Skills page's Pending tab: each kind of
 * work seen once, with how often and by whom, written now or forgotten on a press, and the reasons learning gave
 * when it wrote nothing. An empty queue used to be all the page said.
 */

import { describe, expect, test } from "bun:test";
import type { LearningEvent, LearningSeen } from "@nouride/wire";
import { eventSaid } from "@/modules/skills/seen.panel";
import { readsSaid } from "@/modules/skills/pool.list";
import { answer, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const event = (over: Partial<LearningEvent>): LearningEvent => ({ at: Date.now() - 2 * 3_600_000, agentId: "nouva", kind: "nothing", skill: null, why: "", ...over });

describe("the words", () => {
  test("each thing learning did reads as a sentence, with its reason", () => {
    expect(eventSaid(event({ kind: "nothing", why: "a number looked up, nothing done" }))).toBe("Looked, and found nothing to write down: a number looked up, nothing done");
    expect(eventSaid(event({ kind: "held", skill: "website-feature-development", why: "Use when changing the site." }))).toBe("Saw a new kind of work once, and is waiting for it to come back: Website feature development");
    expect(eventSaid(event({ kind: "refused", skill: "site-contributing", why: "its body is 12,838 characters, past 12,000" }))).toBe("Wrote a draft for Site contributing and it was not kept: its body is 12,838 characters, past 12,000");
    expect(eventSaid(event({ kind: "drafted", skill: "invoice-reading" }))).toBe("Wrote a draft, waiting on you: Invoice reading");
    expect(eventSaid(event({ kind: "written", skill: "site-moving" }))).toBe("Added a skill: Site moving");
    expect(eventSaid(event({ kind: "improved", skill: "site-moving" }))).toBe("Improved a skill: Site moving");
  });

  test("how often a skill is read, and how often since it was changed", () => {
    expect(readsSaid(1, 1)).toBe("read once");
    expect(readsSaid(12, 12)).toBe("read 12 times");
    expect(readsSaid(12, 3)).toBe("read 12 times, 3 times since it was changed");
    expect(readsSaid(12, 1)).toBe("read 12 times, once since it was changed");
    expect(readsSaid(12, 0)).toBe("read 12 times, not yet since it was changed");
  });
});

const agent = { id: "nexa", displayName: "Nexa", enabled: true, decided: false, missingTools: [] };
const CATALOG = ok({
  skills: [{ name: "pdf", description: "Read a PDF.", scope: "shared", path: "/srv/skills/pdf/SKILL.md", requires: [], missing: [], needsTools: [], offGlobally: false, lastUsedAt: 1_795_000_000_000, reads: 12, readsSinceChange: 3, agents: [agent] }],
  software: [],
  poolDir: "/srv/skills",
  editable: true,
});
const SEEN: LearningSeen = {
  seen: [
    { name: "website-feature-development", description: "Use when changing a site's components and layout.", why: "three corrections", agentId: "nexa", firstSeenAt: Date.now() - 7 * 86_400_000, lastSeenAt: Date.now() - 3 * 3_600_000, sightings: 12, canWrite: true, writtenNext: true },
    { name: "image-aspect-reframing", description: "Use when a picture has to fit another shape.", why: "worked once", agentId: "nexa", firstSeenAt: Date.now() - 86_400_000, lastSeenAt: Date.now() - 86_400_000, sightings: 1, canWrite: false, writtenNext: false },
  ],
  recent: [event({ agentId: "nexa", kind: "nothing", why: "a question answered, nothing done" }), event({ agentId: null, kind: "improved", skill: "pdf" })],
};
const openPending = async (host: HTMLElement) => {
  await eventually(() => host.querySelector('[role="tab"]') !== null, 3_000, "the tabs");
  ([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes("Pending")) as HTMLElement).click();
  await eventually(() => host.textContent?.includes("seen, not a skill yet") === true, 3_000, "the panel");
};
const rowOf = (host: HTMLElement, name: string) => [...host.querySelectorAll("li")].find((row) => row.querySelector("p")?.textContent === name) as HTMLElement;

describe("the panel, under the drafts", () => {
  test("each kind of work seen once: its name as words, who saw it and how often, and what can be done", async () => {
    answer({ "/skills/catalog": CATALOG, "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }), "/skills/learning/seen": ok(SEEN) });
    const seen = { title: "", first: "", firstButtons: [] as string[], second: "", secondButtons: [] as string[], lately: [] as string[], pool: "" };
    await renderPage("/skills", async (host) => {
      // The pool's row says the reads beside the date.
      await eventually(() => host.textContent?.includes("read 12 times") === true, 3_000, "the pool's reads");
      seen.pool = [...host.querySelectorAll("div")].find((box) => box.textContent === "read 12 times, 3 times since it was changed")?.textContent ?? "";
      await openPending(host);
      seen.title = [...host.querySelectorAll("h2, h3")].map((heading) => heading.textContent ?? "").find((text) => text.includes("not a skill yet")) ?? "";
      const first = rowOf(host, "Website feature development");
      seen.first = first.textContent ?? "";
      seen.firstButtons = [...first.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
      const second = rowOf(host, "Image aspect reframing");
      seen.second = second.textContent ?? "";
      seen.secondButtons = [...second.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
      seen.lately = [...host.querySelectorAll("li.text-xs")].map((line) => line.textContent ?? "");
    });
    expect(seen.pool).toBe("read 12 times, 3 times since it was changed");
    expect(seen.title).toBe("2 seen, not a skill yet");
    expect(seen.first).toContain("Use when changing a site's components and layout.");
    expect(seen.first).toContain("Nexa · seen 12 times · last 3 h ago");
    // Seen often enough: said, so nobody wonders what it still waits for. The one seen once says nothing of it.
    expect(seen.first).toContain("It becomes a skill the next time this work is seen.");
    expect(seen.second).not.toContain("It becomes a skill the next time");
    expect(seen.firstButtons).toEqual(["Write it now", "Forget"]);
    // Its conversation is gone: said, and only forgetting is offered.
    expect(seen.second).toContain("Nexa · seen once");
    expect(seen.second).toContain("The conversation it was seen in is gone. It is written when the work comes back.");
    expect(seen.secondButtons).toEqual(["Forget"]);
    expect(seen.lately[0]).toContain("Nexa · 2 h ago · Looked, and found nothing to write down: a question answered, nothing done");
    expect(seen.lately[1]).toContain("The weekly review · 2 h ago · Improved a skill: Pdf");
  });

  test("Write it now asks for that kind of work, and what could not be written is said under its row", async () => {
    answer({ "/skills/catalog": CATALOG, "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }), "/skills/learning/seen": ok(SEEN) });
    const { posts, restore } = recordPosts({ "/skills/learning/seen/website-feature-development/write": { status: 409, body: { error: "its draft was refused", plain: "The agent looked at that conversation again and no skill was kept from it." } } });
    let said = "";
    try {
      await renderPage("/skills", async (host) => {
        await openPending(host);
        (rowOf(host, "Website feature development").querySelector("button") as HTMLElement).click();
        await eventually(() => rowOf(host, "Website feature development").textContent?.includes("no skill was kept") === true, 3_000, "the reason");
        said = rowOf(host, "Website feature development").textContent ?? "";
      });
    } finally {
      restore();
    }
    expect(posts.map((post) => post.path)).toEqual(["/skills/learning/seen/website-feature-development/write"]);
    expect(said).toContain("The agent looked at that conversation again and no skill was kept from it.");
  });

  test("somebody who may only look sees what is held, and no button", async () => {
    answer({ "/skills/catalog": ok({ ...(CATALOG.body as object), editable: false }), "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }), "/skills/learning/seen": ok(SEEN) });
    let buttons: string[] = ["?"];
    await renderPage("/skills", async (host) => {
      await openPending(host);
      buttons = [...rowOf(host, "Website feature development").querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
    });
    expect(buttons).toEqual([]);
  });

  test("nothing held says so, and says when something would be", async () => {
    answer({ "/skills/catalog": CATALOG, "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }), "/skills/learning/seen": ok({ seen: [], recent: [] }) });
    let text = "";
    await renderPage("/skills", async (host) => {
      await eventually(() => host.querySelector('[role="tab"]') !== null, 3_000, "the tabs");
      ([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes("Pending")) as HTMLElement).click();
      await eventually(() => host.textContent?.includes("Nothing held") === true, 3_000, "the empty panel");
      text = host.textContent ?? "";
    });
    expect(text).toContain("When an agent does a new kind of work, it shows here until the work comes back.");
    expect(text).not.toContain("What learning did lately");
  });
});
