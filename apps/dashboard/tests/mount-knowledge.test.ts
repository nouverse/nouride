/**
 * The Knowledge tab, mounted (0.8.20): the menu's first tab, over the engine's own answers
 * (`fixtures/wire.json`): a card per collection in sentences, a collection made by an operator for themselves and by an
 * admin for more, files dropped and shown as being read, a document that could not be read with why and the Ask button,
 * a document opened with its sections and its related ones, search on a button, what waits for an admin's yes, archive
 * and delete, a document written; on People, the documents about someone; in the graph, the documents' layer.
 *
 * What the engine does not answer yet is stubbed in the shape agreed for it: a row's `needs`, and the documents waiting
 * for a yes (`GET /knowledge/:id/pending`, built on another branch).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answer, dom, renderPage, RESPONSES, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const ME = RESPONSES["/auth/me"] as { role: string; user: Record<string, unknown> };
const asOperator = { "/auth/me": ok({ ...ME, role: "operator", user: { ...ME.user, role: "operator" } }) };
const HOUSE = WIRE["/knowledge/house/documents"] as { documents: Record<string, unknown>[] };
const STATUS = RESPONSES["/status"] as Record<string, unknown>;

/** What the page sent: every control request, its method, path, query and body (a form by its files' names). */
interface Sent {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

/**
 * Every control request from here on, recorded; a write named in `answers` (`"POST /knowledge"`) is answered from it,
 * after `hold` when it has one, and every other request goes on to the harness.
 */
function spy(answers: Record<string, { status: number; body: unknown; hold?: Promise<void> }> = {}) {
  const sent: Sent[] = [];
  const before = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
    if (url.pathname.startsWith("/api/control")) {
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api\/control/, "");
      const body = init?.body instanceof FormData ? { files: [...init.body.getAll("files")].map((file) => (file as File).name) } : init?.body ? JSON.parse(String(init.body)) : null;
      sent.push({ method, path, query: url.search, body });
      const answer = answers[`${method} ${path}`];
      if (answer) {
        await answer.hold;
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
      }
    }
    return (before as typeof fetch)(input as RequestInfo, init);
  }) as typeof fetch;
  return { sent, restore: () => void (globalThis.fetch = before) };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});
// This file reads the whole body, where dialogs are drawn: cleared first, so each test reads only its own page.
beforeEach(() => {
  dom.document.body.innerHTML = "";
});
const watch = (answers?: Parameters<typeof spy>[0]) => {
  const recorder = spy(answers);
  restore = recorder.restore;
  return recorder.sent;
};

