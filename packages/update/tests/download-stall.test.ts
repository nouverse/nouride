/**
 * A download that stops moving is cut and picked up again, never left "downloading" for ever. A phone's update sat at
 * 0 bytes on a connection that stayed open and sent nothing, and pressing Update again returned the same status. Each
 * test has a short limit of its own: without the watchdog it hangs and fails on that limit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseDownload } from "../src/download.ts";
import { eventually } from "./wait.ts";

let installDir: string;
beforeEach(() => {
  installDir = mkdtempSync(join(tmpdir(), "nouride-dl-stall-"));
});
afterEach(() => {
  rmSync(installDir, { recursive: true, force: true });
});

const BODY = new Uint8Array(4096).map((_, i) => (i * 13 + 5) % 251);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const LIMIT = 5_000;

type Answer = "never" | "silent" | "half" | "whole" | 404;

/**
 * A `fetch` that answers each call with the next of `answers`, as a real one does about its signal: an abort rejects
 * a request still waiting for headers and errors a body still streaming.
 *   never  — no headers at all
 *   silent — headers with the length, then no bytes
 *   half   — the first half, then no more bytes
 *   whole  — what the Range asks for, to the end (206 from a Range, 200 without)
 */
function server(answers: Answer[]) {
  const calls: { range: string }[] = [];
  const fetchImpl = (async (_url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    const answer = answers[Math.min(calls.length, answers.length - 1)]!;
    const range = init?.headers?.range ?? "";
    calls.push({ range });
    const signal = init?.signal;
    const aborted = () => new DOMException("The operation was aborted.", "AbortError");
    if (answer === "never") {
      return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(aborted()), { once: true }));
    }
    if (answer === 404) return new Response("not found", { status: 404 });
    const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    const rest = BODY.slice(from);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (answer === "whole") {
          controller.enqueue(rest);
          controller.close();
          return;
        }
        if (answer === "half") controller.enqueue(rest.slice(0, rest.length / 2));
        signal?.addEventListener("abort", () => controller.error(aborted()), { once: true });
      },
    });
    return new Response(stream, {
      status: from > 0 ? 206 : 200,
      headers: { "content-length": String(rest.length) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function download(fetchImpl: typeof fetch) {
  const dl = new ReleaseDownload();
  const request = { installDir, url: "https://example.invalid/v9.9.9/nouride-linux-x64.tar.gz", tag: "v9.9.9", artifact: "nouride-linux-x64", fetchImpl, stallMs: 100, retryWaitsMs: [0, 0, 0, 0] };
  return { dl, request };
}

describe("an update download that stops moving", () => {
  test("headers, then nothing: the try is cut and the next one brings the file, whole", async () => {
    const net = server(["silent", "whole"]);
    const { dl, request } = download(net.fetchImpl);
    await dl.start(request);
    const done = await dl.settle();
    expect(done.status).toBe("ready");
    expect(net.calls).toHaveLength(2);
    expect(sha(readFileSync(done.path!))).toBe(sha(BODY));
  }, LIMIT);

  test("half, then nothing: the next try asks for the rest with its Range, and the file is whole", async () => {
    const net = server(["half", "whole"]);
    const { dl, request } = download(net.fetchImpl);
    await dl.start(request);
    const done = await dl.settle();
    expect(done.status).toBe("ready");
    expect(net.calls[1]!.range).toBe(`bytes=${BODY.length / 2}-`);
    expect(sha(readFileSync(done.path!))).toBe(sha(BODY));
  }, LIMIT);

  test("a server that never answers: five tries, then failed, with a sentence saying so", async () => {
    const net = server(["never"]);
    const { dl, request } = download(net.fetchImpl);
    await dl.start(request);
    const done = await dl.settle();
    expect(done.status).toBe("failed");
    expect(net.calls).toHaveLength(5);
    expect(done.error).toBe("downloading https://example.invalid/v9.9.9/nouride-linux-x64.tar.gz stopped moving: nothing came for 0 s, 5 tries");
  }, LIMIT);

  test("a release that is not there is an answer: one try, failed", async () => {
    const net = server([404]);
    const { dl, request } = download(net.fetchImpl);
    await dl.start(request);
    const done = await dl.settle();
    expect(done.status).toBe("failed");
    expect(net.calls).toHaveLength(1);
    expect(done.error).toBe("downloading https://example.invalid/v9.9.9/nouride-linux-x64.tar.gz answered 404");
  }, LIMIT);

  test("a pause while it waits is still a pause, not a failure, and the next start goes on", async () => {
    const net = server(["half", "whole"]);
    const { dl, request } = download(net.fetchImpl);
    await dl.start({ ...request, stallMs: 60_000 });
    await eventually(() => dl.snapshot().received > 0, 2_000, "the first half on disk");
    expect(dl.pause().status).toBe("paused");
    const paused = await dl.settle();
    expect(paused.status).toBe("paused");
    expect(paused.error).toBeNull();
    await dl.start(request);
    expect((await dl.settle()).status).toBe("ready");
  }, LIMIT);
});
