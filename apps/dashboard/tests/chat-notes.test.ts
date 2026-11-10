/**
 * The chat's Notes panel (0.7.26): the agent's work notes beside the conversation, and an operator's correction of them.
 *
 * The panel is rendered with the hook the page reads it through, against a stand-in for the two routes, answering with
 * what the daemon's own route answered for a conversation with notes (`fixtures/wire.json`, written by the engine's
 * `tests/contracts/dashboard-wire.test.ts`): a task with sub-headings, the plan kept with it — a step in each state —
 * and a task set aside. And the conversation hook is run as the page runs it, to hold that a turn's end reads them again.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { ChatTurn, LiveTurn, WorkNotes } from "@nouride/wire";
import { stepsDone, withPlans } from "@/modules/chat/lib/notes";
import { eventually } from "./wait.ts";

const WIRE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "wire.json"), "utf8")) as Record<string, unknown>;
/** What `GET /sessions/:id/notes` answered over the daemon's real store. */
const NOTES = WIRE["/sessions/ses_1/notes"] as WorkNotes;
const EMPTY: WorkNotes = { text: "", tasks: [], setAside: null };
const REFUSAL =
  "The notes would be 9214 bytes; they hold 8192. Condense what is finished first — results in a line, steps done as a range — or remove a task that is over.";

/** Left in place after the file, as the conversation hook's other tests leave theirs: React's last commit reads them. */
const GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const;
let dom: Window;
let realFetch: typeof fetch;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The notes routes, as a daemon answers them. `refuse` is the sentence a PUT is refused with. */
interface NotesDaemon {
  notes: WorkNotes;
  refuse?: string;
  reads: number;
  saved: string[];
}

function notesRoute(daemon: NotesDaemon, url: URL, init?: RequestInit): Response | null {
  if (url.pathname !== "/api/control/sessions/ses_1/notes") return null;
  if (init?.method === "PUT") {
    const { text } = JSON.parse(String(init.body)) as { text: string };
    daemon.saved.push(text);
    if (daemon.refuse) return json({ error: daemon.refuse }, 400);
    daemon.notes = { text, tasks: [{ title: "Edited by hand", body: text }], setAside: null };
    return json({ text: daemon.notes.text, tasks: daemon.notes.tasks });
  }
  daemon.reads += 1;
  return json(daemon.notes);
}

function serveNotes(daemon: NotesDaemon): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    notesRoute(daemon, new URL(String(input), "http://localhost"), init) ?? json({ error: "not found" }, 404)) as typeof fetch;
}

/** The panel, open, fed by the hook the page reads the notes through. */
async function mountPanel(editable: boolean): Promise<{ host: HTMLElement; unmount: () => void }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { ToastProvider } = await import("@/commons/components/ui/toast");
  const { NotesPanel } = await import("@/modules/chat/components/NotesPanel");
  const { useWorkNotes } = await import("@/commons/hooks/use-notes");

  const Page = () => {
    const notes = useWorkNotes("ses_1");
    return notes.data
      ? React.createElement(NotesPanel, { open: true, sessionId: "ses_1", notes: notes.data, error: notes.error, editable, onClose: () => {} })
      : null;
  };
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ToastProvider, null, React.createElement(Page))));
  await eventually(() => host.querySelector('[data-drawer][aria-label="Work notes"]') !== null, 2_000, "the panel");
  return {
    host,
    unmount: () => {
      root.unmount();
      host.remove();
      client.clear();
    },
  };
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

