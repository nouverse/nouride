/**
 * A preview of HTML an agent wrote (`web/control/routes/preview.ts`): an `html` block of a reply, or an `.html` file,
 * served as a page under a policy of its own.
 *
 * It is somebody else's page on the dashboard's own address, so what is held here is everything a request could do to
 * get something else served, or served to somebody else: any part of a reply that is not an `html` block, a turn of a
 * conversation the reader may not open, a file that is no page or is outside Nouride's files, and HTML the request
 * itself carries. And the policy: nothing of the dashboard's own is allowed to the page, in a frame or in a tab. That
 * a browser then holds a page to it is seen in a real one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { asPage, htmlBlockAt, htmlRunAt, registerPreviewRoutes } from "@/modules/web/control/routes/preview.ts";
import { parseConfig } from "@/modules/config/global/index.ts";
import { bindWebServer, headersFor, PREVIEW_SECURITY_HEADERS, SECURITY_HEADERS, type WebServer } from "@/modules/web/server.ts";

const PAGE = '<!doctype html>\n<h1>Menu</h1>\n<script>document.title = "ran"</script>';
const REPLY = ["Here is the mockup:", "", "```html", PAGE, "```", "", "And the script alone:", "", "```js", 'fetch("/api/control/status")', "```", "", "Tell me what to change."].join("\n");
const at = (reply: string, words: string) => reply.indexOf(words);

describe("the words of an html block, by where they are in a reply", () => {
  test("the block's own words, from the line after its fence to the line before its end", () => {
    expect(htmlBlockAt(REPLY, at(REPLY, PAGE), PAGE.length)).toBe(PAGE);
  });

  test("a fence that says more than its language, one of tildes, a longer one and an indented one are fences too", () => {
    for (const [open, close] of [["```html title=menu", "```"], ["~~~HTML", "~~~"], ["````html", "````"], ["  ```html", "  ```"], ["``` html", "```"]] as const) {
      const reply = `Look:\n${open}\n${PAGE}\n${close}\nDone.`;
      expect(htmlBlockAt(reply, at(reply, PAGE), PAGE.length), open).toBe(PAGE);
    }
    // At the reply's very start and its very end.
    const whole = `\`\`\`html\n${PAGE}\n\`\`\``;
    expect(htmlBlockAt(whole, at(whole, PAGE), PAGE.length)).toBe(PAGE);
  });

  test("no other part of a reply is a page: its prose, a block in another language, part of a block, or more than one", () => {
    const js = 'fetch("/api/control/status")';
    for (const [from, length, why] of [
      [at(REPLY, "Here is"), 19, "prose"],
      [at(REPLY, js), js.length, "a js block"],
      [at(REPLY, PAGE), PAGE.length - 9, "a block cut short"],
      [at(REPLY, PAGE) + 5, PAGE.length - 5, "a block entered in its middle"],
      [at(REPLY, PAGE), REPLY.length - at(REPLY, PAGE), "past the block's end"],
      [at(REPLY, PAGE) - 8, PAGE.length + 8, "from its fence"],
    ] as const) {
      expect(htmlBlockAt(REPLY, from, length), why).toBeNull();
    }
  });

  test("a fence closed by another kind of fence, or by a shorter one, is not closed", () => {
    for (const [open, close] of [["```html", "~~~"], ["````html", "```"]] as const) {
      const reply = `${open}\n${PAGE}\n${close}\n`;
      expect(htmlBlockAt(reply, at(reply, PAGE), PAGE.length), open).toBeNull();
    }
    // A language that only begins with it is another language.
    const other = `\`\`\`htmlbars\n${PAGE}\n\`\`\``;
    expect(htmlBlockAt(other, at(other, PAGE), PAGE.length)).toBeNull();
  });

  test("a place counted back from the reply's end is nowhere, though a block is there", () => {
    const reply = "```html\nABCDE\n```";
    expect(htmlBlockAt(reply, 8, 5)).toBe("ABCDE");
    expect(htmlBlockAt(reply, -9, 5)).toBeNull();
  });

  test("a place that is not one is nowhere: outside the reply, nothing long, or not a whole number", () => {
    const start = at(REPLY, PAGE);
    for (const [from, length] of [[-1, 5], [start, 0], [start, -3], [REPLY.length, 1], [start, REPLY.length], [Number.NaN, PAGE.length], [start, Number.NaN], [start + 0.5, PAGE.length], [start, 1.5]] as const) {
      expect(htmlBlockAt(REPLY, from, length), `${from},${length}`).toBeNull();
    }
  });
});

// As an agent asked to "write some html here" wrote it: lines of tags between its prose, with no fence around them.
const CARD = ['<div style="padding:16px">', "  <h3>Render test</h3>", "</div>"].join("\n");
const RUN = [CARD, "", "<table><tr><td>a cell</td></tr></table>", "", "<script>document.title = 'ran'</script>"].join("\n");
const RAW = ["Here it is, raw:", "", RUN, "", "What to check:", "- **The card**: whether its colours show.", "", "```js", "<div>in a block</div>", "```"].join("\n");

describe("the words of html written with no fence, by where they are in a reply", () => {
  test("the run's own lines, its pieces with a blank line between them one page", () => {
    expect(htmlRunAt(RAW, at(RAW, RUN), RUN.length)).toBe(RUN);
    // An html block is not one, and a run is no html block: each is found by its own rule.
    expect(htmlBlockAt(RAW, at(RAW, RUN), RUN.length)).toBeNull();
    expect(htmlRunAt(REPLY, at(REPLY, PAGE), PAGE.length)).toBeNull();
  });

  test("no other part of the reply: its prose, the run with the prose after it, a run entered inside a line, what a code block holds", () => {
    const boxed = "<div>in a block</div>";
    for (const [from, length, why] of [
      [at(RAW, "Here it is"), 16, "prose"],
      [at(RAW, "What to check"), 14, "prose after it"],
      [at(RAW, RUN), RUN.length + "\n\nWhat to check:".length, "the run with the prose after it"],
      [at(RAW, RUN) + 1, RUN.length - 1, "entered inside its first line"],
      [at(RAW, RUN), RUN.length - 4, "left inside its last line"],
      [at(RAW, boxed), boxed.length, "what a js block holds"],
      [0, RAW.length, "the whole reply"],
      [Number.NaN, RUN.length, "no place"],
    ] as const) {
      expect(htmlRunAt(RAW, from, length), why).toBeNull();
    }
  });
});

/** What the daemon adds after a page's own words: the lines by which the page says its height to the frame around it. */
const SAYS_ITS_HEIGHT = /\n<script>\(function\(\)\{if\(parent===window\)return;[^<]*<\/script>$/;
/** A served page with that taken off: the page's own words, with the doctype one given to a page's inside. */
const words = (served: string) => served.replace(SAYS_ITS_HEIGHT, "");

describe("a page as it is served", () => {
  test("its words as they are stored, then the lines by which it says its height, which reach nothing", () => {
    const served = asPage(PAGE);
    expect(served.startsWith(PAGE)).toBe(true);
    const added = served.slice(PAGE.length);
    expect(added).toMatch(SAYS_ITS_HEIGHT);
    // One script, after everything the page wrote: it says a number to the frame around it and nothing else.
    expect(added.match(/<script>/g)).toHaveLength(1);
    expect(added).toContain("parent.postMessage({nouridePreviewHeight:");
    // In a tab of its own there is no frame to tell.
    expect(added).toContain("if(parent===window)return;");
    expect(added).not.toMatch(/fetch|XMLHttpRequest|WebSocket|src=|href=|import|cookie|localStorage|location/);
    expect(words(served)).toBe(PAGE);
  });

  test("words that are a page's inside are given a doctype, and a whole page keeps its own beginning", () => {
    expect(words(asPage("<div>a card</div>"))).toBe("<!doctype html>\n<div>a card</div>");
    for (const whole of ["<!doctype html><p>a</p>", "<!DOCTYPE html>\n<html></html>", "  <html lang=en><body>a</body></html>", "\n<!doctype html>", "<html>"]) {
      expect(words(asPage(whole)), whole).toBe(whole);
    }
    // A tag that only begins like one is a page's inside.
    expect(words(asPage("<htmlx>"))).toBe("<!doctype html>\n<htmlx>");
  });
});

// ── the routes ────────────────────────────────────────────────────────────────────────────────────────────────────

let top: string;
let root: string;
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const KEY = "sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0";

beforeAll(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), "nr-preview-")));
  root = join(top, ".nouride");
  put("config.toml", "");
  put("workspace/private/nix/menu.html", PAGE);
  put("workspace/private/nix/MENU.HTM", "<p>old</p>");
  put("workspace/private/nix/keyed.html", `<p>the key is ${KEY}</p>`);
  put("workspace/private/nix/notes.md", "# not a page\n<script>1</script>");
  put("workspace/private/nix/big.html", "x".repeat(2 * 1024 * 1024 + 1));
  put("data/.control-token", "<p>token</p>");
  writeFileSync(join(top, "outside.html"), "<p>not Nouride's</p>");
});
afterAll(() => rmSync(top, { recursive: true, force: true }));

