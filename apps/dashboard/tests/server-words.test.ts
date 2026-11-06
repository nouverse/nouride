/**
 * The server's refusals and notes in the dashboard's words (0.8.20). A route whose words are the CLI's (a section of the
 * config file, a flag, a `git` word) gives the page's own as `plain`; the page says those, and puts the route's own
 * under Details, where whoever runs the server finds them. A reply without one is said as it always was, so a page
 * newer than its server still says something.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Window } from "happy-dom";
import { createElement, useEffect } from "react";
import { renderToString } from "react-dom/server";
import { ApiError, failureWords, request } from "@/commons/lib/api.client";
import { ErrorNote } from "@/commons/components/ui/ui";
import { TestResult } from "@/modules/web-search/components/TestResult";
import { needsClientId } from "@/commons/components/mcp/McpServerLogin";
import { eventually } from "./wait.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every request with one reply, as the route would. */
function replying(status: number, body: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function refusal(status: number, body: unknown): Promise<ApiError> {
  replying(status, body);
  try {
    await request("/api/control/memory/embed", { method: "POST" });
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("the request was not refused");
}

const EMBED = {
  error: "semantic search is off: it needs [memory.semantic] enabled, provider and model",
  plain: "Search by meaning is off. Turn it on under Semantic search with an embedding model, then embed again.",
};

describe("what the client makes of a refusal", () => {
  test("the page's words where the route gives them; its own under Details, a line each, and kept for code to read", async () => {
    const err = await refusal(409, { ...EMBED, note: "turn it on first" });
    expect(err.message).toBe(EMBED.plain);
    // The plain one says what to do: the route's note is not said after it, but kept with its error.
    expect(err.note).toBeUndefined();
    expect(err.detail).toBe(`${EMBED.error}\nturn it on first`);
    expect(err.server).toEqual({ error: EMBED.error, note: "turn it on first" });
    expect(failureWords(err)).toEqual({ said: EMBED.plain, detail: `${EMBED.error}\nturn it on first` });
  });

  test("a reply with no plain, from a server before 0.8.20, as it always was", async () => {
    const err = await refusal(409, { error: "nothing would restart this daemon", note: "install a service first" });
    expect(err.message).toBe("nothing would restart this daemon");
    expect(err.note).toBe("install a service first");
    expect(err.server).toBeUndefined();
    expect(failureWords(err)).toEqual({ said: "nothing would restart this daemon: install a service first", detail: null });
    const silent = await refusal(500, {});
    expect(failureWords(silent)).toEqual({ said: "the server could not do that", detail: "/api/control/memory/embed answered 500" });
  });

  test("code that tells one refusal from another reads the route's own words, not the page's", () => {
    const words = "the authorization server https://github.com/login/oauth offers no dynamic client registration, so logging in to it needs a client id: …";
    const plain = new ApiError(400, "Signing in to this connector could not start. Check its settings, and try again.", undefined, words, { error: words });
    expect(needsClientId(plain)).toBe(true);
  });
});

describe("what the page shows", () => {
  test("ErrorNote: the page's words, the route's own only under Details", async () => {
    const html = renderToString(createElement(ErrorNote, { error: await refusal(409, EMBED) }));
    const [outside, inside] = html.split("<details");
    expect(outside).toContain(EMBED.plain);
    expect(outside).not.toContain("[memory.semantic]");
    expect(inside).toContain("<summary");
    expect(inside).toContain(EMBED.error);
  });

  test("a failed test search: its everyday words, the service's own under Details; or the service's alone, as before", () => {
    const html = renderToString(createElement(TestResult, { result: { ok: false, error: "this combination does not give web_search a backend", plain: "These choices leave the agents no search service to use." } }));
    const [outside, inside] = html.split("<details");
    expect(outside).toContain("These choices leave the agents no search service to use.");
    expect(outside).not.toContain("web_search");
    expect(inside).toContain("web_search");
    expect(renderToString(createElement(TestResult, { result: { ok: false, error: "enter the endpoint first" } }))).toContain("enter the endpoint first");
  });
});

const SRC = join(import.meta.dir, "..", "src");
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

test("every toast of a failure is handed what was thrown, so it says failureWords' and never the error's own name", () => {
  // `String(error)` of an ApiError is "ApiError: <its words>", and eight toasts showed that to a person.
  const handed = sources(SRC).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) => (/toast\.error\([^;]*,\s*(?:String\(|\w+\.message\b|\w+ instanceof Error \?)/.test(line) ? [`${relative(SRC, path)}:${index + 1}`] : [])),
  );
  expect(handed).toEqual([]);
});

describe("a toast of a refusal", () => {
  const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"] as const;
  let dom: Window;
  beforeAll(() => {
    dom = new Window({ url: "http://localhost/dashboard/" });
    for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  });

  test("says the page's words, and the route's own under Details; a string as the line it is", async () => {
    const { createRoot } = await import("react-dom/client");
    const { ToastProvider, useToast } = await import("@/commons/components/ui/toast");
    const err = await refusal(409, { ...EMBED, note: "turn it on first" });
    function Raise() {
      const toast = useToast();
      useEffect(() => {
        toast.error("Could not embed", err);
        toast.error("Could not save", "Check the name.");
      }, [toast]);
      return null;
    }
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    root.render(createElement(ToastProvider, null, createElement(Raise)));
    try {
      await eventually(() => (host.textContent ?? "").includes("Could not save"), 2_000, "the toasts");
      const [embed, save] = [...host.querySelectorAll('[role="status"]')];
      const details = embed!.querySelector("details");
      expect(embed!.textContent).toContain(`Could not embed${EMBED.plain}`);
      expect(details?.querySelector("summary")?.textContent).toBe("Details");
      expect(details?.textContent).toContain(EMBED.error);
      expect(details?.textContent).toContain("turn it on first");
      // Closed until opened, for whoever runs the server.
      expect(details?.hasAttribute("open")).toBe(false);
      expect(save!.textContent).toContain("Could not saveCheck the name.");
      expect(save!.querySelector("details")).toBeNull();
    } finally {
      root.unmount();
    }
  });
});
