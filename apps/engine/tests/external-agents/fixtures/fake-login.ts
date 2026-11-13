/**
 * A CLI's sign-in, for the external-agent login tests: it says where it runs and which profile it signs in, prints a
 * link as a device flow does, and asks for a code — `CODE123` signs in (exit 0), anything else does not (exit 3).
 *
 * With `--returns`, a browser sign-in instead: its link's `redirect_uri` is a page on 127.0.0.1 it waits on, and that page
 * opened with `code=OK` signs it in.
 *
 * With `--paste`, it reads its terminal key by key, as a terminal UI does, and takes a burst of characters as a paste:
 * an Enter that arrives with them is part of what was pasted, and only an Enter by itself sends the field. What Claude
 * Code's `setup-token` does with a code and an Enter written together.
 */

import { createServer } from "node:http";

// Killed, it ends 0, as `script(1)` on Linux does when what it runs is: a stop must never read as a sign-in. Set before
// anything is printed: the test stops it once it asks for the code, and a stop that came before the handler ended it
// 143 on a CI runner (run 41617586051).
process.on("SIGTERM", () => process.exit(0));

if (process.argv.includes("--returns")) {
  const page = createServer((req, res) => {
    const signedIn = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("code") === "OK";
    res.end(signedIn ? "signed in" : "refused", () => process.exit(signedIn ? 0 : 3));
  });
  page.listen(0, "127.0.0.1", () => {
    const port = (page.address() as { port: number }).port;
    process.stdout.write(`Open https://accounts.example.test/auth?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/`)}&state=s1 and sign in\n`);
  });
} else process.stdout.write(`cwd=${process.cwd()}\nprofile=${process.env.FAKE_HOME}\nOpen \x1b[1mhttps://login.example.test/device?c=1\x1b[0m and paste the code:\n`);
if (process.argv.includes("--paste")) {
  let field = "";
  process.stdin.setRawMode?.(true);
  process.stdin.on("data", (chunk: Buffer) => {
    const got = chunk.toString("utf8");
    if (got === "\r" || got === "\n") process.exit(field === "CODE123" ? 0 : 3);
    // More than a key at once is a paste: its line ends are dropped, and nothing is sent.
    field += got.replace(/[\r\n]/g, "");
    process.stdout.write("*".repeat(got.length));
  });
} else for await (const line of console) process.exit(line.trim() === "CODE123" ? 0 : 3);
