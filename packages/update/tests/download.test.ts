/**
 * Downloading a release, stopping, and picking it up again.
 *
 * The cases worth writing down are the ones that corrupt a file rather than fail loudly: a
 * resume appended to the wrong release, a resume appended to a server that ignored the range
 * and sent the whole thing again. Both produce a file of plausible size that fails its checksum
 * with nothing explaining why.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseDownload, stagingDir } from "../src/download.ts";
import { sleep } from "./wait.ts";

let installDir: string;

beforeEach(() => {
  installDir = mkdtempSync(join(tmpdir(), "nouride-dl-"));
});

afterEach(() => {
  rmSync(installDir, { recursive: true, force: true });
});

const BODY = "0123456789abcdefghij"; // 20 bytes, so offsets are readable

/**
 * A server that honours `Range`, and can be told to stall part way through.
 *
 * `stallAfter` stops the stream without ending it, which is what a pause has to survive: the
 * bytes already written stay on disk and the next request asks for the rest.
 */
function server(options: { body?: string; honourRange?: boolean; stallAfter?: number } = {}): typeof fetch {
  const body = options.body ?? BODY;
  const honourRange = options.honourRange ?? true;

  return (async (_url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    const range = init?.headers?.range;
    const from = honourRange && range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const slice = body.slice(from);
    const limit = options.stallAfter ?? slice.length;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const sent = slice.slice(0, limit);
        if (sent.length > 0) controller.enqueue(new TextEncoder().encode(sent));
        if (limit >= slice.length) {
          controller.close();
          return;
        }
        /**
         * Left open on purpose, and ended by the signal — which is what a real `fetch` does.
         *
         * The first version of this fake ignored `signal`, so `pause()` aborted a controller
         * nobody was listening to and the reader waited for ever. That is the fake being
         * unrealistic rather than the code being wrong, but it hid the thing under test.
         */
        init?.signal?.addEventListener("abort", () => {
          try {
            controller.error(new Error("aborted"));
          } catch {
            // already closed
          }
        });
      },
    });

    return {
      ok: true,
      status: range && honourRange ? 206 : 200,
      headers: { get: (name: string) => (name === "content-length" ? String(slice.length) : null) },
      body: stream,
    };
  }) as unknown as typeof fetch;
}

const request = (fetchImpl: typeof fetch, tag = "v0.3.3") => ({
  installDir,
  url: "https://example.invalid/x.tar.gz",
  tag,
  artifact: "nouride-linux-x64",
  fetchImpl,
});

describe("a plain download", () => {
  test("writes the file and reports it ready", async () => {
    const download = new ReleaseDownload();
    await download.start(request(server()));
    const done = await download.settle();

    expect(done.status).toBe("ready");
    expect(done.received).toBe(BODY.length);
    expect(done.path).toBe(join(stagingDir(installDir), "nouride-linux-x64.tar.gz"));
    expect(readFileSync(done.path!, "utf8")).toBe(BODY);
  });

  test("progress is readable while it runs", async () => {
    const download = new ReleaseDownload();
    const started = await download.start(request(server()));
    expect(started.status).toBe("downloading");
    expect(started.artifact).toBe("nouride-linux-x64");
    await download.settle();
  });
});

describe("pausing and resuming", () => {
  test("a pause keeps what is on disk, and the resume asks for the rest", async () => {
    const download = new ReleaseDownload();
    await download.start(request(server({ stallAfter: 8 })));
    // Let the first eight bytes land, then stop.
    await sleep(60);
    const paused = download.pause();
    await download.settle();

    expect(paused.status).toBe("paused");
    expect(download.snapshot().received).toBe(8);

    /**
     * And the resume must actually resume. Counted in bytes served rather than inferred from
     * the finished file: without the `Range` header the fallback restarts the transfer and the
     * result is still correct — correct, and having re-downloaded everything, which on a 43 MB
     * release over a home connection is the whole point of the button.
     */
    let servedFrom = -1;
    const counting = ((url: string, init?: { headers?: Record<string, string> }) => {
      servedFrom = Number(/bytes=(\d+)-/.exec(init?.headers?.range ?? "")?.[1] ?? -1);
      return (server() as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    await download.start(request(counting));
    const done = await download.settle();
    expect(done.status).toBe("ready");
    expect(readFileSync(done.path!, "utf8")).toBe(BODY);
    expect(servedFrom).toBe(8);
  });

  test("a server that ignores the range starts the file again rather than appending", async () => {
    /**
     * The quiet corruption this prevents: 8 bytes on disk plus a full 20-byte body appended is
     * a 28-byte file that fails its checksum and says nothing about why.
     */
    const download = new ReleaseDownload();
    await download.start(request(server({ stallAfter: 8 })));
    await sleep(60);
    download.pause();
    await download.settle();
    expect(download.snapshot().received).toBe(8);

    await download.start(request(server({ honourRange: false })));
    const done = await download.settle();
    expect(done.received).toBe(BODY.length);
    expect(readFileSync(done.path!, "utf8")).toBe(BODY);
  });

  test("a different release throws away the partial", async () => {
    // Appending v0.3.4 to a half-downloaded v0.3.3 is a file of the right size for nothing.
    const download = new ReleaseDownload();
    await download.start(request(server({ stallAfter: 8 }), "v0.3.3"));
    await sleep(60);
    download.pause();
    await download.settle();

    await download.start(request(server({ body: "ZZZZZZZZZZ" }), "v0.3.4"));
    const done = await download.settle();
    expect(done.tag).toBe("v0.3.4");
    expect(readFileSync(done.path!, "utf8")).toBe("ZZZZZZZZZZ");
  });

  test("starting twice does not start a second transfer", async () => {
    let calls = 0;
    const counting = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return (server() as unknown as (...a: Parameters<typeof fetch>) => Promise<Response>)(...args);
    }) as unknown as typeof fetch;

    const download = new ReleaseDownload();
    await download.start(request(counting));
    await download.start(request(counting));
    await download.settle();
    expect(calls).toBe(1);
  });
});

describe("giving up on it", () => {
  test("discard removes the staging directory and forgets the release", async () => {
    const download = new ReleaseDownload();
    await download.start(request(server()));
    await download.settle();
    expect(existsSync(stagingDir(installDir))).toBe(true);

    const after = await download.discard();
    expect(existsSync(stagingDir(installDir))).toBe(false);
    expect(after.status).toBe("idle");
    expect(after.tag).toBeNull();
  });
});

describe("failures", () => {
  test("a bad status is reported rather than left looking like a stall", async () => {
    const dead = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const download = new ReleaseDownload();
    await download.start(request(dead));
    const done = await download.settle();
    expect(done.status).toBe("failed");
    expect(done.error).toContain("404");
  });
});
