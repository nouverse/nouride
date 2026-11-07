/**
 * An external agent's Brain tab (0.8.1), rendered against a stand-in for its routes. Its profiles are listed with whether
 * each is signed in and which one it answers with; one not signed in says the agent cannot answer; a profile is used,
 * signed in, or added and signed in from here. A sign-in shows its steps, its link and its terminal, and what the person
 * types is sent to it as a line — by an admin; a viewer is shown it and cannot type into it. One that signed in says so
 * and folds away. On the live box the tab showed a lone "Sign in" whatever the state, a "Profile" field nobody could
 * read, and a model field with nothing in it.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { AgentCli, CliProfile } from "@/commons/lib/api.external-agents";
import { eventually } from "./wait.ts";

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

const MODELS = [{ value: "gpt-5.5-codex" }, { value: "gpt-5.5-mini", name: "GPT-5.5 mini" }];

const CLI: AgentCli = {
  cli: "codex",
  profile: "work",
  permissions: "risky",
  model: null,
  models: [],
  effort: null,
  efforts: [],
  effortChoices: ["low", "medium", "high", "xhigh", "max"],
  effortDefault: null,
  unavailable: "Codex is not signed in — sign in on the agent's Brain tab",
  login: { running: true, output: "Open https://auth.example.test/device and enter the code\n", links: ["https://auth.example.test/device"], exitCode: null, signedIn: false, profile: "work" },
};

const NOT_SIGNED_IN: CliProfile[] = [{ name: "work", inUse: true, signedIn: false, reason: "Codex is not signed in — sign in on the agent's Brain tab" }];
const SIGNED_IN: CliProfile[] = [
  { name: "work", inUse: true, signedIn: true, reason: null },
  { name: "home", inUse: false, signedIn: false, reason: "Codex is not signed in — sign in on the agent's Brain tab" },
];

function serve(role: "admin" | "viewer", cli: AgentCli = CLI, profiles: CliProfile[] = NOT_SIGNED_IN): { posted: { path: string; body: unknown }[] } {
  const posted: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method === "POST") {
      posted.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
      return json({ login: cli.login, ok: true });
    }
    if (path === "/api/control/auth/me") return json({ id: "u1", username: "mira", role });
    if (path === "/api/control/agents/coder/cli") return json(cli);
    if (path === "/api/control/agents/coder/cli/profiles") return json({ profiles, separate: true, models: MODELS });
    if (path === "/api/control/status") return json({ agents: [{ id: "coder", displayName: "Coder" }], gateways: [] });
    if (path === "/api/control/external-clis") return json({ room: { enough: true, bytes: 2 ** 31, needs: 2 ** 29 }, clis: [{ id: "codex", name: "Codex", command: "codex-acp", installed: true, version: "0.9.1", install: "npm i -g", login: true }] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { posted };
}

async function mount(): Promise<{ host: HTMLElement; unmount: () => void }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
  const { ToastProvider } = await import("@/commons/components/ui/toast");
  const { default: AgentCliPage } = await import("@/modules/agents/cli.page");
  // The tab links to the Models page and folds the Model tab in: a router and a toaster to hold them.
  const routes = createRootRoute({ component: () => React.createElement(Outlet) });
  const page = createRoute({ getParentRoute: () => routes, path: "/", component: () => React.createElement(ToastProvider, null, React.createElement(AgentCliPage, { agentId: "coder" })) });
  const router = createRouter({ routeTree: routes.addChildren([page]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
  await eventually(() => (host.textContent ?? "").includes("installed") && (host.textContent ?? "").includes("Codex answers Coder") && host.querySelector("li") !== null, 3_000, "the Brain tab with its accounts");
  // Not the version the scan read: it is the ACP adapter's (codex-acp), which read as Codex's own.
  expect(host.textContent).not.toContain("0.9.1");
  return {
    host,
    unmount: () => {
      root.unmount();
      host.remove();
      client.clear();
    },
  };
}

function type(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
  input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
}

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("an external agent's Brain tab", () => {
  test("says the agent cannot answer until the profile it uses is signed in, and walks the sign-in through", async () => {
    const { posted } = serve("admin");
    const { host, unmount } = await mount();
    try {
      expect(host.textContent).toContain("Coder cannot answer with Codex until its account work is signed in; its own model answers meanwhile.");
      // Said on the profile, not again above it.
      expect(host.textContent).not.toContain("Codex is not signed in — sign in on the agent's Brain tab");
      expect(host.querySelector("li")?.textContent).toContain("Not signed in");
      expect(host.textContent).toContain("Signing in the account work");
      expect(host.textContent).toContain("Paste back the code it gives you, or, if the browser ends on a page that does not load, that page's address.");
      const link = host.querySelector('a[href="https://auth.example.test/device"]');
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.textContent?.trim()).toBe("Open the sign-in page");
      expect(host.querySelector("pre")?.textContent).toContain("enter the code");
      const field = host.querySelector('input[placeholder="The code, or the address the browser ended on"]') as HTMLInputElement;
      await eventually(() => !field.disabled, 2_000, "the field, once the admin is known");
      type(field, "ABCD-1234");
      await eventually(() => !button(host, "Send")?.disabled, 2_000, "Send");
      (field.form as HTMLFormElement).requestSubmit();
      await eventually(() => posted.length > 0, 2_000, "the answer posted");
      expect(posted[0]).toEqual({ path: "/api/control/agents/coder/cli/login/answer", body: { text: "ABCD-1234" } });
    } finally {
      unmount();
    }
  });

  test("a viewer sees the sign-in and cannot type into it", async () => {
    serve("viewer");
    const { host, unmount } = await mount();
    try {
      await eventually(() => host.querySelector("pre") !== null, 2_000, "the terminal");
      expect((host.querySelector('input[placeholder="The code, or the address the browser ended on"]') as HTMLInputElement).disabled).toBe(true);
    } finally {
      unmount();
    }
  });

  test("each account says whether it is signed in; another is used or signed in from here, and one is added on the Models page", async () => {
    const { posted } = serve("admin", { ...CLI, unavailable: null, login: null }, SIGNED_IN);
    const { host, unmount } = await mount();
    try {
      await eventually(() => host.querySelectorAll("li").length === 2, 2_000, "both profiles");
      const [work, home] = [...host.querySelectorAll("li")];
      expect(work?.textContent).toContain("In use");
      expect(work?.textContent).toContain("Signed in");
      expect(work?.textContent).toContain("Sign in again");
      expect(home?.textContent).toContain("Not signed in");
      expect(host.textContent).not.toContain("cannot answer");
      await eventually(() => !button(host, "Use for Coder")?.disabled, 2_000, "Use, once the admin is known");
      button(host, "Use for Coder")!.click();
      await eventually(() => posted.length === 1, 2_000, "the profile used");
      expect(posted[0]).toEqual({ path: "/api/control/agents/coder/cli", body: { profile: "home" } });
      // Added on the Models page, not here.
      expect(host.querySelector('a[href$="/models?tab=clis"]')?.textContent?.trim()).toBe("Add an account");
    } finally {
      unmount();
    }
  });

  test("once a sign-in signed in the profile in use, it leaves nothing behind but the profile's row", async () => {
    serve("admin", { ...CLI, unavailable: null, login: { ...CLI.login!, running: false, output: `${CLI.login!.output}Login successful.\n`, exitCode: 0, signedIn: true, stopped: false } }, SIGNED_IN);
    const { host, unmount } = await mount();
    try {
      expect(host.querySelector("li")?.textContent).toContain("Signed in");
      expect(host.textContent).not.toContain("is signed in.");
      expect(host.textContent).not.toContain("Login successful.");
      expect([...host.querySelectorAll("summary")].map((summary) => summary.textContent)).not.toContain("What the sign-in printed");
      expect(host.querySelector('a[href="https://auth.example.test/device"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  test("one that signed in another profile says so, without its terminal, and offers to use it", async () => {
    serve("admin", { ...CLI, unavailable: null, login: { ...CLI.login!, running: false, output: "Login successful.\n", exitCode: 0, signedIn: true, stopped: false, profile: "home" } }, SIGNED_IN);
    const { host, unmount } = await mount();
    try {
      expect(host.textContent).toContain("The account home is signed in.");
      expect(button(host, "Use it")).toBeDefined();
      expect(host.textContent).not.toContain("Login successful.");
    } finally {
      unmount();
    }
  });

  test("one that ended without signing in keeps its terminal open, and the profile's button is still the one to sign in", async () => {
    serve("admin", { ...CLI, login: { ...CLI.login!, running: false, exitCode: 1, signedIn: false, stopped: false } });
    const { host, unmount } = await mount();
    try {
      expect(host.textContent).toContain("The sign-in for the account work ended without signing in (exit 1).");
      expect([...host.querySelectorAll("details")].find((details) => details.querySelector("summary")?.textContent === "What the sign-in printed")?.hasAttribute("open")).toBe(true);
      expect(button(host, "Sign in")).toBeDefined();
      expect(host.textContent).not.toContain("The account work is signed in.");
    } finally {
      unmount();
    }
  });

  test("Enter alone is sent from its own button, and what was sent is said with what to do if nothing comes (0.8.8)", async () => {
    // "Press Enter to retry" from a terminal UI that turned a code down: the field sends nothing empty.
    const { posted } = serve("admin");
    const { host, unmount } = await mount();
    try {
      await eventually(() => !button(host, "Enter")?.disabled, 2_000, "Enter, once the admin is known");
      expect(host.textContent).not.toContain("If it does not move on within a minute");
      const field = host.querySelector('input[placeholder="The code, or the address the browser ended on"]') as HTMLInputElement;
      type(field, "ABCD-1234");
      button(host, "Enter")!.click();
      await eventually(() => posted.length > 0, 2_000, "Enter posted");
      expect(posted[0]).toEqual({ path: "/api/control/agents/coder/cli/login/answer", body: { text: "" } });
      // What was typed stays for Send: pressed by mistake, Enter dropped a pasted code (Nox's review).
      expect(field.value).toBe("ABCD-1234");
      await eventually(() => (host.textContent ?? "").includes("Sent Enter. The terminal below shows what Codex does with it. If it does not move on within a minute, Stop and sign in again."), 2_000, "the note");
    } finally {
      unmount();
    }
  });

  test("one that exited 0 without signing in says it did not — the daemon's word, not the exit code's (0.8.8)", async () => {
    // An account's sign-in that printed no token exits 0 and kept nothing; the page folded away as though it had worked.
    serve("admin", { ...CLI, login: { ...CLI.login!, running: false, output: "Nouride found no token in what it printed, so nothing was kept.", exitCode: 0, signedIn: false, stopped: false } });
    const { host, unmount } = await mount();
    try {
      expect(host.textContent).toContain("The sign-in for the account work ended without signing in (exit 0).");
      expect(host.querySelector("pre")?.textContent).toContain("Nouride found no token in what it printed, so nothing was kept.");
    } finally {
      unmount();
    }
  });

  test("the model field suggests what the CLI offers, by its words where it gives them, and has no instruction or profile field", async () => {
    serve("admin");
    const { host, unmount } = await mount();
    try {
      const field = host.querySelector('input[role="combobox"]') as HTMLInputElement;
      expect(field.placeholder).toBe("Codex's default");
      field.focus();
      // A model's list waits for typing, or the arrow keys, which show it whole (`Combobox`).
      field.dispatchEvent(new (field.ownerDocument.defaultView as unknown as typeof globalThis).KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await eventually(() => dom.document.querySelector('[role="listbox"]') !== null, 2_000, "the suggestions");
      const listed = dom.document.querySelector('[role="listbox"]')!.textContent ?? "";
      expect(listed).toContain("gpt-5.5-codex");
      expect(listed).toContain("GPT-5.5 mini");
      expect(host.textContent).not.toContain("Instruction");
      expect(host.textContent).not.toContain("PROFILE");
      expect(host.querySelector("textarea")).toBeNull();
    } finally {
      unmount();
    }
  });

  test("the effort row shows what the CLI offers for its model, the one it is set to marked, and whether [llm] effort reached it (0.8.7)", async () => {
    serve("admin", { ...CLI, effort: "high", efforts: [{ value: "low" }, { value: "high", current: "high" }] });
    let mounted = await mount();
    try {
      await eventually(() => mounted.host.textContent?.includes("Its effort is high, set on Codex.") === true, 2_000, "the effort row");
      expect([...mounted.host.querySelectorAll('[title="Codex is on this now"]')].map((button) => button.textContent)).toEqual(["high ·"]);
      // What the CLI does not offer for its model is still a choice, marked as one it keeps its own on.
      expect([...mounted.host.querySelectorAll('[title^="Codex does not offer this"]')].map((button) => button.textContent)).toEqual(["medium", "xhigh", "max"]);
    } finally {
      mounted.unmount();
    }
    serve("admin", { ...CLI, effort: "max", efforts: [{ value: "low", current: "low" }, { value: "high" }] });
    mounted = await mount();
    try {
      await eventually(() => mounted.host.textContent?.includes("Its effort is max, which this model does not offer: Codex keeps its own.") === true, 2_000, "the kept note");
    } finally {
      mounted.unmount();
    }
  });

  const radios = (host: HTMLElement) => [...host.querySelectorAll('[role="radiogroup"][aria-label="Effort"] [role="radio"]')] as HTMLButtonElement[];
  const chosen = (host: HTMLElement) => radios(host).find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;

  test("an effort is chosen here and saved with the form; unchanged, a save leaves it alone (0.8.7)", async () => {
    // Following the install's medium: "Default (medium)" is the choice, not a level of its own.
    const { posted } = serve("admin", { ...CLI, effort: "medium", effortDefault: "medium", efforts: [{ value: "medium", current: "medium" }, { value: "xhigh" }] }, SIGNED_IN);
    const { host, unmount } = await mount();
    try {
      await eventually(() => radios(host).length === 6, 2_000, "the effort choices");
      expect(chosen(host)).toBe("Default (medium)");
      const save = () => ([...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save") as HTMLButtonElement).click();
      save();
      await eventually(() => posted.length > 0, 2_000, "the first save");
      expect(posted.at(-1)!.body).not.toHaveProperty("effort");
      radios(host).find((radio) => radio.textContent === "xhigh")!.click();
      await eventually(() => chosen(host) === "xhigh", 2_000, "xhigh chosen");
      save();
      await eventually(() => posted.length > 1, 2_000, "the second save");
      expect(posted.at(-1)).toEqual({ path: "/api/control/agents/coder/cli", body: { permissions: "risky", model: "", effort: "xhigh" } });
    } finally {
      unmount();
    }
  });

  test("a viewer sees the effort and cannot choose one", async () => {
    serve("viewer", { ...CLI, effort: "high", effortDefault: "medium" }, SIGNED_IN);
    const { host, unmount } = await mount();
    try {
      await eventually(() => radios(host).length === 6, 2_000, "the effort choices");
      expect(chosen(host)).toBe("high");
      expect(radios(host).every((radio) => radio.disabled)).toBe(true);
    } finally {
      unmount();
    }
  });
});
