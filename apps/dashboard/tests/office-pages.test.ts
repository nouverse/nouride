/**
 * The Office and an agent's Look tab (0.8.1), rendered against a stand-in for `/status`: a button over each cat saying
 * who it is and what it is doing — a status never only a colour — and its card when clicked; the Look tab sending each
 * part as picked, or empty for its id's.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "scrollTo"] as const;
let dom: Window;
let realFetch: typeof fetch;

/**
 * What the Office drew. happy-dom has no canvas, so its `getContext` is stood in for by one that keeps real pixels and
 * writes down each call — set here, not inherited: another test file's stand-in, left on happy-dom's canvas, had no
 * pixels, and the Office failed on CI only, where that file ran first.
 */
const drawn: { method: string; args: unknown[] }[] = [];
type Canvas = { prototype: { getContext: (this: unknown, kind: string) => unknown } };
let realGetContext: Canvas["prototype"]["getContext"];

function paintable(canvas: Canvas): void {
  realGetContext = canvas.prototype.getContext;
  canvas.prototype.getContext = function (this: unknown, kind: string) {
    if (kind !== "2d") return null;
    const state: Record<string, unknown> = { canvas: this };
    return new Proxy(state, {
      get: (target, key) =>
        typeof key !== "string" ? undefined
        : key in target ? target[key]
        : (...args: unknown[]) => {
            drawn.push({ method: key, args });
            const [width, height] = args.map(Number);
            return key === "createImageData" ? { width, height, data: new Uint8ClampedArray(width! * height! * 4) } : undefined;
          },
      set: (target, key, value) => ((target[String(key)] = value), true),
    });
  };
}

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  realFetch = globalThis.fetch;
  paintable((dom as unknown as { HTMLCanvasElement: Canvas }).HTMLCanvasElement);
});

afterAll(() => {
  (dom as unknown as { HTMLCanvasElement: Canvas }).HTMLCanvasElement.prototype.getContext = realGetContext;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const activity = (over: Record<string, unknown>) => ({ activity: "idle", working: [], jobs: 0, waiting: 0, unavailable: null, ...over });
const agent = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, displayName: name, enabled: true, state: "running", provider: "p", model: "m", tools: [], skills: [], approvals: "balanced", ...over });
const STATUS = {
  status: "ok",
  uptime: 1,
  configSource: null,
  dataDir: "/d",
  orchestrator: "nouva",
  agents: [
    agent("nouva", "Nouva", { activity: activity({ activity: "working", working: [{ gatewayId: "telegram:nouva", chatId: "555" }] }) }),
    agent("wren", "Wren", { activity: activity({ activity: "waiting", waiting: 1 }) }),
    agent("codey", "Codey", { activity: activity({ unavailable: "Codex is not signed in" }), look: { hat: "cap" } }),
    agent("sleepy", "Sleepy", { state: "paused", activity: activity({ activity: "asleep" }) }),
  ],
  failures: [],
  providers: [],
  gateways: [],
  queue: { running: 0, waiting: 0 },
  pendingApprovals: 1,
};

/** Who has talked to whom: Nouva has a conversation to carry on, the rest none yet. */
const CHAT_LIST = {
  agents: [
    { agentId: "nouva", sessionId: "ses_nouva_newest", at: 1, last: { from: "agent", name: "nouva", text: "done" }, working: false, helpers: 0 },
    { agentId: "wren", working: false, helpers: 0 },
  ],
  rooms: [],
  groups: [],
};