const TURNS: Record<string, { id: string; sessionId: string; reply?: string }> = {
  turn_mine: { id: "turn_mine", sessionId: "ses_nix:web:dashboard:mine", reply: REPLY },
  turn_theirs: { id: "turn_theirs", sessionId: "ses_nix:web:dashboard:theirs", reply: REPLY },
  turn_big: { id: "turn_big", sessionId: "ses_nix:web:dashboard:mine", reply: `\`\`\`html\n${"x".repeat(2 * 1024 * 1024 + 1)}\n\`\`\`` },
  turn_silent: { id: "turn_silent", sessionId: "ses_nix:web:dashboard:mine" },
  turn_raw: { id: "turn_raw", sessionId: "ses_nix:web:dashboard:mine", reply: RAW },
};
/** Each conversation, and the account that opened it. */
const OPENED: Record<string, string> = { "ses_nix:web:dashboard:mine": "web:u-viewer", "ses_nix:web:dashboard:theirs": "web:u-other" };

function app(role: "admin" | "viewer") {
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: role, role, user: { id: `u-${role}`, username: role } });
    await next();
  });
  registerPreviewRoutes(control as never, {
    turns: { get: (id: string) => TURNS[id] ?? null, latestForSession: () => null },
    sessions: { find: (id: string) => (OPENED[id] ? { agentId: "nix", gatewayId: "web:dashboard", chatId: id.split(":").at(-1), openedBy: OPENED[id], startedAt: 1 } : null) },
    secrets: { knownValues: () => ({ OPENAI: KEY }) },
    ctx: { configSource: join(root, "config.toml"), config: { people: [], daemon: { dataDir: join(root, "data") } } },
  } as never);
  return (path: string) => control.request(path);
}
const block = (turn: string, reply = REPLY, more = "") => `/preview/turn/${turn}?at=${at(reply, PAGE)}&length=${PAGE.length}${more}`;

