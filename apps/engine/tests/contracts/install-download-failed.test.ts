/**
 * `install.sh` says a download that failed is one that failed (0.8.24, item 17). A 504 from GitHub while fetching a
 * release's checksum file was reported as "the release has no SHA256SUMS; refusing to install what nothing vouches
 * for", which reads as an unsigned release. The refusal stays; its words name what went wrong and say to try again,
 * and only a file that is not there (a 404) is said to be missing. The functions are taken from the script as written
 * and run by `sh` against a stand-in server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, serveHttp, type HttpServer } from "@nouride/runtime";

const INSTALL = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
const FETCH = INSTALL.slice(INSTALL.indexOf("# >>> downloads\n"), INSTALL.indexOf("# <<< downloads"));
/** As the script runs them: `set -eu`, its own `warn` and `die`, and no pause between tries. */
const PRELUDE = 'set -eu\nwarn() { echo "WARN: $*" >&2; }\ndie() { echo "DIE: $*"; exit 1; }\n';
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", NOURIDE_FETCH_WAITS: "0 0 0 0" };
const NAMES = INSTALL.slice(INSTALL.indexOf("# >>> checksum names\n"), INSTALL.indexOf("# <<< checksum names"));

let server: HttpServer;
let base = "";
let stage = "";

beforeAll(() => {
  // Each release directory answers its checksum file one way: GitHub failing for a moment, a release without one, one
  // that has it, and a newest release whose CHECKSUMS failed (so it must not fall back to the old name).
  const answers: Record<string, number> = { "/v0.8.24/CHECKSUMS": 504, "/v0.8.23/CHECKSUMS": 404, "/v0.8.22/CHECKSUMS": 200, "/latest/CHECKSUMS": 502, "/latest/SHA256SUMS": 200 };
  server = serveHttp({ port: 0, hostname: "127.0.0.1", fetch: (request: Request) => {
    const status = answers[new URL(request.url).pathname] ?? 404;
    return new Response(status === 200 ? "abc  nouride.tar.gz\n" : `status ${status}`, { status });
  } });
  base = `http://127.0.0.1:${server.port}`;
  stage = mkdtempSync(join(tmpdir(), "nouride-install-dl-"));
});
afterAll(() => {
  server.stop(true);
  rmSync(stage, { recursive: true, force: true });
});

async function sums(tag: string): Promise<{ code: number; said: string; files: string[] }> {
  const dir = join(stage, tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const script = `${PRELUDE}${FETCH}\n${NAMES}\nfetch_sums "${base}/${tag}" "${tag === "latest" ? "latest" : tag}" "" "${dir}" && echo "SUMS=$SUMS"`;
  const out = await runCommand(["sh", "-c", script], { cwd: stage, env: ENV, timeoutMs: 15_000, maxOutputBytes: 65_536 });
  return { code: out.exitCode ?? -1, said: `${out.stdout}${out.stderr}`.trim(), files: readdirSync(dir) };
}

describe("a release's checksum file, fetched", () => {
  test("a 504 is a download that failed: its status named, try again, nothing left behind", async () => {
    const { code, said, files } = await sums("v0.8.24");
    expect(code).toBe(1);
    expect(said).toContain("DIE: could not download CHECKSUMS (HTTP 504, 5 tries), so nothing was installed. The connection or GitHub failed for a moment: run the same command again in a few minutes");
    expect(said).not.toContain("refusing to install what nothing vouches for");
    // The error page the server sent is not left where the checksum file would be.
    expect(files).toEqual([]);
  });

  test("a 404 is a release without one: refused as before", async () => {
    const { code, said } = await sums("v0.8.23");
    expect(code).toBe(1);
    expect(said).toBe("DIE: the release has no CHECKSUMS; refusing to install what nothing vouches for");
  });

  test("one that is there is taken", async () => {
    const { code, said, files } = await sums("v0.8.22");
    expect({ code, said, files }).toEqual({ code: 0, said: "SUMS=CHECKSUMS", files: ["CHECKSUMS"] });
  });

  test("for the newest release, a CHECKSUMS that failed is not read as an old release that has SHA256SUMS instead", async () => {
    const { code, said } = await sums("latest");
    expect(code).toBe(1);
    expect(said).toContain("could not download CHECKSUMS (HTTP 502, 5 tries)");
  });

  test("and nothing answering at all says so", async () => {
    const dir = join(stage, "down");
    mkdirSync(dir, { recursive: true });
    const script = `${PRELUDE}${FETCH}\n${NAMES}\nfetch_sums "http://127.0.0.1:9/v0.8.24" "v0.8.24" "" "${dir}"`;
    const out = await runCommand(["sh", "-c", script], { cwd: stage, env: ENV, timeoutMs: 15_000, maxOutputBytes: 65_536 });
    expect(`${out.stdout}${out.stderr}`.trim()).toContain("could not download CHECKSUMS (no answer, 5 tries)");
  });
});
