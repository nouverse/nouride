/**
 * One request over a Unix socket, the way `nouride-pkg` answers: read a line, write, close.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSocketFile, requestUnixSocket, UnixSocketError } from "../src/unix-socket.ts";
import { eventually } from "./wait.ts";

let dir = "";
let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A server that answers each connection's first line with `answer(line)`, then closes. */
function serve(answer: (line: string) => string[] | null): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), "nr-sock-"));
  const path = join(dir, "s.sock");
  server = createServer((socket) => {
    let got = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      got += chunk;
      if (!got.includes("\n")) return;
      const lines = answer(got.slice(0, got.indexOf("\n")));
      if (lines === null) return; // never answers
      for (const line of lines) socket.write(`${line}\n`);
      socket.end();
    });
  });
  return new Promise((resolve) => server!.listen(path, () => resolve(path)));
}

describe("requestUnixSocket", () => {
  test("sends one line and returns the whole answer, streaming it as it comes", async () => {
    const path = await serve((line) => [`you said ${line}`, "@done"]);
    const seen: string[] = [];
    const answer = await requestUnixSocket(path, "status", { timeoutMs: 5_000, onData: (chunk) => seen.push(chunk) });
    expect(answer).toBe("you said status\n@done\n");
    expect(seen.join("")).toBe(answer);
  });

  test("names the failure: missing, denied, timeout", async () => {
    const path = await serve(() => null);
    const failure = (p: string, ms = 5_000) =>
      requestUnixSocket(p, "status", { timeoutMs: ms }).then(
        () => "answered",
        (err: unknown) => (err instanceof UnixSocketError ? err.failure : "not named"),
      );

    expect(await failure(join(dir, "absent.sock"))).toBe("missing");
    expect(await failure(path, 200)).toBe("timeout");

    // A socket this user may not open. Root opens anything, so the case is only real for others.
    if (process.getuid?.() !== 0) {
      chmodSync(path, 0o000);
      expect(await failure(path)).toBe("denied");
    }
  });
});

/**
 * What the 0.7.11 mutation sweep found no test above holding: the two other ways a socket is missing or refuses, the
 * error's name, an answer that arrives in pieces — split inside a character, even — and what is left behind when the
 * request ends: the timer, and on a timeout the connection itself.
 */
describe("requestUnixSocket, edge by edge", () => {
  const failure = (p: string, ms = 5_000) =>
    requestUnixSocket(p, "status", { timeoutMs: ms }).then(
      () => "answered",
      (err: unknown) => (err instanceof UnixSocketError ? `${err.name}:${err.failure}` : "not named"),
    );

  test("a socket nobody listens on is refused", async () => {
    dir = mkdtempSync(join(tmpdir(), "nr-sock-"));
    // A listener killed outright leaves its socket file behind, with nothing on the other end.
    const path = join(dir, "dead.sock");
    const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`]);
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(await failure(path)).toBe("UnixSocketError:refused");
  });

  test("a timeout says how long it waited, in seconds, and closes the connection it gave up on", async () => {
    let closed = false;
    const path = await serve(() => null);
    server!.on("connection", (socket) => socket.on("close", () => (closed = true)));
    await expect(requestUnixSocket(path, "status", { timeoutMs: 500 })).rejects.toThrow("within 1s");
    await expect(requestUnixSocket(path, "status", { timeoutMs: 1_499 })).rejects.toThrow("within 1s");
    await eventually(() => closed, 2_000, "the connection it gave up on to close");
  });

  test("an answer in pieces is joined as it came, a character split across them included, and the timer is cleared", async () => {
    dir = mkdtempSync(join(tmpdir(), "nr-sock-"));
    const path = join(dir, "s.sock");
    let received = "";
    const e = Buffer.from("é");
    server = createServer((socket) => {
      socket.on("data", (chunk) => {
        received += chunk.toString();
        socket.write(Buffer.concat([Buffer.from("one\n"), e.subarray(0, 1)]));
        setTimeout(() => socket.end(Buffer.concat([e.subarray(1), Buffer.from("\ntwo\n")])), 30);
      });
    });
    await new Promise<void>((resolve) => server!.listen(path, () => resolve()));
    const clear = spyOn(globalThis, "clearTimeout");
    const answer = await requestUnixSocket(path, "status\n", { timeoutMs: 5_000 });
    expect(answer).toBe("one\né\ntwo\n");
    // A request that already ends in a newline is sent as it is, not with a second one.
    expect(received).toBe("status\n");
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

describe("isSocketFile", () => {
  test("a socket, and not a file of the same name", async () => {
    const path = await serve(() => []);
    writeFileSync(join(dir, "plain"), "");
    expect(isSocketFile(path)).toBe(true);
    expect(isSocketFile(join(dir, "plain"))).toBe(false);
    expect(isSocketFile(join(dir, "absent"))).toBe(false);
  });
});