function serve(status: unknown = STATUS, role = "admin"): { posted: { path: string; body: unknown }[] } {
  const posted: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/control/status") return json(status);
    if (path === "/api/control/chat-list") return json(CHAT_LIST);
    if (path === "/api/control/auth/me") return json({ id: "u1", username: "mira", role });
    if (init?.method === "POST") {
      posted.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { posted };
}

async function mount(page: "office" | "look", agentId = "codey"): Promise<{ host: HTMLElement; unmount: () => void }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
  // The Office is the top of the Agents page: the cats over the list of the same agents.
  const { default: OfficePage } = await import("@/modules/agents/index.page");
  const { default: AgentLookPage } = await import("@/modules/agents/look.page");
  // The pages link to others; a router to hold them, the page under test its only route.
  const root = createRootRoute({ component: () => React.createElement(Outlet) });
  const route = createRoute({ getParentRoute: () => root, path: "/", component: () => (page === "office" ? React.createElement(OfficePage) : React.createElement(AgentLookPage, { agentId })) });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const reactRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reactRoot.render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
  return { host, unmount: () => (reactRoot.unmount(), host.remove(), client.clear()) };
}

describe("the Office", () => {
  test("puts a button over each cat saying who it is and what it is doing, and opens its card", async () => {
    serve();
    const { host, unmount } = await mount("office");
    try {
      await eventually(() => host.querySelectorAll("button[aria-pressed]").length === 4, 3_000, "a button per cat");
      const labels = [...host.querySelectorAll("button[aria-pressed]")].map((button) => button.getAttribute("aria-label"));
      // The orchestrator first, then the rest in the order they were made — undated here, so by id.
      expect(labels).toEqual(["Nouva, working", "Codey, asleep, cannot work: Codex is not signed in", "Sleepy, asleep", "Wren, waiting for you"]);
      // Each button over its cat, where the scene has it — the same place it follows a walking cat to, frame by frame.
      const { layoutOffice } = await import("@/commons/office/lib/layout");
      // The orchestrator at the front desk, the others after it by id — none of them dated.
      const nouva = layoutOffice([{ id: "nouva", status: "working", lead: true }, { id: "codey", status: "asleep" }, { id: "sleepy", status: "asleep" }, { id: "wren", status: "waiting" }]).places.get("nouva")!;
      expect(nouva.key).toBe("desk:lead");
      const button = host.querySelector('button[aria-label="Nouva, working"]') as HTMLButtonElement;
      // The orchestrator's name wears the crown the other pages give it (0.8.15); no one else's does.
      expect(button.querySelector('[data-name] [aria-label="orchestrator"]')).not.toBeNull();
      expect(host.querySelectorAll('[data-name] [aria-label="orchestrator"]').length).toBe(1);
      expect([button.style.left, button.style.top]).toEqual([`${(nouva.x + 4) * 2}px`, `${nouva.y * 2}px`]);
      // Drawn, not only labelled: the cats are painted into pixels and copied onto the room.
      await eventually(() => drawn.some((call) => call.method === "drawImage"), 2_000, "the room drawn");
      const painted = drawn.filter((call) => call.method === "putImageData").map((call) => call.args[0] as { data: Uint8ClampedArray });
      expect(painted.some((image) => image.data.some((value, at) => at % 4 === 3 && value === 255))).toBe(true);
      // Under the office, every agent as a row, the orchestrator first: each a line to press, none opened yet.
      const rows = () => [...host.querySelectorAll<HTMLElement>("[data-agent-row]")];
      const row = (id: string) => host.querySelector<HTMLElement>(`[data-agent-row="${id}"]`)!;
      // In the order the server lists them, the orchestrator first: the list's own order, not the office's seats.
      expect(rows().map((entry) => entry.dataset.agentRow)).toEqual(["nouva", "wren", "codey", "sleepy"]);
      // A row is one thing to press, and it opens: the line was a link to the agent's page with a small arrow beside it
      // that opened, so a press meant for one took the other. Closed, it holds no link at all.
      expect(rows().map((entry) => [entry.querySelectorAll("a").length, entry.querySelectorAll("button").length, entry.querySelector("button")!.getAttribute("aria-expanded")])).toEqual([[0, 1, "false"], [0, 1, "false"], [0, 1, "false"], [0, 1, "false"]]);
      // Read as what it shows, not by a name that hides it.
      expect(row("nouva").querySelector("button")!.getAttribute("aria-label")).toBeNull();
      expect(host.querySelectorAll("[data-agent-actions]")).toHaveLength(0);
      (host.querySelector('button[aria-label="Nouva, working"]') as HTMLButtonElement).click();
      // Picking a cat shows that agent right under the Office, where the press was: what it is doing, and what a person
      // does with it. Its row, down in the list, stays as it was: the same actions are never on the page twice.
      const picked = () => host.querySelector<HTMLElement>("[data-agent-picked]");
      await eventually(() => (picked()?.textContent ?? "").includes("telegram:nouva · 555"), 2_000, "its card, under the office");
      expect(picked()!.dataset.agentPicked).toBe("nouva");
      expect(host.querySelectorAll("[data-agent-actions]")).toHaveLength(1);
      expect(rows().map((entry) => entry.querySelector("[data-agent-actions]"))).toEqual([null, null, null, null]);
      expect(rows().map((entry) => entry.querySelector("button")!.getAttribute("aria-expanded"))).toEqual(["false", "false", "false", "false"]);
      // Under the Office and over the list and its filter: a card of the page, before the row that stays.
      const order = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & 4);
      expect(order(host.querySelector('button[aria-label="Nouva, working"]')!, picked()!)).toBe(true);
      expect(order(picked()!, host.querySelector("[data-sticky-bar]")!)).toBe(true);
      expect(order(picked()!, host.querySelector("[data-agent-rows]")!)).toBe(true);
      const actions = () => [...host.querySelectorAll<HTMLElement>("[data-agent-actions] a, [data-agent-actions] button")].map((entry) => entry.textContent?.trim());
      expect(actions().filter((label) => ["Details", "Open chat", "Sleep", "Workspace", "Edit look"].includes(label ?? ""))).toEqual(["Details", "Open chat", "Sleep", "Workspace", "Edit look"]);
      // Details is the agent's own page.
      expect([...host.querySelectorAll("[data-agent-actions] a")].find((link) => link.textContent?.trim() === "Details")!.getAttribute("href")).toBe("/agents/nouva");
      // The orchestrator's card wears its badge; Wren's, next, does not.
      const card = () => picked()?.textContent ?? "";
      expect(card()).toContain("orchestrator");
      // Open chat carries on the cat's newest conversation, as its row in the chat list does: it started a new one every
      // time, and the conversation the person was in was left behind.
      const openChat = () => [...host.querySelectorAll("a")].find((link) => (link.textContent ?? "").includes("Open chat"));
      await eventually(() => (openChat()?.getAttribute("href") ?? "").endsWith("/chat/ses_nouva_newest"), 2_000, "Nouva's newest conversation");
      // Another cat picked takes the card: one nobody has talked to starts a chat with the cat that was picked.
      (host.querySelector('button[aria-label="Wren, waiting for you"]') as HTMLButtonElement).click();
      await eventually(() => (openChat()?.getAttribute("href") ?? "").includes("agent=wren"), 2_000, "Wren's Open chat");
      expect(openChat()!.getAttribute("href")).toMatch(/\/chat\/?\?agent=wren$/);
      expect(card()).not.toContain("orchestrator");
      expect([host.querySelectorAll("[data-agent-picked]").length, picked()!.dataset.agentPicked, host.querySelectorAll("[data-agent-actions]").length]).toEqual([1, "wren", 1]);
      expect(host.querySelector('button[aria-label="Wren, waiting for you"]')!.getAttribute("aria-pressed")).toBe("true");
      // It closes by its own button, and the cat is no longer the one marked.
      (picked()!.querySelector('button[aria-label="Close Wren"]') as HTMLButtonElement).click();
      await eventually(() => picked() === null, 2_000, "closed by its button");
      expect(host.querySelectorAll("[data-agent-actions]")).toHaveLength(0);
      expect(host.querySelector('button[aria-label="Wren, waiting for you"]')!.getAttribute("aria-pressed")).toBe("false");
      // And by its cat pressed again.
      (host.querySelector('button[aria-label="Wren, waiting for you"]') as HTMLButtonElement).click();
      await eventually(() => picked()?.dataset.agentPicked === "wren", 2_000, "picked again");
      (host.querySelector('button[aria-label="Wren, waiting for you"]') as HTMLButtonElement).click();
      await eventually(() => picked() === null, 2_000, "closed by its cat");
      // A row opens without the office: a press anywhere on its line, on the name as on the line's end, under that row.
      (row("codey").querySelector("button[aria-expanded] .truncate") as HTMLElement).click();
      await eventually(() => row("codey").querySelector("[data-agent-actions]") !== null, 2_000, "opened from its row");
      expect(row("codey").textContent).toContain("Cannot work: Codex is not signed in");
      expect(picked()).toBeNull();
      // The press opened it and went nowhere: the list is still the page, and the way to the agent's page is Details.
      expect(host.querySelector("[data-agent-rows]")).not.toBeNull();
      expect(rows()).toHaveLength(4);
      expect([...row("codey").querySelectorAll("[data-agent-actions] a")].find((link) => link.textContent?.trim() === "Details")!.getAttribute("href")).toMatch(/^\/agents\/codey/);
      // A row pressed does not mark a cat, and it closes by the same press.
      expect(host.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0);
      // One at a time: a cat picked while a row is open closes the row, and a row pressed closes the card.
      (host.querySelector('button[aria-label="Nouva, working"]') as HTMLButtonElement).click();
      await eventually(() => picked()?.dataset.agentPicked === "nouva", 2_000, "the card, in the row's place");
      expect([host.querySelectorAll("[data-agent-actions]").length, row("codey").querySelector("[data-agent-actions]")]).toEqual([1, null]);
      (row("wren").querySelector("button[aria-expanded]") as HTMLButtonElement).click();
      await eventually(() => row("wren").querySelector("[data-agent-actions]") !== null, 2_000, "the row, in the card's place");
      expect([picked(), host.querySelectorAll("[data-agent-actions]").length]).toEqual([null, 1]);
      (row("wren").querySelector("button[aria-expanded]") as HTMLButtonElement).click();
      await eventually(() => host.querySelectorAll("[data-agent-actions]").length === 0, 2_000, "closed by the same press");
    } finally {
      unmount();
    }
  });

  // A cat picked used to open its row down in the list, and the page was moved to bring the row into view: the page
  // left under the hand that had just pressed. Its card is under the Office now, where the press was.
  test("nothing moves the page: not a cat picked, wherever its row is, and not a row pressed", async () => {
    serve();
    const { host, unmount } = await mount("office");
    const proto = dom.window.HTMLElement.prototype as unknown as { scrollIntoView?: (this: HTMLElement) => void; getBoundingClientRect: () => unknown };
    const [realScroll, realRect] = [proto.scrollIntoView, proto.getBoundingClientRect];
    const moved: string[] = [];
    try {
      await eventually(() => host.querySelectorAll("button[aria-pressed]").length === 4, 3_000, "a button per cat");
      proto.scrollIntoView = function (this: HTMLElement) { moved.push(this.tagName); };
      // Every row far below the screen: where the page used to be moved.
      proto.getBoundingClientRect = () => ({ top: 2000, bottom: 2060, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
      (host.querySelector('button[aria-label="Wren, waiting for you"]') as HTMLButtonElement).click();
      await eventually(() => host.querySelector("[data-agent-picked]") !== null, 2_000, "Wren's card");
      (host.querySelector('[data-agent-row="codey"] button[aria-expanded]') as HTMLButtonElement).click();
      await eventually(() => host.querySelector('[data-agent-row="codey"] [data-agent-actions]') !== null, 2_000, "Codey's row, opened");
      (host.querySelector('button[aria-label="Nouva, working"]') as HTMLButtonElement).click();
      await eventually(() => host.querySelector<HTMLElement>("[data-agent-picked]")?.dataset.agentPicked === "nouva", 2_000, "Nouva's card");
      expect(moved).toEqual([]);
    } finally {
      proto.scrollIntoView = realScroll;
      proto.getBoundingClientRect = realRect as never;
      unmount();
    }
  });

  test("a cat's card opens that agent's own folder for an admin, and has no such button for anyone else", async () => {
    const workspace = (host: HTMLElement) => [...host.querySelectorAll("a")].find((link) => (link.textContent ?? "").trim() === "Workspace");
    const opened = async (role: string) => {
      serve(STATUS, role);
      const { host, unmount } = await mount("office");
      try {
        await eventually(() => host.querySelectorAll("button[aria-pressed]").length === 4, 3_000, "a button per cat");
        (host.querySelector('button[aria-label="Wren, waiting for you"]') as HTMLButtonElement).click();
        await eventually(() => (host.textContent ?? "").includes("Edit look"), 2_000, "its row, opened");
        // Sleep is pressable once who is signed in is known, for an operator as for an admin: only then is a button
        // that is not there one that was left out.
        await eventually(() => [...host.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Sleep" && !button.disabled), 2_000, "who is signed in");
        return workspace(host)?.getAttribute("href");
      } finally {
        unmount();
      }
    };
    // The picked agent's, not the orchestrator's: the tab on its own page.
    expect(await opened("admin")).toMatch(/\/agents\/wren\/workspace(\?path=)?$/);
    expect(await opened("operator")).toBeUndefined();
  });
});

describe("an office with more agents than it holds", () => {
  test("shows twelve, the orchestrator among them, and says how many are elsewhere and who there waits for you", async () => {
    const team = Array.from({ length: 13 }, (_, i) => agent(`a${String(i).padStart(2, "0")}`, `Agent ${i}`, { since: 1_000 + i, activity: activity({ activity: i === 12 ? "waiting" : "idle" }) }));
    serve({ ...STATUS, orchestrator: "nouva", agents: [...team, agent("nouva", "Nouva", { since: 99_999, activity: activity({}) })] });
    const { host, unmount } = await mount("office");
    try {
      await eventually(() => host.querySelectorAll("button[aria-pressed]").length === 12, 3_000, "twelve cats");
      const labels = [...host.querySelectorAll("button[aria-pressed]")].map((button) => button.getAttribute("aria-label"));
      expect(labels).toContain("Nouva, idle");
      expect(labels).not.toContain("Agent 12, waiting for you");
      const badges = [...host.querySelectorAll("[data-office-count] .badge")].map((badge) => badge.textContent);
      expect(badges).toEqual(["14 agents", "12 here", "2 in another office", "1 of them waiting for you"]);
    } finally {
      unmount();
    }
  });
});

describe("an agent's Look tab", () => {
  test("sends each part as picked, and the rest empty — its id's", async () => {
    const { posted } = serve();
    const { host, unmount } = await mount("look");
    try {
      await eventually(() => host.querySelector('select[aria-label="Fur"]') !== null && !(host.querySelector('select[aria-label="Fur"]') as HTMLSelectElement).disabled, 3_000, "the parts");
      // The picks are set by an effect after the agent arrives, a render after the parts are enabled: read at once, the
      // hat was still empty on the release runner (CI, 2026-10-27).
      await eventually(() => (host.querySelector('select[aria-label="Hat"]') as HTMLSelectElement).value === "cap", 2_000, "its picks");
      const fur = host.querySelector('select[aria-label="Fur"]') as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fur), "value")!.set!.call(fur, "black");
      fur.dispatchEvent(new (fur.ownerDocument.defaultView as unknown as typeof globalThis).Event("change", { bubbles: true }));
      await eventually(() => fur.value === "black", 2_000, "the pick");
      (fur.form as HTMLFormElement).requestSubmit();
      await eventually(() => posted.length > 0, 2_000, "the save");
      expect(posted[0]).toEqual({ path: "/api/control/agents/codey/look", body: { fur: "black", pattern: "", outfit: "", outfitColor: "", hat: "cap", accessory: "", eyes: "" } });
    } finally {
      unmount();
    }
  });
});

describe("an agent's Look tab and the Office", () => {
  test("draw the same cat: a part left to its id is the one the Office draws, beside the others' looks", async () => {
    // The live box's agents (0.8.1): Nix's picks made its id's fur a twin's, which the Office moved on — and the Look
    // tab, working the id's parts out without the picks, showed the fur the Office did not draw.
    const live = [
      agent("nero", "Nero"),
      agent("nestor", "Nestor"),
      agent("nexa", "Nexa"),
      agent("nix", "Nix", { look: { pattern: "tabby", outfitColor: "charcoal", eyes: "sleepy" } }),
      agent("nouva", "Nouva", { look: { fur: "white", outfit: "jacket", outfitColor: "blue", hat: "none", accessory: "headphones", eyes: "sparkly" } }),
      agent("nox", "Nox"),
    ];
    serve({ ...STATUS, orchestrator: "nouva", agents: live });
    const { looksOf } = await import("@/commons/cat/look");
    const office = looksOf(live as never).get("nix")!;
    expect(office.fur).toBe("grey");
    const { host, unmount } = await mount("look", "nix");
    try {
      await eventually(() => host.querySelector('select[aria-label="Fur"]') !== null, 3_000, "the parts");
      // Its picks are set by an effect a render after the parts appear, and "From its id" is worked out with them: read
      // at once, the fur was the one its id gives without them, as the hat was in the test above.
      await eventually(() => (host.querySelector('select[aria-label="Pattern"]') as HTMLSelectElement).value === "tabby", 2_000, "its picks");
      const fur = host.querySelector('select[aria-label="Fur"]') as HTMLSelectElement;
      expect(fur.options[0]!.textContent).toBe(`From its id: ${office.fur}`);
    } finally {
      unmount();
    }
  });
});

describe("a fresh chat greets you with the agent's own cat", () => {
  async function greet(props: Record<string, unknown>): Promise<{ host: HTMLElement; unmount: () => void }> {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { EmptyState } = await import("@/commons/components/chat/EmptyState");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const reactRoot = createRoot(host);
    reactRoot.render(React.createElement(EmptyState, { agentName: "Nouva", senderName: undefined, onPick: () => {}, room: null, ...props } as never));
    return { host, unmount: () => (reactRoot.unmount(), host.remove()) };
  }

  test("its look, drawn as the Office draws it; Nouride's own picture in a room or before an agent is known", async () => {
    const { looksOf } = await import("@/commons/cat/look");
    const look = looksOf([{ id: "nouva", look: { fur: "black", hat: "headphones" } }, { id: "nox" }]).get("nouva");
    const one = await greet({ look });
    try {
      await eventually(() => one.host.querySelector('canvas[aria-label="Nouva\'s cat"]') !== null, 2_000, "the cat");
      expect(one.host.querySelector("img")).toBeNull();
      await eventually(() => drawn.some((call) => call.method === "drawImage"), 2_000, "the cat drawn");
    } finally {
      one.unmount();
    }
    for (const props of [{ look: undefined }, { look, room: { id: "r", title: "Ops", members: [{ agentId: "nouva" }] } }]) {
      const other = await greet(props);
      try {
        await eventually(() => other.host.querySelector("img") !== null, 2_000, "Nouride's picture");
        expect(other.host.querySelector("canvas")).toBeNull();
      } finally {
        other.unmount();
      }
    }
  });
});
