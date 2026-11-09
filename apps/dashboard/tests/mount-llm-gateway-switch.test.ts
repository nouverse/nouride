/**
 * Nougate, switched on and off from the dashboard, mounted: every build carries it off, so the setup wizard offers it
 * and turns it on before its sign-in step, the LLM Gateway page says what it is and turns it on, and turning it off asks
 * first, naming the agents that stop answering. And the notice that the Docker image has a new name. Over the shared
 * harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const UNFINISHED = { complete: false, hasAdmin: true, hasUser: true, hasProvider: false, hasAgent: false };
const FINISHED = { complete: true, hasAdmin: true, hasUser: true, hasProvider: true, hasAgent: true };
const OFF = { available: false, carried: true, mount: "/llm-gateway" };
const ON = { available: true, baseUrl: "http://127.0.0.1:18256", mount: "/llm-gateway", dashboard: true, carried: true };

/**
 * What the page sends to turn the switch, with its body, answered here; and the gateway's own API, which is not the
 * control API's and is otherwise left to the real `fetch`. `then` puts the daemon in the state the switch leaves it in.
 */
function switchSpy(reply: unknown, then?: () => void) {
  const puts: unknown[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    const path = new URL(url, "http://localhost").pathname;
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    if (path === "/api/control/llm-gateway" && init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      then?.();
      return json(reply);
    }
    if (path.startsWith("/llm-gateway/api/")) return json([]);
    return (spy as typeof fetch)(input as RequestInfo, init);
  }) as typeof fetch;
  return { puts, restore: () => void (globalThis.fetch = spy) };
}

const buttonWith = (host: HTMLElement, words: string) =>
  [...host.ownerDocument.querySelectorAll("button")].find((button) => (button.textContent ?? "").includes(words)) as HTMLButtonElement | undefined;
const text = (host: HTMLElement) => host.ownerDocument.body.textContent ?? "";

test("the setup wizard offers Nougate while it is off, turns it on when chosen, and goes on to its sign-in step", async () => {
  answer({ "/setup/state": { status: 200, body: { ...UNFINISHED, bundledGateway: OFF } } });
  const spy = switchSpy({ on: true, saved: true, said: "Nougate is on." }, () =>
    answer({ "/setup/state": { status: 200, body: { ...UNFINISHED, bundledGateway: ON } } }),
  );
  try {
    await renderPage("/setup", async (host) => {
      await eventually(() => buttonWith(host, "Use Nougate") !== undefined, 2_000, "the offer drawn while it is off");
      // Nothing is turned on by drawing the page: an API key is still the first way in.
      expect(spy.puts).toEqual([]);
      buttonWith(host, "Use Nougate")!.click();
      await eventually(() => text(host).includes("Sign in with an AI subscription"), 3_000, "the sign-in step");
    });
    expect(spy.puts).toEqual([{ on: true }]);
  } finally {
    spy.restore();
  }
});

test("the wizard offers nothing where the build does not carry it, or only the server can turn it on", async () => {
  for (const bundledGateway of [{ available: false, carried: false }, { ...OFF, decidedBy: "environment" }, { available: false }]) {
    answer({ "/setup/state": { status: 200, body: { ...UNFINISHED, bundledGateway } } });
    const html = await renderPage("/setup", async (host) => {
      await eventually(() => text(host).includes("Connect an AI provider"), 2_000, "the key form");
    });
    expect({ bundledGateway, offered: html.includes("Use Nougate") }).toEqual({ bundledGateway, offered: false });
  }
});

test("the LLM Gateway page, off, says what Nougate is and turns it on in place", async () => {
  answer({ "/setup/state": { status: 200, body: { ...FINISHED, bundledGateway: OFF } } });
  const spy = switchSpy({ on: true, saved: true, said: "Nougate is on." }, () =>
    answer({ "/setup/state": { status: 200, body: { ...FINISHED, bundledGateway: ON } } }),
  );
  try {
    await renderPage("/llm-gateway", async (host) => {
      await eventually(() => buttonWith(host, "Turn on Nougate") !== undefined, 2_000, "the off card");
      expect(text(host)).toContain("an AI account you already pay for, instead of an API key");
      buttonWith(host, "Turn on Nougate")!.click();
      await eventually(() => host.querySelector("iframe") !== null, 3_000, "the gateway's own page, framed");
      expect(buttonWith(host, "Turn off")).toBeDefined();
    });
    expect(spy.puts).toEqual([{ on: true }]);
  } finally {
    spy.restore();
  }
});

test("where the server holds the switch, the page shows it as the server's and offers nothing to press", async () => {
  answer({ "/setup/state": { status: 200, body: { ...FINISHED, bundledGateway: { ...OFF, decidedBy: "environment" } } } });
  let toggle: HTMLInputElement | null = null;
  const html = await renderPage("/llm-gateway", async (host) => {
    await eventually(() => text(host).includes("set on the server itself"), 2_000, "the switch, as the server's");
    toggle = host.querySelector<HTMLInputElement>('main input[type="checkbox"]');
  });
  expect(html).not.toContain("Turn on Nougate");
  expect({ shown: toggle !== null, disabled: (toggle as HTMLInputElement | null)?.disabled, on: (toggle as HTMLInputElement | null)?.checked }).toEqual({ shown: true, disabled: true, on: false });
});