/** The page and every dialog over it: a dialog is drawn at the body, not in the page. */
const body = () => dom.document.body as unknown as HTMLElement;
const text = () => body().textContent ?? "";
const shows = (words: string, what = `"${words}"`) => eventually(() => text().includes(words), 3_000, what);
const button = (label: string) => [...body().querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = (label: string) => {
  const found = button(label);
  if (!found) throw new Error(`no button "${label}"`);
  found.click();
};
/** Pressed once it is there: a collection's documents come in their own request, after its page opens. */
const pressWhenShown = async (label: string) => {
  await eventually(() => button(label) !== undefined, 3_000, `the "${label}" button`);
  click(label);
};
const card = (name: string) => body().querySelector(`article[aria-label="${name}"]`) as HTMLElement;
const open = async (name: string) => {
  await eventually(() => card(name) !== null, 3_000, `the ${name} card`);
  ([...card(name).querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Open") as HTMLButtonElement).click();
  await shows("All collections", `${name} opened`);
};

describe("the Knowledge tab", () => {
  test("first, open on the page: a card per collection, its settings in sentences, the archived apart", async () => {
    answer({ "/people/me": ok({ person: { key: "gading", name: "Gading" } }) });
    await renderPage("/memories", async () => {
      await shows("Old notes");
      // The menu's name since the documents joined memory there, and the page's.
      expect([...body().querySelectorAll('a[href="/dashboard/memories"]')].map((link) => link.textContent?.trim())).toContain("Knowledge & Memory");
      expect(body().querySelector("h1")?.textContent).toBe("Knowledge & Memory");
      expect(body().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Knowledge");
      expect(card("House").textContent).toContain("Your agents may answer anyone from it.");
      expect(card("House").textContent).toContain("Every agent looks in it.");
      expect(card("House").textContent).toContain("3 documents · 3 sections");
      expect(card("Kak Sam's check-ups").textContent).toContain("Your agents may answer only you and Kak Sam from it, each in a chat with just them.");
      expect(card("Kak Sam's check-ups").textContent).toContain("Only Nouva looks in it.");
      expect(card("Kak Sam's check-ups").textContent).toContain("About Kak Sam.");
      expect(card("Family").textContent).toContain("Your agents may answer the Rumah group from it.");
      const archived = body().querySelector('section[aria-label="Archived"]') as HTMLElement;
      expect(archived.textContent).toContain("Old notes");
      expect(card("Old notes").textContent).toContain("Archived");
      expect(card("Old notes").textContent).toContain("Your agents may answer only the admins from it, each in a chat with just them.");
    });
  });

  test("settings that could not be read are said, what is wrong under Details; no collection at all says how to start", async () => {
    const [house] = (WIRE["/knowledge"] as { collections: Record<string, unknown>[] }).collections.filter((collection) => collection.id === "house");
    answer({ "/knowledge": ok({ collections: [{ ...house, readers: { kind: "admins" }, problem: 'readers is 42: write "everyone", "admins", "group:<chat>", or a list of people\'s keys' }] }) });
    await renderPage("/memories", async () => {
      await shows("Its settings could not be read, so only the admins can be answered from it until they are fixed.");
      const details = card("House").querySelector("details") as HTMLElement;
      expect(details.querySelector("summary")?.textContent).toBe("Details");
      expect(details.textContent).toContain("readers is 42");
    });
    answer({ "/knowledge": ok({ collections: [] }) });
    await renderPage("/memories", async () => {
      await shows("No collections yet");
      expect(text()).toContain("Make one, then drop files on it or write a document in it.");
    });
  });

  test("a new collection: an admin may open it to everyone, a group or chosen people", async () => {
    const sent = watch({ "POST /knowledge": ok({ collection: null }) });
    await renderPage("/memories", async () => {
      await shows("House");
      click("New collection");
      await shows("Who may be answered from it");
      for (const choice of ["Only me", "Everyone", "One group", "Chosen people"]) expect(text()).toContain(choice);
      type(body().querySelector('input[placeholder="Mum\'s health"]') as HTMLInputElement, "Price lists");
      type(body().querySelector('input[placeholder="Lab results and check-up dates"]') as HTMLInputElement, "What things cost");
      const everyone = [...body().querySelectorAll("label")].find((label) => label.textContent?.startsWith("Everyone"))!.querySelector("input") as HTMLInputElement;
      everyone.click();
      await eventually(() => button("Make collection")?.disabled === false, 2_000, "Make collection enabled");
      click("Make collection");
      await eventually(() => sent.some((request) => request.method === "POST"), 2_000, "the collection made");
    });
    expect(sent.filter((request) => request.method === "POST")).toEqual([
      { method: "POST", path: "/knowledge", query: "", body: { name: "Price lists", description: "What things cost", agents: null, about: [], readers: { kind: "everyone" } } },
    ]);
  });

  test("a new collection: an operator keeps it to themselves, and is told when that means the admins", async () => {
    answer(asOperator);
    const sent = watch({ "POST /knowledge": ok({ collection: null }) });
    await renderPage("/memories", async () => {
      await shows("House");
      click("New collection");
      await shows("Who may be answered from it");
      expect(text()).toContain("Only me");
      expect(text()).toContain("Your account is not linked to anyone in People, so only the admins can be answered from it.");
      const choices = [...body().querySelectorAll('[role="dialog"] label')].filter((label) => label.querySelector('input[type="radio"]')).map((label) => label.textContent ?? "");
      expect(choices.some((choice) => choice.startsWith("Only me"))).toBe(true);
      for (const wider of ["Everyone", "One group", "Chosen people"]) expect(choices.some((choice) => choice.startsWith(wider))).toBe(false);
      type(body().querySelector('input[placeholder="Mum\'s health"]') as HTMLInputElement, "My notes");
      await eventually(() => button("Make collection")?.disabled === false, 2_000, "Make collection enabled");
      click("Make collection");
      await eventually(() => sent.some((request) => request.method === "POST"), 2_000, "the collection made");
    });
    const made = sent.find((request) => request.method === "POST")!.body as Record<string, unknown>;
    expect(made).toEqual({ name: "My notes", description: "", agents: null, about: [] });
  });
});

describe("documents", () => {
  test("files dropped on a card are added, being read until they are, then said", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const sent = watch({ "POST /knowledge/house/documents": { status: 201, body: { saved: [{ path: "bins.txt", status: "indexed" }] }, hold } });
    await renderPage("/memories", async () => {
      await eventually(() => card("House") !== null, 3_000, "the House card");
      const window = dom as unknown as typeof globalThis;
      const drop = new window.Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["Bins go out on Tuesday."], "bins.txt", { type: "text/plain" })] } });
      card("House").dispatchEvent(drop);
      await eventually(() => card("House").textContent?.includes("Reading 1 file") === true, 2_000, "the card reading the file");
      await open("House");
      await shows("Being read");
      expect(sent.find((request) => request.method === "POST")?.body).toEqual({ files: ["bins.txt"] });
      release();
      await shows("Added to House");
      await eventually(() => !text().includes("Being read"), 2_000, "the file no longer being read");
    });
  });

  test("a document that could not be read says why; where a program is missing, the orchestrator is asked to install it", async () => {
    const pdf = { ...HOUSE.documents[1], path: "lab.pdf", title: "lab", status: "unreadable", reason: "A program that reads PDF files is not installed, so it is kept here but not searched.", needs: "poppler-utils", sections: 0 };
    answer({ "/status": ok({ ...STATUS, orchestrator: "nouva" }), "/knowledge/house/documents": ok({ documents: [...HOUSE.documents, pdf] }) });
    await renderPage("/memories", async (host, app) => {
      await open("House");
      await shows("A program that reads PDF files is not installed");
      const row = (title: string) => [...body().querySelectorAll("li")].find((candidate) => candidate.querySelector("button")?.textContent === title)!;
      expect(row("Router").textContent).toContain("Ready");
      const lab = row("lab");
      expect(lab.textContent).toContain("Could not be read");
      expect(lab.textContent).toContain("lab.pdf");
      const details = lab.querySelector("details") as HTMLElement;
      expect(details.querySelector("summary")?.textContent).toBe("Details");
      expect(details.textContent).toContain("It needs the poppler-utils package.");
      // Kept, not read: a photo says why, and asks nothing.
      const porch = row("porch");
      expect(porch.textContent).toContain("Kept, not searched");
      expect(porch.textContent).toContain("Nouride does not read this kind of file, so it is kept here but not searched.");
      expect(porch.querySelector("a")).toBeNull();
      // The Ask button opens the chat with Nouva, the request in the box for the person to send.
      const ask = lab.querySelector("a") as HTMLAnchorElement;
      expect(ask.textContent?.trim()).toBe("Ask Nouva to install it");
      ask.click();
      await eventually(() => app.location().endsWith("/chat"), 3_000, "the chat");
      await eventually(() => host.querySelector("textarea")?.value === 'Please install the poppler-utils package, so the knowledge base can read "lab" in House.', 3_000, "the request in the box");
    });
  });

  test("a document opened: its sections as search sees them, and its related documents, each one a click away", async () => {
    // The documents answered only once the collection's page is open, as on a slow runner: CI pressed "Router" before
    // its row was drawn.
    const late = Promise.withResolvers<void>();
    const sent = watch({ "GET /knowledge/house/documents": { status: 200, body: HOUSE, hold: late.promise } });
    await renderPage("/memories", async () => {
      await open("House");
      late.resolve();
      await pressWhenShown("Router");
      await shows("As search sees it");
      expect(text()).toContain("Router › Wifi");
      expect(text()).toContain("The password is in [[Wifi]].");
      await shows("Related documents");
      await shows("in Kak Sam's check-ups");
      const related = [...body().querySelectorAll('[role="dialog"] button')].find((candidate) => candidate.textContent?.startsWith("Wifi")) as HTMLButtonElement;
      related.click();
      await eventually(() => sent.some((request) => request.path === "/knowledge/house/document" && request.query === "?path=wifi.md"), 2_000, "the related document opened");
    });
  });

  test("its related documents wait for search by meaning, and say so", async () => {
    answer({ "/knowledge/house/related": ok({ byMeaning: false, related: [] }) });
    await renderPage("/memories", async () => {
      await open("House");
      await pressWhenShown("Router");
      await shows("Shown when search by meaning is on. It is set in the Settings tab.");
    });
  });

  // A file just dropped landed where its name sorted, and nothing said which one was new.
  test("newest first, each saying when it was added", async () => {
    const [porch, router, wifi] = HOUSE.documents as Record<string, unknown>[];
    const now = Date.now();
    answer({ "/knowledge/house/documents": ok({ documents: [{ ...porch, mtime: now - 3 * 86_400_000 }, { ...router, mtime: now - 2 * 3_600_000 }, { ...wifi, mtime: now - 30_000 }] }) });
    await renderPage("/memories", async () => {
      await open("House");
      await shows("Added just now");
      const rows = [...body().querySelectorAll("li")].map((row) => row.querySelector("button")?.textContent).filter(Boolean);
      expect(rows).toEqual(["Wifi", "Router", "porch"]);
      expect(text()).toContain("Added 2 h ago");
      expect(text()).toContain("Added 3 days ago");
    });
  });

  test("a document's title set on its row, and taken off again; the file keeps its name", async () => {
    const titled = { ...(HOUSE.documents[1] as Record<string, unknown>), title: "Router setup" };
    const sent = watch({ "PATCH /knowledge/house/documents": { status: 200, body: { document: titled } } });
    await renderPage("/memories", async () => {
      await open("House");
      await eventually(() => body().querySelector('button[aria-label="Change the title of Router"]') !== null, 3_000, "the title button");
      (body().querySelector('button[aria-label="Change the title of Router"]') as HTMLButtonElement).click();
      await shows("router.md keeps its name.");
      expect(text()).toContain("Written in English, your agents find it whatever language they search in.");
      const input = body().querySelector('[role="dialog"] input[aria-label="Title"]') as HTMLInputElement;
      expect(input.value).toBe("Router");
      type(input, "Router setup");
      click("Save");
      await shows("Title saved: Router setup");
      await eventually(() => body().querySelector('[role="dialog"] input[aria-label="Title"]') === null, 2_000, "the dialog closed");
      (body().querySelector('button[aria-label="Change the title of Router"]') as HTMLButtonElement).click();
      await eventually(() => body().querySelector('[role="dialog"] input[aria-label="Title"]') !== null, 2_000, "the dialog again");
      type(body().querySelector('[role="dialog"] input[aria-label="Title"]') as HTMLInputElement, "  ");
      click("Save");
      await eventually(() => sent.filter((request) => request.method === "PATCH").length === 2, 2_000, "the second request");
    });
    expect(sent.filter((request) => request.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/knowledge/house/documents", query: "?path=router.md", body: { title: "Router setup" } },
      { method: "PATCH", path: "/knowledge/house/documents", query: "?path=router.md", body: { title: null } },
    ]);
  });

  test("written on the page: a title, Markdown and its preview, saved under the title", async () => {
    const sent = watch({ "POST /knowledge/house/documents": { status: 201, body: { saved: [{ path: "Bins.md", status: "indexed" }] } } });
    await renderPage("/memories", async () => {
      await open("House");
      await pressWhenShown("Write a document");
      await shows("Headings split it into the sections search finds.");
      type(body().querySelector('input[placeholder="How to reset the router"]') as HTMLInputElement, "Bins");
      type(body().querySelector('textarea[aria-label="The document"]') as HTMLTextAreaElement, "# Bins\nOut on Tuesday.");
      click("Preview");
      await eventually(() => body().querySelector('[role="dialog"] h1')?.textContent === "Bins", 2_000, "the preview");
      click("Save");
      await shows("Bins saved to House");
    });
    expect(sent.filter((request) => request.method === "POST")).toEqual([{ method: "POST", path: "/knowledge/house/documents", query: "", body: { name: "Bins", text: "# Bins\nOut on Tuesday." } }]);
  });
});

