/**
 * Files in a conversation, and the rules for handing them back to a browser.
 *
 * The dangerous half of this feature is not storing the file, it is *serving* it: bytes somebody
 * uploaded, returned from the dashboard's own origin, to a page holding the dashboard's session. Two
 * things stand between that and a stored-XSS, and both are pinned here — a client can only name a
 * file by its position on a turn it can already see, and only types a browser renders without
 * executing anything are served inline.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { TurnStore, type TurnAttachment } from "@/modules/turns/turns.store.ts";
import { toTurnPayload } from "@/modules/turns/transcript.ts";
import { tempDir, turnStore } from "../helpers.ts";

let db: SqliteDb;
let dataDir: string;
let turns: TurnStore;

const SESSION = "ses_nouva:web:dashboard:web-1";

const file = (over: Partial<TurnAttachment> = {}): TurnAttachment => ({
  name: "shot.png",
  mimeType: "image/png",
  kind: "image",
  bytes: 120,
  direction: "in",
  path: "/srv/nouride/.nouride/data/attachments/abc/2026-09-02/01-shot.png",
  ...over,
});

const begin = () =>
  turns.begin({
    sessionId: SESSION,
    agentId: "nouva",
    gatewayId: "web:dashboard",
    chatId: "web-1",
    prompt: "apa isi ini?",
  });

beforeEach(async () => {
  dataDir = tempDir("chat-files");
  db = await openAndMigrate(join(dataDir, "test.db"));
  turns = turnStore(db);
});

afterEach(() => {
  db.close();
  removePath(dataDir);
});

describe("what a client is told about a file", () => {
  test("where to fetch it, and never where it lives", () => {
    const id = turns.begin({
      sessionId: SESSION,
      agentId: "nouva",
      gatewayId: "web:dashboard",
      chatId: "web-1",
      prompt: "apa isi ini?",
      attachments: [file()],
    });

    const payload = toTurnPayload({ ...turns.get(id)!, steps: [] });
    const attachment = payload.attachments?.[0];

    // Addressed by position on the turn. That is the whole security design: a client cannot name a
    // file, so it cannot name one it was never shown.
    expect(attachment?.url).toBe(`turns/${id}/files/0`);
    // And the path is not in the payload at all — not renamed, not redacted, absent.
    expect(JSON.stringify(payload)).not.toContain("/srv/nouride");
    expect(JSON.stringify(payload)).not.toContain("path");
  });

  test("a file whose bytes were never saved has no url, rather than a broken one", () => {
    // A download that failed, or a file the retention sweep has taken. It is still part of the
    // conversation — something *was* sent — but a link that cannot work must not look like one.
    const id = turns.begin({
      sessionId: SESSION,
      agentId: "nouva",
      gatewayId: "web:dashboard",
      chatId: "web-1",
      prompt: "ini",
      attachments: [{ ...file(), path: undefined }],
    });

    const attachment = toTurnPayload({ ...turns.get(id)!, steps: [] }).attachments?.[0];
    expect(attachment?.name).toBe("shot.png");
    expect(attachment?.url).toBeUndefined();
  });

  test("direction travels with it, because the two are drawn in different places", () => {
    const id = begin();
    turns.addAttachment(id, file({ name: "report.pdf", mimeType: "application/pdf", direction: "out" }));

    const attachments = toTurnPayload({ ...turns.get(id)!, steps: [] }).attachments ?? [];
    expect(attachments.map((a) => a.direction)).toEqual(["out"]);
  });
});

describe("collecting the files of a turn", () => {
  test("a sent file is appended without disturbing what arrived", () => {
    const id = turns.begin({
      sessionId: SESSION,
      agentId: "nouva",
      gatewayId: "web:dashboard",
      chatId: "web-1",
      prompt: "convert this",
      attachments: [file({ name: "input.png" })],
    });

    turns.addAttachment(id, file({ name: "output.pdf", direction: "out" }));
    turns.addAttachment(id, file({ name: "log.txt", direction: "out" }));

    const names = turns.get(id)?.attachments?.map((a) => `${a.direction}:${a.name}`);
    expect(names).toEqual(["in:input.png", "out:output.pdf", "out:log.txt"]);
  });

  test("the durable copies replace the upload paths", () => {
    // `begin` records the browser's upload, which lives a day. The intake then copies the file into
    // the agent's own directory, and that is what a transcript must point at a week later.
    const id = turns.begin({
      sessionId: SESSION,
      agentId: "nouva",
      gatewayId: "web:dashboard",
      chatId: "web-1",
      prompt: "ini",
      attachments: [file({ path: "/data/uploads/up_1-shot.png" })],
    });

    turns.setAttachments(id, [file({ path: "/data/attachments/abc/2026-09-02/01-shot.png" })]);

    expect(turns.get(id)?.attachments?.[0]?.path).toContain("/attachments/");
  });

  test("adding to a turn that does not exist is not an error", () => {
    // `send_file` can run in a chat with no turn recorded — a hook reply, a daemon that was restarted.
    // Losing the dashboard's copy must never turn a delivered file into a failure.
    expect(() => turns.addAttachment("turn_missing", file())).not.toThrow();
  });
});

describe("finding the turn a sent file belongs to", () => {
  test("is the running turn of that agent, in that chat", () => {
    const id = begin();
    expect(turns.runningFor("nouva", "web:dashboard", "web-1")).toBe(id);
  });

  test("is nobody else's", () => {
    begin();
    // Two agents can be working in one room. A file belongs to the one that sent it.
    expect(turns.runningFor("nox", "web:dashboard", "web-1")).toBeNull();
    expect(turns.runningFor("nouva", "discord:nox", "web-1")).toBeNull();
    expect(turns.runningFor("nouva", "web:dashboard", "web-2")).toBeNull();
  });

  test("and is nothing once the turn is over", () => {
    const id = begin();
    turns.finish(id, { status: "done", reply: "done" });
    expect(turns.runningFor("nouva", "web:dashboard", "web-1")).toBeNull();
  });
});

describe("how a file is served", () => {
  test("only types a browser renders without running anything go inline", async () => {
    const { rendersInline } = await import("@/modules/web/control/routes/chat.ts");

    for (const type of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/pdf",
      "text/plain",
      // Audio, so a voice note can be played where it stands rather than downloaded first.
      "audio/ogg",
      "audio/mpeg",
      // Video, for the same reason: a clip served as a download is a clip nobody watches, and
      // `<video>` cannot render bytes the daemon marked `attachment`.
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ]) {
      expect({ type, inline: rendersInline(type) }).toEqual({ type, inline: true });
    }
    // A charset does not change what the type is.
    expect(rendersInline("text/plain; charset=utf-8")).toBe(true);
    expect(rendersInline("IMAGE/PNG")).toBe(true);
  });

  test("everything that can carry script downloads instead", async () => {
    const { rendersInline } = await import("@/modules/web/control/routes/chat.ts");

    /**
     * SVG is the one worth naming. It is an image to a person and a script host to a browser, so
     * rendering one inline from the dashboard's own origin would run it with the dashboard's session.
     * The rest of this list is the same argument with fewer disguises.
     */
    for (const type of [
      "image/svg+xml",
      "text/html",
      "application/xhtml+xml",
      "application/javascript",
      "text/xml",
      "application/octet-stream",
      "",
      /**
       * Matroska is the deliberate omission among the video types, and it is not a security call —
       * no current browser plays it reliably. Marked `attachment`, the player errors and the UI falls
       * back to a file row that says what it is; marked `inline`, it would be a black rectangle.
       */
      "video/x-matroska",
    ]) {
      expect({ type, inline: rendersInline(type) }).toEqual({ type, inline: false });
    }
  });

  test("a filename cannot break out of the header it is put in", async () => {
    const { asciiName } = await import("@/modules/web/control/routes/chat.ts");

    // The name came from a browser or a chat platform. A quote or a newline in a header value changes
    // what the header means, which is a response-splitting bug rather than a cosmetic one.
    expect(asciiName('evil"; filename="x.html')).not.toContain('"');
    expect(asciiName("line\r\nX-Injected: 1")).not.toMatch(/[\r\n]/);
    expect(asciiName("laporan-final.pdf")).toBe("laporan-final.pdf");
    // And a name made entirely of stripped characters still names something.
    expect(asciiName("日本語")).toBe("___");
    expect(asciiName("   ")).toBe("file");
  });
});

