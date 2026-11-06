/**
 * Mounting the dashboard's pages in a test: a DOM, the app's own router and query client, and `fetch` answered from the
 * engine's own route answers (`fixtures/wire.json`) or a test's (`answer`). Split out of `mount.test.ts` when it outgrew
 * its budget (0.8.0), so a page's cases can live in a file of their own — each calls `useMountHarness()` once.
 */

import { afterAll, afterEach, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateRouteTree } from "../scripts/routes.ts";
import { eventually, sleep } from "./wait.ts";

/** Routes' answers the engine wrote (`fixtures/wire.json`), by path. */
export const WIRE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "wire.json"), "utf8")) as Record<string, unknown>;

/** Every global a React render touches. Assigned before anything imports React. */
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "DOMParser",
  "Image",
  "matchMedia",
  "ResizeObserver",
] as const;

export let dom: Window;
/** Bun's own `fetch`, kept so the stub can be taken back off rather than deleted. */
let realFetch: typeof fetch;

/**
 * What the daemon would answer, by path.
 *
 * Signed in as an admin on a finished install, because that is the state in which every page is
 * reachable — a viewer or an unfinished setup would redirect and this would test the login screen
 * twenty-eight times.
 */
export const RESPONSES: Record<string, unknown> = {
  /**
   * Every route below as the daemon's own routes answer it — the account, the status, setup, settings, providers,
   * the skills hub, MCP tokens, people, memory in each of its views, a conversation — written by the engine's
   * `tests/contracts/dashboard-wire.test.ts` over an install wired as the daemon wires it, which fails when a route
   * answers otherwise. Not hand-written from this app's copies of the wire types, which agree with any fixture written
   * from them.
   */
  ...WIRE,
  /**
   * Hand-written, and for good: the update check. Its answer comes from the update plugin (`nouride-update`),
   * which only a built daemon loads, and from the release channel; the engine's tests reach neither, and its install
   * half is this machine's. `tests/web/update-routes.test.ts` holds the route's own shape. A newer release on offer, so
   * the Update page builds its install card and the download it would start — without this it drew "Could not reach
   * the daemon" and nothing under it, which a mount passes just as happily.
   */
  "/update": {
    supported: true,
    install: { version: "0.7.9", edition: "basic", installDir: "/opt/nouride", supervisor: "systemd", compiled: true, platform: "linux", arch: "x64", musl: false },
    download: { status: "idle", received: 0, total: null, tag: null, artifact: null, error: null },
    check: {
      current: "0.7.9", latest: "0.7.10", newer: true, publishedAt: null, notesUrl: null,
      plan: { can: true, from: "0.7.9", to: "0.7.10", artifact: "nouride-linux-x64.tar.gz" },
    },
  },
};

/** Anything not named above answers with an empty collection of the right shape. */
const EMPTY: Record<string, unknown> = {
  agents: [],
  // Carries the id the pending sender above arrived on, so the card's agent lookup resolves and the
  // `Details` link is built rather than skipped.
  gateways: [{ id: "telegram:nouva", platform: "telegram", name: "nouva", agent: "nouva", enabled: true }],
  providers: [],
  sessions: [],
  rooms: [],
  webhooks: [],
  jobs: [],
  runs: [],
  users: [],
  people: [],
  skills: [],
  proposals: [],
  entries: [],
  /**
   * One pending draft, for the same reason the sender list below carries one: Overview's alert strip
   * renders *nothing* per queue that is empty, so `[]` mounts the component without running the
   * branch that builds the row and its router link.
   */
  pending: [
    {
      id: "d1",
      createdAt: 0,
      agentId: "nouva",
      gatewayId: null,
      chatId: null,
      triggerKind: "user_request",
      triggerReason: "asked twice",
      name: "deploy-notes",
      description: "How this box is deployed",
      requires: "",
      body: "# Deploy\n",
      target: null,
      files: [],
      carries: [],
      model: null,
      status: "pending",
      decidedAt: null,
      decidedBy: null,
      publishedPath: null,
    },
  ],
  turns: [],
  messages: [],
  files: [],
  models: [],
  drafts: [],
  windows: { sessions: 30, audit: 30, logs: 14 },
  items: [],
  total: 0,
  /**
   * Fields three pages reach into without tolerating their absence, and the daemon always sends.
   *
   * All three were found by this test failing on its own thin fixture, and none of them is a live
   * bug — `/access`, `/logs/stored` and `/policy/spend` build every one of these unconditionally,
   * so they are part of the contract rather than something the daemon may omit.
   *
   * They are worth naming anyway, because the shape of the fragility is the same in all three:
   * `access.data.senders.filter(…)`, `head.span.oldest`, and `spent.toFixed(4)` behind a
   * `spent === null` check that an absent field walks straight past. The wire types declare each
   * field required, so TypeScript is satisfied and a thin response is a crash. That is the argument
   * for this fixture answering *plausibly* rather than answering `{}`: a page that would break on a
   * real response has to fail here, and a page that only breaks on a response the daemon cannot
   * produce must not.
   */
  /**
   * One pending sender, not an empty list.
   *
   * Overview's pending-pairings card renders *nothing* when the queue is empty, so a fixture of `[]`
   * mounts the page without ever running the card — and the card is the half that can throw. Its row
   * builds a router `Link` from a gateway lookup, which fails at render rather than at type-check.
   */
  senders: [
    {
      gatewayId: "telegram:nouva",
      senderId: "5550001111",
      senderName: "A Stranger",
      status: "pending",
      code: "ABC-234",
      chatId: "1",
      requestedAt: 0,
      expiresAt: null,
      resolvedAt: null,
      resolvedBy: null,
    },
  ],
  allowlist: [],
  mode: "pair",
  editable: true,
  components: [],
  span: { oldest: null, newest: null },
  retentionDays: 14,
  maxDailyCostUsd: 0,
  maxDailyTokens: 0,
  alertThresholdPct: 80,
  spentTodayUsd: null,
  unpricedRequests: 0,
};