function type(area: HTMLTextAreaElement, text: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), "value")!.set!.call(area, text);
  area.dispatchEvent(new (area.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
}

describe("the Notes panel", () => {
  test("each task with its words, the plan under the task it belongs to with each step's state, and how far along it is", async () => {
    serveNotes({ notes: NOTES, reads: 0, saved: [] });
    const view = await mountPanel(true);
    try {
      const task = view.host.querySelector('section[aria-label="Clean the build"]')!;
      expect(task).not.toBeNull();
      expect(task.querySelector("h3")?.textContent).toBe("Clean the build");
      // The task's words, its own headings among them.
      for (const words of ["Goal", "Free space on the build disk.", "Measured the cache: 41 GB.", "Ask before deleting anything."]) {
        expect(task.textContent).toContain(words);
      }
      // The plan is inside its task: a done and a skipped step are settled, as the engine's progress line counts them.
      expect(task.textContent).toContain("2 of 4 done");
      const steps = [...task.querySelectorAll("ol > li")].map((li) => li.textContent);
      expect(steps).toEqual([
        "done: Measure the cache",
        "active: Ask before deleting",
        "pending: Delete artifacts older than a week",
        "skipped: Prune Docker images, skipped: no Docker on this box",
      ]);
      // What the sweep set aside, said once above the tasks.
      expect(view.host.textContent).toContain("untouched for two weeks: Try the remote cache.");
      expect(button(view.host, "Edit")).toBeDefined();
    } finally {
      view.unmount();
    }
  });

  test("with nothing written, one sentence says who writes them", async () => {
    serveNotes({ notes: EMPTY, reads: 0, saved: [] });
    const view = await mountPanel(true);
    try {
      expect(view.host.textContent).toContain("The agent writes notes here as it works on long tasks.");
      expect(view.host.querySelectorAll("section")).toHaveLength(0);
      expect(view.host.textContent).not.toContain("Set aside");
    } finally {
      view.unmount();
    }
  });

  test("Edit is the whole file in one box, and Save sends what was typed — then the notes are read again", async () => {
    const daemon: NotesDaemon = { notes: NOTES, reads: 0, saved: [] };
    serveNotes(daemon);
    const view = await mountPanel(true);
    try {
      button(view.host, "Edit")!.click();
      await eventually(() => view.host.querySelector("textarea") !== null, 2_000, "the editor");
      const area = view.host.querySelector("textarea")!;
      expect(area.value).toBe(NOTES.text);
      // Nothing changed is nothing to save.
      expect(button(view.host, "Save")!.disabled).toBe(true);

      const reads = daemon.reads;
      type(area, "## Edited by hand\n\nUse the staging disk, not prod.");
      await eventually(() => button(view.host, "Save")?.disabled === false, 2_000, "Save to be offered");
      button(view.host, "Save")!.click();

      await eventually(() => view.host.querySelector("textarea") === null, 2_000, "the editor to close");
      expect(daemon.saved).toEqual(["## Edited by hand\n\nUse the staging disk, not prod."]);
      await eventually(() => daemon.reads > reads, 2_000, "the notes read again");
      await eventually(() => view.host.querySelector('section[aria-label="Edited by hand"]') !== null, 2_000, "the saved task");
    } finally {
      view.unmount();
    }
  });

  test("a refusal is said in the daemon's own sentence, and what was typed stays", async () => {
    const daemon: NotesDaemon = { notes: NOTES, refuse: REFUSAL, reads: 0, saved: [] };
    serveNotes(daemon);
    const view = await mountPanel(true);
    try {
      button(view.host, "Edit")!.click();
      await eventually(() => view.host.querySelector("textarea") !== null, 2_000, "the editor");
      type(view.host.querySelector("textarea")!, `${NOTES.text}\n${"x".repeat(9_000)}`);
      await eventually(() => button(view.host, "Save")?.disabled === false, 2_000, "Save to be offered");
      button(view.host, "Save")!.click();

      await eventually(() => view.host.querySelector('[role="alert"]') !== null, 2_000, "the refusal");
      expect(view.host.querySelector('[role="alert"]')!.textContent).toBe(REFUSAL);
      expect(daemon.saved).toHaveLength(1);
      expect(view.host.querySelector("textarea")!.value).toEndWith("x".repeat(9_000));
    } finally {
      view.unmount();
    }
  });

  test("Cancel goes back to the notes and sends nothing", async () => {
    const daemon: NotesDaemon = { notes: NOTES, reads: 0, saved: [] };
    serveNotes(daemon);
    const view = await mountPanel(true);
    try {
      button(view.host, "Edit")!.click();
      await eventually(() => view.host.querySelector("textarea") !== null, 2_000, "the editor");
      type(view.host.querySelector("textarea")!, "## Something else");
      button(view.host, "Cancel")!.click();
      await eventually(() => view.host.querySelector("textarea") === null, 2_000, "the editor to close");
      expect(daemon.saved).toEqual([]);
      expect(view.host.querySelector('section[aria-label="Clean the build"]')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("a viewer reads them, and is offered no Edit", async () => {
    serveNotes({ notes: NOTES, reads: 0, saved: [] });
    const view = await mountPanel(false);
    try {
      expect(view.host.querySelector('section[aria-label="Clean the build"]')).not.toBeNull();
      expect(button(view.host, "Edit")).toBeUndefined();
    } finally {
      view.unmount();
    }
  });
});

describe("which task a plan goes under", () => {
  const steps = [
    { text: "a", state: "done" as const },
    { text: "b", state: "skipped" as const, reason: "not needed" },
    { text: "c", state: "active" as const },
  ];

  test("the one of its name, matched as the daemon matches titles — case and spacing aside", () => {
    const shown = withPlans([{ title: "Other", body: "" }, { title: "Clean  the Build", body: "x" }], { task: "clean the build", steps, updatedAt: 0 });
    expect(shown.map((entry) => [entry.task.title, Boolean(entry.plan)])).toEqual([["Other", false], ["Clean  the Build", true]]);
  });

  test("one whose task is gone is kept under its own name, not dropped", () => {
    const shown = withPlans([{ title: "Other", body: "" }], { task: "Renamed away", steps, updatedAt: 0 });
    expect(shown.map((entry) => [entry.task.title, Boolean(entry.plan)])).toEqual([["Other", false], ["Renamed away", true]]);
  });

  test("a skipped step counts as settled, as the engine's progress line counts it", () => {
    expect(stepsDone(steps)).toBe(2);
  });
});

describe("a turn's end reads the notes again", () => {
  function turnOf(id: string, status: ChatTurn["status"]): LiveTurn {
    return { id, agentId: "nouva", chatId: "web-1", sessionId: "ses_1", status, prompt: "clean the build", reply: "", toolCalls: 1, startedAt: 1_000, steps: [], cursor: 0 };
  }

  /** The live feed, the transcript and the notes — what the page asks while a conversation is open. */
  function serveConversation(daemon: NotesDaemon, live: () => LiveTurn | null): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const notes = notesRoute(daemon, url, init);
      if (notes) return notes;
      if (url.pathname.endsWith("/sessions/ses_1/live")) return json({ turn: live(), jobs: [] });
      if (url.pathname.endsWith("/sessions/ses_1/turns")) {
        const session = { id: "ses_1", agentId: "nouva", chatId: "web-1", gatewayId: "web:dashboard", updatedAt: 1, writable: true };
        return json({ session, earlier: [], turns: [], events: [], messages: [] });
      }
      return json({});
    }) as typeof fetch;
  }

  async function mountConversation(): Promise<{ running: () => string | undefined; unmount: () => void }> {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { useConversation } = await import("@/commons/hooks/use-conversation");
    const { useWorkNotes } = await import("@/commons/hooks/use-notes");
    let running: string | undefined;
    const Probe = (): null => {
      running = useConversation({ sessionId: "ses_1", agentId: "nouva", onSession: () => {} }).liveTurns[0]?.status;
      useWorkNotes("ses_1");
      return null;
    };
    const host = dom.document.createElement("div");
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    // Answers stay fresh for as long as the page's own reader keeps them, so only the turn's end can read them again.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    return {
      running: () => running,
      unmount: () => {
        root.unmount();
        host.remove();
        client.clear();
      },
    };
  }

  test("when the turn the page watched finishes", async () => {
    const daemon: NotesDaemon = { notes: EMPTY, reads: 0, saved: [] };
    let turn = turnOf("turn_1", "running");
    serveConversation(daemon, () => turn);
    const view = await mountConversation();
    try {
      await eventually(() => view.running() === "running" && daemon.reads === 1, 2_000, "the turn at work, the notes read once");
      daemon.notes = NOTES;
      turn = turnOf("turn_1", "done");
      await eventually(() => daemon.reads === 2, 3_000, "the notes read again at the turn's end");
    } finally {
      view.unmount();
    }
  });

  test("when it ended between two polls and the next turn already started", async () => {
    const daemon: NotesDaemon = { notes: EMPTY, reads: 0, saved: [] };
    let turn = turnOf("turn_1", "running");
    serveConversation(daemon, () => turn);
    const view = await mountConversation();
    try {
      await eventually(() => view.running() === "running" && daemon.reads === 1, 2_000, "the turn at work, the notes read once");
      turn = turnOf("turn_2", "running");
      await eventually(() => daemon.reads === 2, 3_000, "the notes read again when the next turn took over");
    } finally {
      view.unmount();
    }
  });
});