/**
 * Range requests, which is what makes a video a video rather than a download.
 *
 * A `<video>` element does not fetch a file and play it. It asks for a slice, reads the container
 * header, then asks for more as somebody watches or drags the scrub bar — and Safari will not play at
 * all unless the first response proves the server understands that. Serving the whole body with a 200
 * is why a clip could sit in the transcript looking like a broken box.
 *
 * The arithmetic is the part that silently half-works: HTTP ranges are inclusive at *both* ends, so a
 * request for `bytes=0-0` is one byte, not zero. Get it wrong by one and the clip plays and will not
 * seek, which is a bug nobody reports precisely.
 */
describe("the byte window a range request asks for", () => {
  test("both ends are inclusive", async () => {
    const { parseRange } = await import("@/modules/web/control/routes/chat.ts");

    expect(parseRange("bytes=0-0", 1000)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
    expect(parseRange("bytes=500-999", 1000)).toEqual({ start: 500, end: 999 });
  });

  test("an open end means the rest of the file — the form Chrome opens with", async () => {
    const { parseRange } = await import("@/modules/web/control/routes/chat.ts");

    expect(parseRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
  });

  test("a suffix range means the LAST n bytes, not the first n", async () => {
    // The form that gets read wrong, and the one a player uses to find a trailing index atom.
    const { parseRange } = await import("@/modules/web/control/routes/chat.ts");

    expect(parseRange("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
    // Larger than the file is not an error — it means the whole thing.
    expect(parseRange("bytes=-4000", 1000)).toEqual({ start: 0, end: 999 });
  });

  test("an end past the file is clamped, not refused", async () => {
    // A player that guesses long is asking for "the rest"; refusing it would stall playback.
    const { parseRange } = await import("@/modules/web/control/routes/chat.ts");

    expect(parseRange("bytes=0-99999", 1000)).toEqual({ start: 0, end: 999 });
  });

  test("a start past the file is a 416, never a quiet full body", async () => {
    // The client has to be told the real size or it cannot correct itself. Answering 200 with the
    // whole file would have it treat the head as the tail it asked for.
    const { parseRange } = await import("@/modules/web/control/routes/chat.ts");

    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=5000-6000", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=800-700", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });

  test("an empty file can satisfy nothing", async () => {
    // Guarded explicitly: the arithmetic would otherwise produce an end of -1.
    const { parseRange } = await import("@/modules/web/control/routes/chat.ts");

    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-0", 0)).toBe("unsatisfiable");
  });

  test("no range, a malformed one, or several at once means send the whole file", async () => {
    /**
     * `null` is "ignore the header", which HTTP explicitly permits and every media element recovers
     * from. The multi-range form is in this list rather than implemented because no player sends one —
     * and answering it wrongly, with a single body where a multipart one was asked for, is worse than
     * not answering it at all.
     */
    const { parseRange } = await import("@/modules/web/control/routes/chat.ts");

    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("items=0-100", 1000)).toBeNull();
    expect(parseRange("bytes=abc-def", 1000)).toBeNull();
    expect(parseRange("bytes=0-99,200-299", 1000)).toBeNull();
  });
});

/**
 * The file route itself, mounted, with real bytes on disk.
 *
 * `parseRange` above decides the window; this is the wiring around it — the status code, the headers a
 * player reads, and whether the body is actually the slice that was asked for. Those are separable
 * bugs: an off-by-one in the *conversion* from an inclusive range to an exclusive slice lives here and
 * nowhere else, and it produces a clip that plays and will not seek.
 */
describe("serving the bytes", () => {
  /** 1000 bytes whose value is their own index mod 251 — so a wrong slice is obvious, not plausible. */
  const CONTENT = new Uint8Array(1000).map((_, i) => i % 251);

  const mount = async (over: Partial<TurnAttachment> = {}) => {
    const { Hono } = await import("hono");
    const { registerChatRoutes } = await import("@/modules/web/control/routes/chat.ts");

    const path = join(dataDir, "clip.mp4");
    writeFileSync(path, CONTENT);

    const id = begin();
    turns.setAttachments(id, [
      file({
        name: "clip.mp4",
        mimeType: "video/mp4",
        kind: "video",
        direction: "out",
        path,
        bytes: CONTENT.length,
        ...over,
      }),
    ]);

    // The command line's token, which opens every conversation: whose a conversation is, is `whose-doors.test.ts`.
    const app = new Hono<{ Variables: { principal: unknown } }>();
    app.use("*", async (c, next) => {
      c.set("principal", { kind: "token", actor: "cli", role: "admin" });
      await next();
    });
    registerChatRoutes(app as never, { turns, ctx: { config: { people: [] } } } as never);
    return { app, url: `/sessions/${SESSION}/turns/${id}/files/0` };
  };

  test("no range: the whole file, and a standing offer to ask for part of it", async () => {
    const { app, url } = await mount();
    const res = await app.request(url);

    expect(res.status).toBe(200);
    // The header Safari reads before it will play anything at all.
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("1000");
    // Inline, or `<video>` gets bytes the browser was told to save rather than render.
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CONTENT);
  });

  test("a range: 206, the true total, and exactly the bytes asked for", async () => {
    const { app, url } = await mount();
    const res = await app.request(url, { headers: { range: "bytes=100-199" } });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    // 100 inclusive to 199 inclusive is 100 bytes. 99 here is the off-by-one that breaks seeking.
    expect(res.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CONTENT.slice(100, 200));
  });

  test("the last byte is reachable", async () => {
    // The end of the file is where a player looks for the index of an MP4 written in one pass.
    const { app, url } = await mount();
    const res = await app.request(url, { headers: { range: "bytes=999-999" } });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 999-999/1000");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CONTENT.slice(999));
  });

  test("a range past the end is refused with the size, not answered with the file", async () => {
    const { app, url } = await mount();
    const res = await app.request(url, { headers: { range: "bytes=2000-3000" } });

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
  });

  test("a type that cannot be rendered safely still downloads", async () => {
    // The security rule this route exists to enforce does not get a hole cut in it for media.
    const { app, url } = await mount({ name: "x.svg", mimeType: "image/svg+xml", kind: "image" });
    const res = await app.request(url);

    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  test("a file that is gone says so, rather than serving an empty body", async () => {
    const { app, url } = await mount({ path: join(dataDir, "swept.mp4") });
    const res = await app.request(url);

    expect(res.status).toBe(410);
  });
});