describe("searching the collections", () => {
  test("asked on the button, never on a key; what an agent would find, each opening its document", async () => {
    const sent = watch();
    await renderPage("/memories", async () => {
      await shows("House");
      type(body().querySelector('input[aria-label="Search your documents"]') as HTMLInputElement, "router");
      await eventually(() => button("Search")?.disabled === false, 2_000, "Search enabled");
      expect(sent.filter((request) => request.path === "/knowledge/search")).toEqual([]);
      click("Search");
      await shows("6 sections found, best first: what your agents would find.");
      expect(sent.filter((request) => request.path === "/knowledge/search").map((request) => request.query)).toEqual(["?q=router"]);
      expect(text()).toContain("House · Router › Wifi");
      ([...body().querySelectorAll('section[aria-label="What search found"] button')][0] as HTMLButtonElement).click();
      await shows("As search sees it");
    });
  });
});

describe("waiting for an admin's yes", () => {
  const waiting = {
    "/knowledge/house/pending": ok({
      pending: [{ path: "prices.md", title: "Price list", savedAt: Date.now() - 2 * 3_600_000, agent: "nouva", from: "Gading, in a chat with Nouva", source: "https://example.com/prices" }],
    }),
  };

  test("an admin sees what waits, from where and when, and approves or declines it", async () => {
    answer(waiting);
    const sent = watch({
      "POST /knowledge/house/pending/approve": ok({ saved: { path: "prices.md", status: "indexed" } }),
      "POST /knowledge/house/pending/decline": ok({ ok: true }),
    });
    await renderPage("/memories", async () => {
      await eventually(() => card("House")?.textContent?.includes("1 waiting for your yes") === true, 3_000, "the card saying one waits");
      await open("House");
      await shows("Waiting for your yes");
      const list = body().querySelector('section[aria-label="Waiting for a yes"]') as HTMLElement;
      expect(list.textContent).toContain("Price list");
      expect(list.textContent).toContain("From Gading, in a chat with Nouva, 2 h ago");
      expect((list.querySelector('a[href="https://example.com/prices"]') as HTMLAnchorElement).textContent).toContain("https://example.com/prices");
      click("Approve");
      await shows("Price list added to House");
      click("Decline");
      await shows("Price list declined");
    });
    expect(sent.filter((request) => request.method === "POST").map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "/knowledge/house/pending/approve", body: { path: "prices.md" } },
      { path: "/knowledge/house/pending/decline", body: { path: "prices.md" } },
    ]);
  });

  test("anyone else sees it waiting, and decides nothing", async () => {
    answer({ ...waiting, ...asOperator });
    await renderPage("/memories", async () => {
      await eventually(() => card("House")?.textContent?.includes("1 waiting for an admin's yes") === true, 3_000, "the card saying one waits");
      await open("House");
      await shows("Waiting for an admin's yes");
      expect(button("Approve")).toBeUndefined();
      expect(button("Decline")).toBeUndefined();
    });
  });
});