describe("GET /preview/turn/:id", () => {
  test("serves the block as the page it is, read from the stored reply, and kept by no cache", async () => {
    const answer = await app("admin")(block("turn_mine"));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answer.headers.get("cache-control")).toBe("private, no-store");
    const served = await answer.text();
    expect(words(served)).toBe(PAGE);
    // With the lines that say its height: in a chat it is drawn in the reply, in a frame as tall as the page.
    expect(served).toMatch(SAYS_ITS_HEIGHT);
  });

  test("serves html written with no fence as the page it is, and nothing else of that reply", async () => {
    const admin = app("admin");
    const answer = await admin(`/preview/turn/turn_raw?at=${at(RAW, RUN)}&length=${RUN.length}`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // A run is a page's inside: served with the doctype a page begins with.
    expect(words(await answer.text())).toBe(`<!doctype html>\n${RUN}`);
    for (const path of [`/preview/turn/turn_raw?at=0&length=16`, `/preview/turn/turn_raw?at=${at(RAW, "<div>in a block")}&length=21`, `/preview/turn/turn_raw?at=0&length=${RAW.length}`]) {
      expect((await admin(path)).status, path).toBe(404);
    }
  });

  test("what the request carries is never served: only where the block is", async () => {
    const answer = await app("admin")(block("turn_mine", REPLY, `&html=${encodeURIComponent("<script>top.location='https://example.com'</script>")}&reply=x`));
    const served = await answer.text();
    expect(words(served)).toBe(PAGE);
    expect(served).not.toContain("example.com");
  });

  test("a place in the reply that is not an html block, no place at all, a turn with no reply and no such turn are not there", async () => {
    const admin = app("admin");
    for (const path of [`/preview/turn/turn_mine?at=${at(REPLY, "Here is")}&length=19`, "/preview/turn/turn_mine", "/preview/turn/turn_mine?at=abc&length=5", block("turn_silent"), block("turn_gone")]) {
      const answer = await admin(path);
      expect(answer.status, path).toBe(404);
      expect(await answer.text(), path).not.toContain("<h1>Menu</h1>");
    }
  });

  test("is read by whoever may open the turn's conversation: their own, and nobody else's", async () => {
    const viewer = app("viewer");
    expect((await viewer(block("turn_mine"))).status).toBe(200);
    const refused = await viewer(block("turn_theirs"));
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain("<h1>Menu</h1>");
    // An admin reads every conversation, as on every page.
    expect((await app("admin")(block("turn_theirs"))).status).toBe(200);
  });

  test("a block too large to read whole is refused, in words", async () => {
    const reply = TURNS.turn_big!.reply!;
    const answer = await app("admin")(`/preview/turn/turn_big?at=8&length=${reply.length - 12}`);
    expect(answer.status).toBe(413);
    expect(await answer.text()).toContain("too large to preview");
  });
});

