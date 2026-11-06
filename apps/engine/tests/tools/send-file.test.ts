/**
 * `send_file`, and the outbound path it exists to make real.
 *
 * `OutboundMessage.attachments` was declared in the first envelope, read by no adapter, and set by
 * nothing in the engine. It type-checked and did nothing — so the test that matters most here is
 * simply that bytes reach the gateway at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Attachment, ToolContext } from "@nouride/shared";
import { createSendFileTool, sendTextFile } from "@/modules/tools/builtins/attach.ts";

/**
 * A fresh directory per run, like the rest of the suite.
 *
 * These were two fixed names *inside the repository*, so two suites running at once shared them and
 * tore down each other's fixtures — 19 failures, all here. That stopped being hypothetical when the
 * pre-commit hook started running the whole suite: commit while a manual `bun test` is going and both
 * are in this directory at the same time.
 */
const DIR = mkdtempSync(join(tmpdir(), "nouride-sendfile-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "nouride-sendfile-outside-"));

let sent: Attachment[];
let ids: string[];
/**
 * What the funnel says about delivery, independently of the ids.
 *
 * The two are separate because an empty id list means two different things: a platform that refused
 * the file, and a transport that has no message ids at all. See `Gateway.addressableMessages`.
 */
let delivered: boolean;
/** The platform's refusal, when the funnel has one to report. */
let refused: string | undefined;

function tool(maxBytes = 1024 * 1024, fetchImpl?: typeof fetch) {
  sent = [];
  return createSendFileTool({
    send: async (_ctx, attachment) => {
      sent.push(attachment);
      return { ids, delivered, ...(refused ? { refused } : {}) };
    },
    maxBytes,
    urlPolicy: { allowPrivate: false },
    // No DNS in the suite: the real `checkUrl` resolves the hostname, so a made-up domain would fail
    // on the lookup rather than on the property under test. Private addresses are still refused —
    // this double applies the same rule against the literal, which is what those tests assert.
    checkUrlImpl: async (raw: string) => {
      const host = new URL(raw).hostname;
      return /^(127\.|169\.254\.|10\.|192\.168\.|::1|localhost$)/.test(host)
        ? { allowed: false, reason: `refused ${host}` }
        : { allowed: true };
    },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** A fetch double: one response, or a redirect chain when `location` is given. */
function respond(init: {
  body?: Uint8Array;
  status?: number;
  contentType?: string;
  contentLength?: string;
  location?: string;
}): typeof fetch {
  return (async () => {
    const headers = new Headers();
    if (init.contentType) headers.set("content-type", init.contentType);
    if (init.contentLength) headers.set("content-length", init.contentLength);
    if (init.location) headers.set("location", init.location);
    const body = init.body ?? new TextEncoder().encode("bytes");
    return new Response(init.status && init.status >= 300 ? null : body, {
      status: init.status ?? 200,
      headers,
    });
  }) as unknown as typeof fetch;
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "nouva",
    sessionId: "ses_1",
    chatId: "12345",
    gateway: "telegram",
    gatewayId: "telegram:main",
    senderId: "user-7",
    workspaceDir: DIR,
    agentDir: DIR,
    workspaceRoots: [DIR],
    signal: new AbortController().signal,
    ...overrides,
  } as ToolContext;
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  ids = ["msg-1"];
  delivered = true;
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

describe("sending", () => {
  test("the file's bytes reach the gateway", async () => {
    writeFileSync(join(DIR, "build.log"), "line one\nline two\n");

    const result = await tool().execute({ path: "build.log" }, context());

    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
    // The whole point: bytes, not a path. A gateway may not share a filesystem with the engine.
    expect(new TextDecoder().decode(sent[0]!.buffer!)).toBe("line one\nline two\n");
    expect(sent[0]!.filename).toBe("build.log");
    expect(sent[0]!.size).toBe(18);
  });

  test("a caption travels with the file", async () => {
    writeFileSync(join(DIR, "report.md"), "# Report");
    await tool().execute({ path: "report.md", caption: "last night's run" }, context());
    expect(sent[0]!.caption).toBe("last night's run");
  });

  test("an image is typed as one, so a platform can render it inline", async () => {
    writeFileSync(join(DIR, "shot.png"), "notreallyapng");
    await tool().execute({ path: "shot.png" }, context());
    expect(sent[0]!.type).toBe("image");
    expect(sent[0]!.mimeType).toBe("image/png");
  });

  test("documents go as plain files — a PDF, a Word file, a spreadsheet, an archive", async () => {
    // The expectation this pins: `send_file` is not an image feature. Anything that is not media
    // presents as a document, which is what every platform does best with a file it cannot preview.
    const cases: [string, string][] = [
      ["report.pdf", "application/pdf"],
      ["notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["dump.sql", "application/sql"],
      ["bundle.zip", "application/zip"],
    ];

    for (const [filename, mimeType] of cases) {
      writeFileSync(join(DIR, filename), "content");
      const t = tool();
      const result = await t.execute({ path: filename }, context());
      expect(result.isError).toBe(false);
      expect(sent[0]!.type).toBe("file");
      expect(sent[0]!.mimeType).toBe(mimeType);
    }
  });

  test("an unknown extension is a plain file rather than a guess", async () => {
    writeFileSync(join(DIR, "thing.xyzzy"), "data");
    await tool().execute({ path: "thing.xyzzy" }, context());
    expect(sent[0]!.type).toBe("file");
    expect(sent[0]!.mimeType).toBe("application/octet-stream");
  });
});

describe("refusing", () => {
  test("a path outside the workspace is refused, and nothing is sent", async () => {
    writeFileSync(join(OUTSIDE, "secret.txt"), "credentials");

    const result = await tool().execute({ path: "../.tmp-send-file-outside/secret.txt" }, context());

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the directories/);
    expect(sent).toHaveLength(0);
  });

  test("an absolute path outside the workspace is refused too", async () => {
    writeFileSync(join(OUTSIDE, "secret.txt"), "credentials");
    const result = await tool().execute({ path: join(OUTSIDE, "secret.txt") }, context());
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test("a read-only root is reachable — a build log lives there", async () => {
    const logs = join(OUTSIDE, "jobs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "job.log"), "output");

    const result = await tool().execute(
      { path: join(logs, "job.log") },
      context({ readOnlyRoots: [logs] }),
    );

    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("a file over the cap is refused with both numbers named", async () => {
    writeFileSync(join(DIR, "big.bin"), "x".repeat(2048));
    const result = await tool(1024).execute({ path: "big.bin" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/2\.0KB|2KB/);
    expect(result.content).toMatch(/1KB/);
    expect(sent).toHaveLength(0);
  });

  test("an empty file is refused here rather than by the platform", async () => {
    writeFileSync(join(DIR, "empty.log"), "");
    const result = await tool().execute({ path: "empty.log" }, context());
    // Platforms reject a zero-byte upload with an error that reads like a network fault.
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/empty/);
    expect(sent).toHaveLength(0);
  });

  test("a directory is refused", async () => {
    mkdirSync(join(DIR, "sub"));
    const result = await tool().execute({ path: "sub" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/directory/);
  });

  test("a missing file says so", async () => {
    const result = await tool().execute({ path: "nope.log" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/does not exist/);
  });

  test("a missing path argument is answered, not thrown", async () => {
    const result = await tool().execute({}, context());
    expect(result.isError).toBe(true);
  });
});

test("a gateway that accepted nothing is reported as a failure, not a success", async () => {
  writeFileSync(join(DIR, "build.log"), "output");
  // Buffered by a disconnected gateway, or the gateway is gone.
  ids = [];
  delivered = false;

  const result = await tool().execute({ path: "build.log" }, context());

  // Reporting success here would have the agent tell the operator a file arrived that never did.
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/could not be delivered/);
});

test("a platform's refusal is said in its words, and not as something that may arrive later", async () => {
  // A chat the bot cannot write to will not take the file after a reconnect either; "it may arrive" had the agent
  // tell someone to wait for it.
  writeFileSync(join(DIR, "report.pdf"), "pdf");
  ids = [];
  delivered = false;
  refused = "Forbidden: bot was blocked by the user";
  try {
    const result = await tool().execute({ path: "report.pdf" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("the platform refused it: Forbidden: bot was blocked by the user");
    expect(result.content).not.toContain("may arrive");
  } finally {
    refused = undefined;
  }
});

test("a transport with no message ids is a success, because that is what it looks like", async () => {
  /**
   * The mirror of the test above, and the one that shipped broken.
   *
   * The dashboard's gateway has no addressable messages, so `send` correctly answers with no ids.
   * Judging delivery by `ids.length` reported `could not be delivered — the gateway did not accept it`
   * for two images that were delivered, were on screen, and were in the transcript — and the agent
   * passed that on to the operator as a broken gateway, asking them to restart the daemon.
   */
  writeFileSync(join(DIR, "report.txt"), "output");
  ids = [];
  delivered = true;

  const result = await tool().execute({ path: "report.txt" }, context());

  expect(result.isError).toBe(false);
  expect(result.content).not.toMatch(/could not be delivered/);
  expect(sent).toHaveLength(1);
});

test("it needs no approval, because it discloses nothing `read` does not", () => {
  expect(tool().requiresApproval).toBe(false);
});

describe("sending from a URL", () => {
  test("the bytes are fetched here and sent, not handed to the platform as a link", async () => {
    const png = new TextEncoder().encode("fake-png-bytes");
    const t = tool(1024 * 1024, respond({ body: png, contentType: "image/png" }));

    const result = await t.execute({ url: "https://example.com/photo.png" }, context());

    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.buffer).toEqual(png);
    expect(sent[0]!.type).toBe("image");
    expect(sent[0]!.filename).toBe("photo.png");
  });

  test("a URL with no usable filename is named from its content type", async () => {
    const t = tool(1024 * 1024, respond({ contentType: "image/jpeg" }));
    await t.execute({ url: "https://cdn.example.com/a1b2c3d4" }, context());
    // A person receiving this should get something openable, not a bare hash.
    expect(sent[0]!.filename).toBe("a1b2c3d4.jpg");
    expect(sent[0]!.type).toBe("image");
  });

  test("a private address is refused — the URL came from search results", async () => {
    const t = tool(1024 * 1024, respond({ contentType: "image/png" }));
    const result = await t.execute({ url: "http://127.0.0.1:8080/secret.png" }, context());
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test("a redirect to a private address is refused too", async () => {
    let hop = 0;
    const doFetch = (async () => {
      hop += 1;
      const headers = new Headers();
      if (hop === 1) {
        headers.set("location", "http://169.254.169.254/latest/meta-data/");
        return new Response(null, { status: 302, headers });
      }
      headers.set("content-type", "image/png");
      return new Response(new TextEncoder().encode("secrets"), { status: 200, headers });
    }) as unknown as typeof fetch;

    const t = tool(1024 * 1024, doFetch);
    const result = await t.execute({ url: "https://example.com/innocent.png" }, context());

    // The whole reason redirects are followed by hand: `redirect: "follow"` would have hidden this.
    //
    // Asserting on *which* refusal, not just that one happened. Without the redirect branch a 302 is
    // simply not `res.ok` and comes back as "HTTP 302" — also an error, also nothing sent, and a test
    // that only checked `isError` would pass against code that never validated the second hop at all.
    expect(result.isError).toBe(true);
    expect(result.content).toContain("169.254.169.254");
    // One fetch, not two: the hop is validated *before* it is requested, so the metadata endpoint is
    // never contacted at all. Refusing after the request would already have leaked that we asked.
    expect(hop).toBe(1);
    expect(sent).toHaveLength(0);
  });

  test("a declared size over the cap is refused before the body is read", async () => {
    const t = tool(1024, respond({ contentType: "image/png", contentLength: "9999999" }));
    const result = await t.execute({ url: "https://example.com/huge.png" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/limit/);
    expect(sent).toHaveLength(0);
  });

  test("a body over the cap is refused even when the server declared no length", async () => {
    const big = new TextEncoder().encode("x".repeat(4096));
    const t = tool(1024, respond({ body: big, contentType: "image/png" }));
    const result = await t.execute({ url: "https://example.com/chunked.png" }, context());
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test("an HTTP error is reported with its status, not as a broken tool", async () => {
    const t = tool(1024 * 1024, respond({ status: 404 }));
    const result = await t.execute({ url: "https://example.com/gone.png" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/404/);
  });

  test("an empty response is refused here rather than by the platform", async () => {
    const t = tool(1024 * 1024, respond({ body: new Uint8Array(0), contentType: "image/png" }));
    const result = await t.execute({ url: "https://example.com/empty.png" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/empty/);
  });

  test("a User-Agent is sent — a lot of the web refuses a request without one", async () => {
    // Found live: Wikimedia answers HTTP 400 to a UA-less fetch, and the error reads like a bad URL.
    let seen: Record<string, string> = {};
    const doFetch = (async (_url: string, init: RequestInit) => {
      seen = Object.fromEntries(new Headers(init.headers).entries());
      return new Response(new TextEncoder().encode("bytes"), {
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
      });
    }) as unknown as typeof fetch;

    await tool(1024 * 1024, doFetch).execute({ url: "https://example.com/x.png" }, context());
    expect(seen["user-agent"]).toContain("nouride");
  });

  test("giving both a path and a url is refused rather than one silently winning", async () => {
    writeFileSync(join(DIR, "a.txt"), "x");
    const result = await tool().execute(
      { path: "a.txt", url: "https://example.com/b.png" },
      context(),
    );
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test("a daemon with no URL policy says so instead of fetching", async () => {
    const t = createSendFileTool({
      send: async (_c, a) => {
        sent.push(a);
        return { ids, delivered };
      },
      maxBytes: 1024,
    });
    sent = [];
    const result = await t.execute({ url: "https://example.com/x.png" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not available/);
  });
});

/**
 * A voice note, from the tool's point of view.
 *
 * The tool's whole job here is to *classify* — the platform-specific part (Telegram's `sendVoice`,
 * WhatsApp's `ptt`, Discord's voice-message flag) lives in the adapters, and all three of them read
 * `attachment.type`. So the thing that must not be wrong is what type comes out of a filename.
 */
describe("voice notes", () => {
  test.each([
    ["memo.ogg", "voice", "audio/ogg"],
    ["memo.opus", "voice", "audio/ogg"],
    ["memo.oga", "voice", "audio/ogg"],
    ["song.mp3", "audio", "audio/mpeg"],
    ["notes.txt", "file", "text/plain"],
  ])("%s is sent as %s", async (name, type, mimeType) => {
    writeFileSync(join(DIR, name), "bytes");
    sent = [];

    await tool().execute({ path: name }, context());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe(type as never);
    expect(sent[0]?.mimeType).toBe(mimeType);
  });
});

describe("a file that is not what its name says", () => {
  /**
   * The failure, in full, because every layer behaved reasonably.
   *
   * An agent asked to find a picture of a Shiba Inu searched, picked a URL ending in `.jpg`, and
   * fetched it. The host was behind Cloudflare, so 5,430 bytes of
   * `<!DOCTYPE html><title>Just a moment...</title>` came back. This tool named the file from the
   * extension, sent it as `image/jpeg`, and reported `Sent shiba-inu.jpg` — so the chat showed a
   * broken image, the operator was told it had arrived, and the next agent to open it got
   * `400 Unable to process input image` and reported that *its vision model* could not see the
   * picture. That was the one explanation that was not true.
   */
  const PAGE = new TextEncoder().encode(
    '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head></html>',
  );
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

  test("an HTML page named like an image is refused, not sent", async () => {
    writeFileSync(join(DIR, "shiba-inu.jpg"), PAGE);

    const result = await tool().execute({ path: "shiba-inu.jpg" }, context());

    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
    expect(result.content).toContain("not an image");
    // Actionable, because the useful next step is a different URL rather than a look at the model.
    expect(result.content).toContain("Cloudflare");
    expect(result.content).toContain("shiba-inu.jpg");
  });

  test("the same page fetched from a URL is refused too", async () => {
    // The branch the real failure came in through, and the one where the extension beats the
    // server's `content-type` — deliberately, since a good photo is often `octet-stream`.
    const result = await tool(1024 * 1024, respond({ body: PAGE, contentType: "text/html" })).execute(
      { url: "https://example.test/photos/shiba-inu.jpg" },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
    expect(result.content).toContain("not an image");
  });

  test("a real image whose extension lies is corrected and sent", async () => {
    // The harmless half of the same mismatch. Refusing here would block a working photo, so the
    // label is fixed and the file goes.
    writeFileSync(join(DIR, "photo.jpg"), PNG);

    const result = await tool().execute({ path: "photo.jpg" }, context());

    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mimeType).toBe("image/png");
    // The name is left alone: it is what the person will see, and it is not wrong enough to rewrite.
    expect(sent[0]!.filename).toBe("photo.jpg");
  });

  test("an HTML page sent as an HTML page is fine", async () => {
    // The gate is about a *contradiction*, not about HTML. Sending a saved page is a legitimate act.
    writeFileSync(join(DIR, "report.html"), PAGE);

    const result = await tool().execute({ path: "report.html" }, context());

    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("a text log named .txt is untouched", async () => {
    // The other direction of a false positive: nothing about a non-image send changes.
    writeFileSync(join(DIR, "run.txt"), "ECONNREFUSED 5432\n");

    const result = await tool().execute({ path: "run.txt" }, context());

    expect(result.isError).toBe(false);
    expect(sent[0]!.mimeType).toBe("text/plain");
  });
});

/**
 * A file the daemon writes from text (0.8.11): a mission's `report.md`, with no file on disk — sent as `send_file` sends
 * one, held to the same size, and refused the same way when it holds one of the agent's credentials.
 */
describe("a file from text", () => {
  const sender = (maxBytes = 1024) => ({
    send: async (_ctx: ToolContext, attachment: Attachment) => (sent.push(attachment), { ids, delivered, ...(refused ? { refused } : {}) }),
    maxBytes,
    childEnv: () => ({ DEPLOY_TOKEN: "tok-4f9a2c71e0" }),
  });

  test("goes as a markdown file of its own name, the text whole", async () => {
    sent = [];
    expect(await sendTextFile(sender(), context(), "report.md", "# Done\nAll of it.")).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ filename: "report.md", mimeType: "text/markdown", size: 17 });
    expect(new TextDecoder().decode(sent[0]!.buffer)).toBe("# Done\nAll of it.");
  });

  test("refused holding a credential's value, or past the size an install takes; said when the chat would not take it", async () => {
    sent = [];
    expect(await sendTextFile(sender(), context(), "report.md", "deploy with tok-4f9a2c71e0")).toBe("it holds the value of one of the agent's credentials, and a file sent to a chat goes as it is: nothing can mask it there.");
    expect(await sendTextFile(sender(8), context(), "report.md", "longer than eight")).toBe("it is 17B, over the 8B limit for this install.");
    expect(sent).toHaveLength(0);
    delivered = false;
    refused = "file is too big";
    expect(await sendTextFile(sender(), context(), "report.md", "fine")).toBe("`report.md` could not be delivered, because the platform refused it: file is too big. Sending it again here will not help.");
  });
});
