/**
 * How often the dashboard asks the release channel, which is once.
 *
 * This is a regression test for an outage rather than a preference. The check used to run on
 * every mount — so walking between pages asked again each time — and the same endpoint served
 * the download's progress, which the page polls once a second. A 70-second download therefore
 * made 70 calls to an API that allows 60 an hour, spent the budget, and every check after it
 * answered 403 including the one the install does. A finished download refused to install.
 *
 * Two properties fix it and both are asserted here, because either one alone puts it back:
 *
 * 1. the check is asked once per page load and never on its own afterwards
 * 2. progress is a different endpoint, so the one-second poll never reaches the channel
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { sleep } from "./wait.ts";

let dom: Window;
let realFetch: typeof fetch;

const DOM_GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of DOM_GLOBALS) {
    (globalThis as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  }
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Counts what was asked for, and answers the two update endpoints plausibly. */
function countingFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("/update/progress")
      ? { download: { status: "idle", received: 0, total: null, tag: null, artifact: null, error: null } }
      : {
          supported: true,
          install: {
            version: "0.3.1",
            edition: "basic",
            installDir: "/srv/nouride",
            supervisor: "systemd",
            compiled: true,
            platform: "linux",
            arch: "arm64",
            musl: false,
          },
          download: { status: "idle", received: 0, total: null, tag: null, artifact: null, error: null },
          check: { current: "0.3.1", latest: "v0.3.1", newer: false, publishedAt: null, notesUrl: null },
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls };
}

/** Mount a component that uses the hook, wait a beat, unmount. */
async function mountOnce(use: () => unknown): Promise<void> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

  const Probe = (): null => {
    use();
    return null;
  };

  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient();

  root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  await sleep(60);
  root.unmount();
  host.remove();
  client.clear();
}

describe("the release check", () => {
  test("is asked once, and not again when a page remounts", async () => {
    /**
     * The regression. `refetchOnMount: "always"` meant every navigation asked the channel, and
     * the sidebar mounts on every page — so a person clicking around spent the hourly budget
     * without touching the update page at all.
     *
     * A fresh `QueryClient` per mount would hide exactly that, so both mounts share one.
     */
    const { calls } = countingFetch();
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { useUpdate } = await import("@/commons/hooks/use-update");

    const client = new QueryClient();
    const Probe = (): null => {
      useUpdate();
      return null;
    };

    for (let i = 0; i < 3; i += 1) {
      const host = dom.document.createElement("div");
      dom.document.body.appendChild(host);
      const root = createRoot(host as unknown as HTMLElement);
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
      await sleep(60);
      root.unmount();
      host.remove();
    }
    client.clear();

    const checks = calls.filter((url) => url.endsWith("/update"));
    // Exactly `/update`: a hook that passed `?force=1` would ask the channel past its cache, and counts as none here.
    expect(checks).toHaveLength(1);
  });
});

describe("the progress poll", () => {
  test("asks a different endpoint, which does not resolve the channel", async () => {
    /**
     * The other half. If progress came from `GET /update`, the one-second poll would drag the
     * release check along with it — which is the outage, wearing a different name.
     */
    const { calls } = countingFetch();
    const { useDownloadProgress } = await import("@/modules/update/useUpdate");
    await mountOnce(() => useDownloadProgress());

    expect(calls.some((url) => url.endsWith("/update/progress"))).toBe(true);
    expect(calls.filter((url) => url.endsWith("/update"))).toHaveLength(0);
  });

  test("stops asking when the server says nothing is downloading", async () => {
    // It polls on its own answer, so "idle" is what turns it off — and an idle install must not
    // be making a request a second for ever.
    const { calls } = countingFetch();
    const { useDownloadProgress } = await import("@/modules/update/useUpdate");

    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

    const client = new QueryClient();
    const Probe = (): null => {
      useDownloadProgress();
      return null;
    };
    const host = dom.document.createElement("div");
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));

    // Half a poll interval past the one-second poll a download gets: a poll that did not stop has asked again by now.
    await sleep(1_500);
    root.unmount();
    host.remove();
    client.clear();

    expect(calls.filter((url) => url.endsWith("/update/progress"))).toHaveLength(1);
  });
});