describe("a collection's life", () => {
  test("archived and brought back by an operator; deleting is an admin's, and asks first", async () => {
    const sent = watch({ "PATCH /knowledge/house": ok({ collection: null }), "DELETE /knowledge/house": ok({ ok: true }) });
    await renderPage("/memories", async () => {
      await open("House");
      click("Archive");
      await shows("House archived");
      click("Delete");
      await shows("Delete House?");
      expect(text()).toContain("Its 3 documents go with it. The backups made before now keep a copy until they are replaced. This cannot be undone.");
      expect(sent.some((request) => request.method === "DELETE")).toBe(false);
      ([...body().querySelectorAll("dialog button")].find((candidate) => candidate.textContent === "Delete") as HTMLButtonElement).click();
      await shows("House deleted");
    });
    expect(sent.filter((request) => request.method !== "GET").map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "PATCH", path: "/knowledge/house", body: { archived: true } },
      { method: "DELETE", path: "/knowledge/house", body: null },
    ]);
  });

  test("an operator archives, and finds no Delete", async () => {
    answer(asOperator);
    await renderPage("/memories", async () => {
      await open("House");
      expect(button("Archive")).toBeDefined();
      expect(button("Delete")).toBeUndefined();
    });
  });
});

describe("documents about someone", () => {
  test("on their profile in People: the documents of each collection about them; nothing on a profile none is about", async () => {
    await renderPage("/memories", async (host) => {
      ([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "People") as HTMLElement).click();
      await shows("Documents about them");
      const sections = [...body().querySelectorAll('section[aria-label="Documents about them"]')] as HTMLElement[];
      expect(sections).toHaveLength(1);
      expect(sections[0]!.closest("details")?.querySelector("summary")?.textContent).toContain("Kak Sam");
      await eventually(() => sections[0]!.textContent?.includes("Lab results, October") === true, 2_000, "the document about Kak Sam");
      expect(sections[0]!.textContent).toContain("in Kak Sam's check-ups");
      (sections[0]!.querySelector("button") as HTMLButtonElement).click();
      await shows("As search sees it");
    });
  });
});

describe("the documents in the memory graph", () => {
  test("off until asked for; then the layer is asked of the daemon, drawn in the legend, and a document opens from its dot", async () => {
    const sent = watch();
    await renderPage("/memories/graph", async () => {
      await eventually(() => sent.some((request) => request.path === "/memory/graph"), 3_000, "the graph");
      expect(sent.filter((request) => request.path === "/memory/graph").every((request) => !request.query.includes("knowledge"))).toBe(true);
      expect(text()).not.toContain("Collections");
      click("Documents");
      await eventually(() => sent.some((request) => request.path === "/memory/graph" && request.query.includes("knowledge=1")), 2_000, "the layer asked for");
      await shows("Collections");
      await shows("A dashed line joins documents close in meaning.");
      expect(text()).toContain("· 4 documents ·");
      const find = body().querySelector('input[placeholder="Find in the graph"]') as HTMLInputElement;
      type(find, "wifi");
      find.dispatchEvent(new (dom as unknown as typeof globalThis).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await eventually(() => button("Open document") !== undefined, 2_000, "the document's panel");
      click("Open document");
      await eventually(() => sent.some((request) => request.path === "/knowledge/house/document" && request.query === "?path=wifi.md"), 2_000, "the document opened");
    });
  });
});
