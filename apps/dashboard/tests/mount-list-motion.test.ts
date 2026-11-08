/**
 * Lists on the real pages move where they change: a mission that changes state leaves its group and enters the next,
 * lit as it arrives; a new answer in a chat moves in, not the question already drawn above it nor what the conversation
 * opened on; a document added enters at the top of its collection. The daemon's answers are the engine's own
 * (`fixtures/wire.json`), changed as a later poll would find them.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const classes = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/);

describe("Missions", () => {
  test("one that changes state leaves its group, out of reach, and enters the next, lit; the one that did not stays still", async () => {
    const wire = WIRE["/missions"] as { missions: Record<string, unknown>[] };
    const ended = wire.missions.find((mission) => mission.id === "msn_2")!;
    let seen = { leaving: [] as string[], entering: [] as string[], lit: false, still: [] as string[], working: true };
    await renderPage("/missions", async (host, app) => {
      const cardIn = (group: string, id: string) => host.querySelector(`section[aria-label="${group}"] a[href$="/missions/${id}"]`);
      await eventually(() => cardIn("Working", "msn_1") !== null, 4_000, "msn_1 working");
      answer({
        "/missions": {
          status: 200,
          body: { ...wire, missions: wire.missions.map((mission) => (mission.id === "msn_1" ? { ...mission, status: "stopped", seen: "ended", endedAt: ended.endedAt, reason: "stopped by tester" } : mission)) },
        },
      });
      await app.queryClient.invalidateQueries({ queryKey: ["missions"] });
      await eventually(() => cardIn("Finished", "msn_1") !== null, 4_000, "msn_1 finished");
      seen = {
        leaving: classes(cardIn("Working", "msn_1")),
        entering: classes(cardIn("Finished", "msn_1")),
        lit: cardIn("Finished", "msn_1")?.querySelector(".animate-lit") !== null,
        still: classes(cardIn("Finished", "msn_2")),
        working: true,
      };
      await eventually(() => host.querySelector('section[aria-label="Working"]') === null, 2_000, "the Working group to go with its last card");
      seen.working = false;
    });
    expect(seen.leaving).toEqual(expect.arrayContaining(["animate-leave", "pointer-events-none"]));
    expect(seen.entering).toContain("animate-enter");
    expect(seen.lit).toBe(true);
    expect(seen.still).not.toContain("animate-enter");
    expect(seen.still).not.toContain("animate-leave");
    expect(seen.working).toBe(false);
  });

  test("one the search hides neither leaves nor enters when it shows again: typing moves nothing", async () => {
    let shown: string[] = [];
    await renderPage("/missions", async (host) => {
      const card = (id: string) => host.querySelector(`a[href$="/missions/${id}"]`);
      await eventually(() => card("msn_2") !== null, 4_000, "msn_2");
      const search = host.querySelector<HTMLInputElement>('input[placeholder="Search missions"]')!;
      const type = (text: string) => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(search), "value")!.set!.call(search, text);
        search.dispatchEvent(new (search.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
      };
      type("msn_1");
      await eventually(() => card("msn_2") === null, 2_000, "msn_2 hidden by the search");
      type("");
      await eventually(() => card("msn_2") !== null, 2_000, "msn_2 shown again");
      shown = classes(card("msn_2"));
    });
    expect(shown).not.toContain("animate-enter");
    expect(shown).not.toContain("animate-leave");
  });
});

describe("a chat", () => {
  test("moves in a new answer, not its question nor what the conversation opened on", async () => {
    const wire = WIRE["/sessions/ses_1/turns"] as { turns: Record<string, unknown>[] };
    const first = wire.turns[0]!;
    let seen = { opened: [] as string[][], answer: [] as string[], question: [] as string[] };
    await renderPage("/chat/ses_1", async (host, app) => {
      const answers = () => [...host.querySelectorAll('[class~="origin-top-left"]')];
      await eventually(() => host.textContent?.includes("No — 40% used.") ?? false, 4_000, "the conversation");
      const opened = answers().length;
      answer({
        "/sessions/ses_1/turns": {
          status: 200,
          body: { ...wire, turns: [...wire.turns, { ...first, id: "turn_3", prompt: "and the other disk?", reply: "Also fine.", startedAt: Number(first.startedAt) + 60_000, endedAt: Number(first.endedAt) + 61_000 }] },
        },
      });
      await app.queryClient.invalidateQueries({ queryKey: ["transcript", "ses_1"] });
      await eventually(() => answers().length === opened + 1, 4_000, "the new answer");
      const question = [...host.querySelectorAll('[class~="origin-bottom-right"]')].find((bubble) => bubble.textContent?.includes("and the other disk?"));
      const added = answers().find((reply) => reply.textContent?.includes("Also fine."));
      seen = { opened: answers().filter((reply) => reply !== added).map(classes), answer: classes(added), question: classes(question) };
    });
    expect(seen.opened.length).toBeGreaterThan(0);
    for (const reply of seen.opened) expect(reply).not.toContain("animate-enter");
    expect(seen.answer).toContain("animate-enter");
    expect(seen.question).not.toContain("animate-enter");
  });
});

describe("a collection's documents", () => {
  test("a document added enters at the top; those it opened with stay still", async () => {
    const wire = WIRE["/knowledge/house/documents"] as { documents: Record<string, unknown>[] };
    const model = wire.documents.find((document) => document.path === "wifi.md")!;
    let rows: string[][] = [];
    await renderPage("/memories", async (host, app) => {
      const body = host.ownerDocument.body;
      const card = () => body.querySelector('article[aria-label="House"]');
      await eventually(() => card() !== null, 4_000, "the House card");
      ([...card()!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Open") as HTMLElement).click();
      const items = () => [...body.querySelectorAll('section[aria-label="Documents"] li')];
      await eventually(() => items().length === wire.documents.length, 4_000, "the documents");
      answer({
        "/knowledge/house/documents": {
          status: 200,
          body: { ...wire, documents: [...wire.documents, { ...model, path: "boiler.md", title: "Boiler", mtime: Number(model.mtime) + 86_400_000 }] },
        },
      });
      await app.queryClient.invalidateQueries({ queryKey: ["knowledge-documents", "house"] });
      await eventually(() => items().length === wire.documents.length + 1, 4_000, "the new document");
      rows = items().map((item) => [item.textContent?.includes("Boiler") ? "Boiler" : "other", ...classes(item)]);
    });
    expect(rows[0]).toEqual(expect.arrayContaining(["Boiler", "animate-enter"]));
    for (const row of rows.slice(1)) expect(row).not.toContain("animate-enter");
  });
});

describe("the first one in an empty list", () => {
  test("a document added to an empty collection enters", async () => {
    const wire = WIRE["/knowledge/house/documents"] as { documents: Record<string, unknown>[] };
    let row: string[] = [];
    await renderPage("/memories", async (host, app) => {
      answer({ "/knowledge/house/documents": { status: 200, body: { ...wire, documents: [] } } });
      const body = host.ownerDocument.body;
      const card = () => body.querySelector('article[aria-label="House"]');
      await eventually(() => card() !== null, 4_000, "the House card");
      ([...card()!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Open") as HTMLElement).click();
      await eventually(() => body.textContent?.includes("No documents yet") ?? false, 4_000, "the empty collection");
      answer({ "/knowledge/house/documents": { status: 200, body: { ...wire, documents: [wire.documents[0]] } } });
      await app.queryClient.invalidateQueries({ queryKey: ["knowledge-documents", "house"] });
      await eventually(() => body.querySelector('section[aria-label="Documents"] li') !== null, 4_000, "the first document");
      row = classes(body.querySelector('section[aria-label="Documents"] li'));
    });
    expect(row).toContain("animate-enter");
  });

  test("the first mission enters, as one in a list already would", async () => {
    const wire = WIRE["/missions"] as { missions: Record<string, unknown>[] };
    let card: string[] = [];
    await renderPage("/missions", async (host, app) => {
      answer({ "/missions": { status: 200, body: { ...wire, missions: [] } } });
      await app.queryClient.invalidateQueries({ queryKey: ["missions"] });
      await eventually(() => host.textContent?.includes("No missions in the last") ?? false, 4_000, "no missions");
      answer({ "/missions": { status: 200, body: { ...wire, missions: [wire.missions[0]] } } });
      await app.queryClient.invalidateQueries({ queryKey: ["missions"] });
      await eventually(() => host.querySelector('a[href$="/missions/msn_1"]') !== null, 4_000, "the first mission");
      card = classes(host.querySelector('a[href$="/missions/msn_1"]'));
    });
    expect(card).toContain("animate-enter");
  });

  test("the first background helper enters", async () => {
    const started = Date.now() - 60_000;
    const job = { id: "job_1", agentId: "nouva", gatewayId: null, chatId: "555", command: "helper: Render the video", kind: "helper", cwd: "/srv/work", status: "running", pid: null, exitCode: null, startedAt: started, endedAt: null, logBytes: 0, logUpdatedAt: started, processAlive: true, brief: null, report: null, turnId: null };
    let row: string[] = [];
    await renderPage("/jobs", async (host, app) => {
      await eventually(() => host.textContent?.includes("Nothing has run in the background yet") ?? false, 4_000, "no jobs");
      answer({ "/jobs": { status: 200, body: { jobs: [job] } } });
      await app.queryClient.invalidateQueries();
      await eventually(() => host.querySelector('a[href$="/jobs/job_1"]') !== null, 4_000, "the first job");
      row = classes(host.querySelector('a[href$="/jobs/job_1"]'));
    });
    expect(row).toContain("animate-enter");
  });
});