/** Per-test answers that win over `RESPONSES`, cleared after every test. */
/** `hold`: never answered — the page as it is while a request is on its way. */
export const overrides: Record<string, { status: number; body: unknown; hold?: boolean }> = {};

/** This test's answers, replacing the last ones whole: one object every test file reads, so it is never reassigned. */
export function answer(next: typeof overrides): void {
  for (const path of Object.keys(overrides)) delete overrides[path];
  Object.assign(overrides, next);
}

/** What the pages' canvases were asked to draw, call by call — `fillText` with its label, say. */
export let painted: { method: string; args: unknown[] }[] = [];

/** A stand-in 2D context: properties are kept, every method is recorded and does nothing. */
function imageData(width: number, height: number): { width: number; height: number; data: Uint8ClampedArray } {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function context2d(canvas: unknown): unknown {
  const state: Record<string, unknown> = { canvas };
  return new Proxy(state, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        painted.push({ method: key, args });
        if (key === "measureText") return { width: String(args[0] ?? "").length * 6 };
        // The Office paints its cats pixel by pixel (0.8.1). The stub is installed on happy-dom's canvas for every test
        // file after this one, so without real pixels the Office's own tests failed — but only when run after this.
        if (key === "createImageData") return imageData(Number(args[0]), Number(args[1]));
        return undefined;
      };
    },
    set(target, key, value) {
      target[String(key)] = value;
      return true;
    },
  });
}