test("turning it off asks first, naming the agents that stop answering and saying Nouride restarts", async () => {
  answer({
    "/setup/state": { status: 200, body: { ...FINISHED, bundledGateway: ON } },
    "/llm-gateway": { status: 200, body: { carried: true, on: true, decidedBy: null, usedBy: [{ id: "nouva", name: "Nouva" }, { id: "kuro", name: "Kuro" }], restarts: true } },
  });
  const spy = switchSpy({ on: true, saved: true, said: "unused" });
  try {
    await renderPage("/llm-gateway", async (host) => {
      await eventually(() => buttonWith(host, "Turn off") !== undefined, 2_000, "the page, on");
      buttonWith(host, "Turn off")!.click();
      await eventually(() => text(host).includes("Turn off Nougate?"), 2_000, "the question");
      expect(text(host)).toContain("Nouva and Kuro get their AI through Nougate, and stop answering until you give them another AI service.");
      expect(text(host)).toContain("Nouride restarts to turn it off");
      expect(buttonWith(host, "Turn off and restart")).toBeDefined();
      // Answered no: nothing is sent.
      buttonWith(host, "Cancel")!.click();
    });
    expect(spy.puts).toEqual([]);
  } finally {
    spy.restore();
  }
});

test("where nothing would start Nouride again, it says so before, and what happened after", async () => {
  answer({
    "/setup/state": { status: 200, body: { ...FINISHED, bundledGateway: ON } },
    "/llm-gateway": { status: 200, body: { carried: true, on: true, decidedBy: null, usedBy: [], restarts: false } },
  });
  const spy = switchSpy({ on: true, saved: true, said: "Saved. Nougate stops the next time Nouride starts." });
  try {
    await renderPage("/llm-gateway", async (host) => {
      await eventually(() => buttonWith(host, "Turn off") !== undefined, 2_000, "the page, on");
      buttonWith(host, "Turn off")!.click();
      await eventually(() => text(host).includes("Turn off Nougate?"), 2_000, "the question");
      expect(text(host)).toContain("No agent gets its AI through Nougate now.");
      expect(text(host)).toContain("Nothing on this server starts Nouride again by itself");
      [...host.ownerDocument.querySelectorAll("dialog button")].find((button) => button.textContent?.trim() === "Turn off")!.dispatchEvent(new (host.ownerDocument.defaultView as unknown as typeof globalThis).MouseEvent("click", { bubbles: true }));
      await eventually(() => text(host).includes("Saved. Nougate stops the next time Nouride starts."), 2_000, "what happened, said");
    });
    expect(spy.puts).toEqual([{ on: false }]);
  } finally {
    spy.restore();
  }
});

test("turned off where nothing restarts Nouride, the page says it stops at the next start rather than offer Turn off again", async () => {
  answer({ "/setup/state": { status: 200, body: { ...FINISHED, bundledGateway: { ...ON, stopping: true } } } });
  const html = await renderPage("/llm-gateway", async (host) => {
    await eventually(() => text(host).includes("Stops when Nouride restarts"), 2_000, "the header, stopping");
  });
  expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*Turn off/);
});

test("the LLM Gateway page is in the menu whenever the build carries it, and not where it does not", async () => {
  const menu = async (bundledGateway: unknown) => {
    answer({ "/setup/state": { status: 200, body: { ...FINISHED, bundledGateway } } });
    return renderPage("/settings");
  };
  expect(await menu(OFF)).toContain("LLM Gateway");
  expect(await menu({ available: false, carried: false })).not.toContain("LLM Gateway");
  // A daemon older than the switch: only where the page can show it, as before.
  expect(await menu({ available: true, mount: "/llm-gateway", dashboard: true })).toContain("LLM Gateway");
  expect(await menu({ available: false })).not.toContain("LLM Gateway");
});

test("a container under the image's old name is told the new one, and a dismissed notice stays dismissed for the session", async () => {
  const health = WIRE["/health"] as Record<string, unknown>;
  answer({ "/health": { status: 200, body: { ...health, imageMovedTo: "ghcr.io/nouverse/nouride" } } });
  const words = "Nouride's Docker image has a new name: ghcr.io/nouverse/nouride. Switch to it before version 0.9: the old name stops getting updates then.";
  await renderPage("/", async (host) => {
    await eventually(() => text(host).includes(words), 2_000, "the notice");
    const dismiss = host.querySelector<HTMLButtonElement>('[role="status"] button[aria-label="Dismiss"]')!;
    dismiss.click();
    await eventually(() => !text(host).includes("has a new name"), 2_000, "the notice gone");
  });
  // The next page of this session does not say it again.
  const again = await renderPage("/");
  expect(again).not.toContain("has a new name");
  // And an image under its own name says nothing.
  sessionStorage.clear();
  answer({ "/health": { status: 200, body: health } });
  expect(await renderPage("/")).not.toContain("has a new name");
});
