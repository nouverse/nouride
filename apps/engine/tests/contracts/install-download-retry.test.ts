/**
 * `install.sh` tries a download again, and goes on with the tarball from what it already has. Two phones running
 * Nouride Home failed every first start at the tarball's download (57 MB, on a home Wi-Fi): one try, no going on, no
 * limit on a stalled transfer, and the failure told them to build a release of their own. The functions are taken from
 * the script as written and run by `sh -eu`, as the script runs, against a stand-in server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, serveHttp, type HttpServer } from "@nouride/runtime";

const INSTALL = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
const FETCH = INSTALL.slice(INSTALL.indexOf("# >>> downloads\n"), INSTALL.indexOf("# <<< downloads"));
const PRELUDE = 'set -eu\nwarn() { echo "WARN: $*" >&2; }\ndie() { echo "DIE: $*"; exit 1; }\n';

/** A tarball's worth of bytes, big enough that half of it is a real partial file. */
const BODY = new Uint8Array(512 * 1024).map((_, i) => (i * 31 + 7) % 251);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let server: HttpServer;
let raw: Server;
let base = "";
let rawBase = "";
let stage = "";
const asked: Record<string, string[]> = {};

beforeAll(async () => {
  server = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request: Request) => {
      const path = new URL(request.url).pathname;
      const range = request.headers.get("range") ?? "";
      (asked[path] ??= []).push(range);
      const tries = asked[path]!.length;
      // GitHub failing for a moment: two 500s, then the file.
      if (path === "/flaky") return tries <= 2 ? new Response("busy", { status: 500 }) : new Response(BODY);
      // Always failing, and a file that is not there.
      if (path === "/dead") return new Response("gateway timeout", { status: 504 });
      if (path === "/gone") return new Response("not found", { status: 404 });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  // A connection that drops midway the first time, then a server that goes on from where the client asks. Raw TCP, so
  // the drop is a real one: the length promises every byte, half comes, and the socket closes.
  raw = createServer((socket) => {
    socket.once("data", (data) => {
      const head = data.toString("latin1");
      const range = /^range: *(.*)$/im.exec(head)?.[1]?.trim() ?? "";
      (asked["/cut"] ??= []).push(range);
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      if (from > 0) {
        socket.end(Buffer.concat([
          Buffer.from(`HTTP/1.1 206 Partial Content\r\nContent-Length: ${BODY.length - from}\r\nContent-Range: bytes ${from}-${BODY.length - 1}/${BODY.length}\r\nConnection: close\r\n\r\n`),
          Buffer.from(BODY.slice(from)),
        ]));
        return;
      }
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${BODY.length}\r\nConnection: close\r\n\r\n`);
      socket.write(Buffer.from(BODY.slice(0, BODY.length / 2)), () => socket.destroy());
    });
  });
  await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
  const address = raw.address();
  rawBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => {
  server.stop(true);
  raw.close();
});
beforeEach(() => {
  for (const key of Object.keys(asked)) delete asked[key];
  stage = mkdtempSync(join(tmpdir(), "nouride-install-retry-"));
});
afterEach(() => rmSync(stage, { recursive: true, force: true }));

async function fetchStatus(path: string, resume = false, from = base): Promise<{ code: number; said: string; warned: string; file: string }> {
  const file = join(stage, "download");
  const script = `${PRELUDE}${FETCH}\nfetch_status "${from}${path}" "${file}"${resume ? " resume" : ""}`;
  const out = await runCommand(["sh", "-c", script], {
    cwd: stage,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NOURIDE_FETCH_WAITS: "0 0 0 0" },
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
  });
  return { code: out.exitCode ?? -1, said: out.stdout.trim(), warned: out.stderr.trim(), file };
}

describe("install.sh's downloads", () => {
  test("two 500s, then the file: it is taken on the third try, each failed try said on one line", async () => {
    const run = await fetchStatus("/flaky");
    expect(run.code).toBe(0);
    expect(run.said).toBe("ok");
    expect(asked["/flaky"]).toHaveLength(3);
    expect(run.warned.split("\n").filter((line) => line.startsWith("WARN: download try"))).toHaveLength(2);
    expect(sha(readFileSync(run.file))).toBe(sha(BODY));
  });

  test("the tarball's connection dropped midway: the next try goes on from what came, and the file is whole", async () => {
    const run = await fetchStatus("/cut", true, rawBase);
    expect(run.code).toBe(0);
    expect(asked["/cut"]![0]).toBe("");
    expect(asked["/cut"]!.slice(1).some((range) => /^bytes=[1-9]\d*-$/.test(range))).toBe(true);
    // What the checksum is taken of: every byte, in order, once.
    expect(sha(readFileSync(run.file))).toBe(sha(BODY));
  });

  test("a server that keeps failing: five tries, and the last failure says how many", async () => {
    const run = await fetchStatus("/dead");
    expect(run.code).toBe(1);
    expect(run.said).toBe("HTTP 504, 5 tries");
    expect(asked["/dead"]).toHaveLength(5);
    expect(existsSync(run.file)).toBe(false);
  });

  test("a file that is not there is an answer: one try, missing", async () => {
    const run = await fetchStatus("/gone", true);
    expect(run.code).toBe(1);
    expect(run.said).toBe("missing");
    expect(asked["/gone"]).toHaveLength(1);
  });
});

describe("install.sh's tarball download", () => {
  test("goes through the retrying download with resume, and a failure names the address and what went wrong", () => {
    expect(INSTALL).toContain('if ! dl_how="$(fetch_status "$url" "$STAGE/nouride.tar.gz" resume)"; then');
    expect(INSTALL).toContain('[ "$dl_how" = "missing" ] && die "there is no ${ARTIFACT}.tar.gz at $url: $dl_hint"');
    expect(INSTALL).toContain('fetch_failed "$url" "$dl_how"');
    expect(INSTALL).not.toContain('|| die "download failed: $dl_hint"');
  });
});