function install(): void {
  dom = new Window({ url: "http://localhost/dashboard/" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const source = dom as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) globals[key] = source[key];

  /**
   * `scrollTo`, which happy-dom does not implement and the router calls on every navigation.
   *
   * A no-op rather than a fixture: the assertion here is that a page runs, and a router restoring
   * scroll position has nothing to do with that. Left unstubbed it fails every single page with
   * `ReferenceError: scrollTo is not defined`, which is a loud way of testing happy-dom.
   */
  globals.scrollTo = () => {};
  source.scrollTo = () => {};

  /**
   * A 2D context for `<canvas>`, which happy-dom answers with `null`.
   *
   * The memory graph draws on one, and its engine (`ui-graph`) takes the context as given: against `null` the page
   * threw on its first frame, so no test drew it at all. This one does nothing but write down what was drawn, and
   * measures text at six pixels a character, which is all the label layout asks of it. `createImageData` hands back
   * real pixels, which the Office's cats are painted into.
   */
  const Canvas = source.HTMLCanvasElement as { prototype: { getContext: (kind: string) => unknown } };
  Canvas.prototype.getContext = function (this: unknown, kind: string) {
    return kind === "2d" ? context2d(this) : null;
  };

  /**
   * Only the control API is answered. Everything else goes to the real `fetch`.
   *
   * Bun runs every test file in one process, so a blanket stub is not scoped to this file — and one
   * was not: `cli-setup.test.ts` starts a real HTTP server and probes it for a model list, and with
   * everything intercepted it failed two hundred tests later with "an api key is required". That
   * reads as a bug in the setup wizard and was a stub answering a request it knew nothing about.
   *
   * Narrow by path rather than only cleaned up afterwards, because the cleanup is the second line of
   * defence and this is the first.
   */
  realFetch = globalThis.fetch;
  globals.fetch = (input: unknown, init?: unknown): Promise<Response> => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    const { pathname } = new URL(url, "http://localhost");
    /**
     * `/api/health` as well as `/api/control`, and the omission was not harmless.
     *
     * Overview asks for health first and renders "Engine unreachable" without it. That path is not
     * under `/api/control`, so it fell through to the real `fetch`, failed against a daemon that is
     * not running, and the home page rendered its error box — which is not a React error and is not
     * an empty string, so this test passed on it. The most-looked-at page in the app had its body
     * mounted by nothing, and the `"/health"` fixture below was dead code nothing could reach.
     */
    if (!pathname.startsWith("/api/control") && pathname !== "/api/health") {
      return realFetch(input as RequestInfo, init as RequestInit);
    }

    const bare = pathname === "/api/health" ? "/health" : pathname.replace(/^\/api\/control/, "");
    // A fixture asked with a query (`/memory/graph?knowledge=1`) answers a request whose query holds those values; the
    // bare path answers the rest.
    const query = new URL(url, "http://localhost").searchParams;
    const withQuery = (table: Record<string, unknown>) =>
      Object.keys(table).find((key) => key.startsWith(`${bare}?`) && [...new URLSearchParams(key.slice(bare.length + 1))].every(([name, value]) => query.get(name) === value));
    const path = withQuery(overrides) ?? withQuery(RESPONSES) ?? bare;
    // Overrides first, so a test can put the app in a state the shared fixture does not describe —
    // signed *out*, which is the only state in which the login page is the page that renders.
    const override = overrides[path] ?? overrides[bare];
    if (override?.hold) return new Promise<Response>(() => {});
    if (override) {
      return Promise.resolve(
        new Response(JSON.stringify(override.body), {
          status: override.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    const body = RESPONSES[path] ?? EMPTY;
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

/**
 * Errors React swallows into its own logging, collected.
 *
 * A render that throws inside a component does not reject the promise this test awaits — React
 * catches it, logs it and renders nothing. So an assertion on the returned tree alone would pass on
 * a page that crashed. `console.error` is where the evidence goes.
 */
export let errors: string[] = [];
const realError = console.error;

/**
 * The harness's hooks, registered by each file that mounts pages: the DOM and the stubbed `fetch` installed before its
 * first test and taken back off after its last, and each test's answers, errors and drawings cleared after it.
 */
export function useMountHarness(): void {
  beforeAll(async () => {
    // The route tree is generated and gitignored: written here from `src/routes`, so a fresh clone has one and a route
    // added since the last build is in it.
    await generateRouteTree();
    install();
  });

  afterEach(() => {
    console.error = realError;
    errors = [];
    answer({});
    painted = [];
  });

  afterAll(async () => {
    /**
     * React first, then the globals.
     *
     * `root.unmount()` schedules work rather than finishing it, and the scheduler's callback reads
     * `window.event`. Tearing the globals down without waiting produced `ReferenceError: window is
     * not defined` as an "unhandled error between tests" — attributed to no test, from a stack inside
     * `react-dom`, at the top of a run that otherwise reported 3540 passing.
     */
    await sleep(50);

    /**
     * Every global put on `globalThis` is taken back off.
     *
     * Bun runs test files in one process, so these are not scoped to this file — and `fetch` in
     * particular is not a harmless leak. Left installed it made `cli-setup.test.ts` fail two hundred
     * tests later with "an api key is required", which reads as a bug in the setup wizard and is a
     * stub answering `{}` to a request it knew nothing about.
     *
     * The DOM globals are *deleted* — nothing here had one before, so removing them is exact. `fetch`
     * is **restored**, because it is Bun's own: deleting it left `ReferenceError: fetch is not
     * defined` two hundred tests later, which is the same leak as before wearing the opposite sign.
     */
    for (const key of DOM_GLOBALS) delete (globalThis as unknown as Record<string, unknown>)[key];
    delete (globalThis as unknown as Record<string, unknown>).scrollTo;
    globalThis.fetch = realFetch;
    dom.close?.();
  });
}

/** Route paths as TanStack knows them, with parameters filled in with something plausible. */
export const PAGES: [name: string, path: string][] = [
  ["home", "/"],
  ["agents", "/agents"],
  ["agent settings", "/agents/settings"],
  ["agent files", "/agents/nouva"],
  ["agent model", "/agents/nouva/model"],
  ["agent connections", "/agents/nouva/gateways"],
  ["agent access", "/agents/nouva/access"],
  ["agent skills", "/agents/nouva/skills"],
  ["agent mcp", "/agents/nouva/mcp"],
  ["mcp library", "/mcp"],
  ["integrations", "/integrations"],
  ["web search", "/web-search"],
  ["secrets", "/secrets"],
  ["chat", "/chat"],
  // A conversation and a room are their own routes, each handing the page an id the index never does.
  ["chat, a conversation", "/chat/ses_1"],
  ["chat, a room", "/chat/room/room_1"],
  ["schedule", "/schedule"],
  ["webhooks", "/webhooks"],
  ["skills", "/skills"],
  ["memories", "/memories"],
  ["memory graph", "/memories/graph"],
  ["models", "/models"],
  ["people", "/people"],
  ["groups", "/groups"],
  ["access", "/access"],
  ["access, denied", "/access?tab=denied"],
  ["access, blocked", "/access?tab=blocked"],
  ["access, history", "/access?tab=history&agent=nouva"],
  ["users", "/users"],
  ["logs", "/logs"],
  ["account", "/account"],
  ["box", "/box"],
  ["update", "/update"],
  // Where a first sign-in with a printed password lands; nothing redirects an admin away from it.
  ["welcome", "/welcome"],
  ["llm gateway", "/llm-gateway"],
  ["missions", "/missions"],
  ["missions, one agent's", "/missions?agent=nouva"],
  ["a mission", "/missions/msn_1"],
  ["login", "/login"],
];

/** What `interact` can reach besides the page: the cache, to refetch through, and where the router is now. */
export interface MountedApp {
  queryClient: import("@tanstack/react-query").QueryClient;
  location: () => string;
  /** The address's search parameters as the router holds them now: what a reload would read. */
  search: () => Record<string, unknown>;
}

/** Mount the app at one route and return what it drew — after `interact`, when a test clicks through it. */
export async function renderPage(path: string, interact?: (host: HTMLElement, app: MountedApp) => Promise<void>): Promise<string> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { RouterProvider, createMemoryHistory } = await import("@tanstack/react-router");
  const { createAppRouter } = await import("@/router");
  const { ToastProvider } = await import("@/commons/components/ui/toast");

  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  // The app's own router, error and 404 pages included — not one assembled here that the app does not ship.
  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/dashboard${path}`] }));

  // Retries off: a query that fails here should fail once and let the page render its error
  // state, not hold the test open for three backoffs.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);

  root.render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        ToastProvider,
        null,
        React.createElement(RouterProvider, { router }),
      ),
    ),
  );

  // Two ticks past the first paint: the gate resolves `/setup/state` and `/auth/me` before any
  // page renders at all, so a single flush only ever tests the loading spinner.
  await router.load();
  for (let i = 0; i < 8; i += 1) await sleep(10);
  try {
    if (interact) await interact(host as unknown as HTMLElement, { queryClient, location: () => router.state.location.pathname, search: () => ({ ...router.state.location.search }) });
    return host.innerHTML;
  } finally {
    // Unmounted when a step throws too: a page left mounted went on asking its queries through the next tests' fetch,
    // and one failed knowledge test in CI failed ten restart tests in another file after it.
    root.unmount();
    host.remove();
  }
}

/** Pressing, typing and what a page posts — for a test that clicks through one. */
export const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
export const press = (host: HTMLElement, label: string) => ([...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as HTMLElement).click();
export const type = (input: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
  input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
};
/** Every POST the page sends from here on, by path, with its body — answered from `answers` where it names the path. */
export const recordPosts = (answers: Record<string, { status: number; body: unknown }> = {}) => {
  const posts: { path: string; body: unknown }[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    if (init?.method !== "POST") return (spy as typeof fetch)(input as RequestInfo, init);
    const path = new URL(url, "http://localhost").pathname.replace(/^\/api\/control/, "");
    posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    const answer = answers[path];
    return answer ? Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } })) : (spy as typeof fetch)(input as RequestInfo, init);
  }) as typeof fetch;
  return { posts, restore: () => void (globalThis.fetch = spy) };
};
/** What was typed has reached React: the button it enables can be pressed. */
export const enabled = (host: HTMLElement, label: string) =>
  eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === label && !button.disabled), 2_000, `${label} enabled`);
