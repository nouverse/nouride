/**
 * An attachment's download, handed to the engine unread.
 *
 * The adapters used to `arrayBuffer()` the whole file before anything could look at its size, with no deadline at
 * all. What is pinned here is the part only an adapter can get right: the body leaves unread, the declared length
 * goes with it, and the engine's deadline reaches every request made for the file.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { TelegramGateway } from "../src/channels/telegram/gateway.ts";
import { openDownload } from "../src/commons/download.ts";

/** A body that counts what was read from it and says whether it was let go. Reads nothing until asked. */
function source(chunks = 3) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled === chunks) return controller.close();
        seen.pulled += 1;
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, seen };
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

/** `fetch` answering every request with `answer`, and the requests it was asked. */
function serve(answer: () => Response): { url: string; signal?: AbortSignal | null }[] {
  const asked: { url: string; signal?: AbortSignal | null }[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), signal: init?.signal });
    return answer();
  }) as typeof fetch);
  return asked;
}

describe("openDownload", () => {
  test("the body goes back unread, with the length the server declared and the caller's deadline on the request", async () => {
    const { body, seen } = source();
    const asked = serve(() => new Response(body, { headers: { "content-length": "30" } }));
    const signal = AbortSignal.timeout(30_000);

    const download = await openDownload("https://cdn.example/file.png", signal);

    expect(download).toMatchObject({ declaredBytes: 30 });
    expect(seen.pulled).toBe(0);
    expect(asked).toEqual([{ url: "https://cdn.example/file.png", signal }]);
  });

  test("no length is no claim, rather than a length of nothing", async () => {
    serve(() => new Response(source().body));
    expect(await openDownload("https://cdn.example/file.png")).toMatchObject({ declaredBytes: null });
  });

  test("a status that is not a file is said, and its body let go rather than left holding the connection", async () => {
    const { body, seen } = source();
    serve(() => new Response(body, { status: 404 }));

    expect(await openDownload("https://cdn.example/gone.png")).toEqual({ status: 404 });
    expect(seen.cancelled).toBe(true);
  });
});

describe("the adapters", () => {
  test("Discord: the CDN link, under the engine's deadline, comes back as a stream", async () => {
    const asked = serve(() => new Response(source().body, { headers: { "content-length": "30" } }));
    const gateway = new DiscordGateway({ id: "discord:main", platform: "discord", token: "t" });
    const signal = AbortSignal.timeout(30_000);

    const download = await gateway.fetchAttachment({ type: "image", mimeType: "image/png", url: "https://cdn.discordapp.com/a.png" }, signal);

    expect(download).toMatchObject({ declaredBytes: 30 });
    expect(asked).toEqual([{ url: "https://cdn.discordapp.com/a.png", signal }]);
  });

  test("Telegram: getFile and the download both carry the deadline, and a refused download is no file", async () => {
    const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "123:abc", mode: "polling" });
    const lookups: (AbortSignal | undefined)[] = [];
    // `connect()` would put a polling bot here; only `getFile` is asked of it.
    (gateway as unknown as { bot: unknown }).bot = {
      api: {
        getFile: async (_id: string, signal?: AbortSignal) => {
          lookups.push(signal);
          return { file_path: "photos/file_1.jpg" };
        },
      },
    };
    const signal = AbortSignal.timeout(30_000);
    const asked = serve(() => new Response(source().body, { headers: { "content-length": "30" } }));

    expect(await gateway.fetchAttachment({ type: "image", mimeType: "image/jpeg", url: "AgAD" }, signal)).toMatchObject({ declaredBytes: 30 });
    expect(lookups).toEqual([signal]);
    expect(asked).toEqual([{ url: "https://api.telegram.org/file/bot123:abc/photos/file_1.jpg", signal }]);

    serve(() => new Response("nope", { status: 403 }));
    expect(await gateway.fetchAttachment({ type: "image", mimeType: "image/jpeg", url: "AgAD" }, signal)).toBeNull();
  });
});