describe("GET /preview/file", () => {
  const file = (path: string) => `/preview/file?path=${encodeURIComponent(path)}`;

  test("serves an .html file of Nouride's files as the page it is", async () => {
    const answer = await app("admin")(file("workspace/private/nix/menu.html"));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(words(await answer.text())).toBe(PAGE);
    expect(words(await (await app("admin")(file("workspace/private/nix/MENU.HTM"))).text())).toBe("<!doctype html>\n<p>old</p>");
  });

  test("is an admin's, as every route of the files is", async () => {
    const refused = await app("viewer")(file("workspace/private/nix/menu.html"));
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("<h1>Menu</h1>");
  });

  test("a credential written into the page is hidden, as where the file is read", async () => {
    const page = await (await app("admin")(file("workspace/private/nix/keyed.html"))).text();
    expect(page).not.toContain(KEY);
    expect(page).toContain("<p>the key is ");
  });

  test("a file that is no page, one outside Nouride's files, one kept private, a folder and no path are not there", async () => {
    const admin = app("admin");
    for (const path of ["workspace/private/nix/notes.md", "../outside.html", join(top, "outside.html"), "data/.control-token", "workspace/private/nix", "workspace/private/nix/gone.html", ""]) {
      const answer = await admin(file(path));
      expect(answer.status, path).toBe(404);
      expect(await answer.text(), path).not.toMatch(/token|not Nouride's|<script>/);
    }
  });

  test("a page too large to read whole is refused, in words", async () => {
    const answer = await app("admin")(file("workspace/private/nix/big.html"));
    expect(answer.status).toBe(413);
    expect(await answer.text()).toContain("too large to preview");
  });
});

describe("the policy a preview answers under", () => {
  const policy = PREVIEW_SECURITY_HEADERS["Content-Security-Policy"]!;
  const rules = Object.fromEntries(policy.split("; ").map((rule) => [rule.split(" ")[0]!, rule.split(" ").slice(1)]));

  test("it is nobody: scripts may run, with no origin of its own, in a frame and in a tab alike", () => {
    expect(rules.sandbox).toEqual(["allow-scripts"]);
    // The words that would give it one back, or let it out.
    expect(policy).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads/);
  });

  test("it reaches nothing: no request leaves it, not to the daemon and not to the web", () => {
    expect(rules["default-src"]).toEqual(["'none'"]);
    expect(rules["connect-src"]).toEqual(["'none'"]);
    expect(rules["form-action"]).toEqual(["'none'"]);
    expect(rules["base-uri"]).toEqual(["'none'"]);
    // Nothing is allowed from the dashboard's own address, and nothing from any other.
    expect(policy.split("; ").filter((rule) => !rule.startsWith("frame-ancestors")).join("; ")).not.toContain("'self'");
    expect(policy).not.toMatch(/https?:|\*|blob:/);
    // What it shows is what is written in it.
    expect(rules["script-src"]).toEqual(["'unsafe-inline'"]);
    expect(rules["style-src"]).toEqual(["'unsafe-inline'"]);
    expect(rules["img-src"]).toEqual(["data:"]);
  });

  test("only the dashboard may frame it, and it is read as the type it is sent as", () => {
    expect(rules["frame-ancestors"]).toEqual(["'self'"]);
    expect(PREVIEW_SECURITY_HEADERS["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(PREVIEW_SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(PREVIEW_SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });

  test("every answer of the preview's routes is under it, a refusal too, and nothing else is", () => {
    for (const path of ["/api/control/preview/turn/turn_1", "/api/control/preview/file", "/api/control/preview"]) expect(headersFor(path), path).toBe(PREVIEW_SECURITY_HEADERS);
    for (const path of ["/api/control/previews", "/api/control/system/files/read", "/dashboard/", "/api/control/turns/turn_1", "/preview/file"]) expect(headersFor(path), path).toBe(SECURITY_HEADERS);
    // The dashboard's own pages may not be framed by anything, the preview among them.
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });
});

/** What an answer really carries, through the server every request goes through. */
describe("the policy a preview is served with", () => {
  let web: WebServer | undefined;
  afterAll(async () => {
    await web?.server.stop(true);
  });

  test("a preview's answer carries the preview's policy over whatever the route set, and the routes beside it the dashboard's", async () => {
    const config = parseConfig({});
    config.dashboard.host = "127.0.0.1";
    config.dashboard.port = 0;
    web = bindWebServer(config, Date.now(), { phase: "ready" });
    web.serve(
      { config, db: { walSizeBytes: () => 0 }, gateways: new Map(), startedAt: Date.now(), configSource: null, status: "ready", agentCount: 0, providerErrors: new Map(), backgroundTimers: [] } as never,
      {
        mountControl: (app) => {
          // A page that asks for a looser policy of its own: the server's is what goes out.
          app.get("/api/control/preview/turn/turn_1", (c) => c.body("<script>1</script>", 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src *" }));
          app.get("/api/control/turns/turn_1", (c) => c.json({}));
        },
      },
    );
    const answer = (path: string) => fetch(`http://127.0.0.1:${web!.server.port}${path}`, { redirect: "manual" });
    const page = await answer("/api/control/preview/turn/turn_1?at=1&length=2");
    expect(page.headers.get("content-security-policy")).toBe(PREVIEW_SECURITY_HEADERS["Content-Security-Policy"]!);
    expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    // Still the type the route sent it as: the headers are set on the answer, not on a new one.
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const beside = await answer("/api/control/turns/turn_1");
    expect(beside.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]!);
    expect(beside.headers.get("x-frame-options")).toBe("DENY");
  });
});
