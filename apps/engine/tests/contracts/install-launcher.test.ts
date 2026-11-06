/**
 * The `nouride` launcher `install.sh` writes runs the CLI as the service account when root runs it — and never runs
 * the account's binary as root.
 *
 * The binary belongs to that account, which every command an agent runs is too: a root that ran it would run a file
 * those commands can replace. When neither `setpriv` nor `runuser` was found, the launcher fell through to running it
 * as root. The launcher is rendered by `sh` itself from the script's heredoc, then run with an `id` that says 0 and a
 * PATH holding only what each case puts there.
 *
 * The secret store's key (0.8.19) is root's file, which the service account cannot read, so `decrypt`, `restore` and
 * a rollback run through the launcher found no key: the launcher hands it over in the environment, never as an
 * argument, where `ps` shows it to every account.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
const SH = existsSync("/bin/sh") ? "/bin/sh" : "sh";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The launcher as `install.sh` would write it, for an install at `installDir` owned by `svc`, root's key file in it. */
function launcher(installDir: string): string {
  const start = INSTALL.indexOf("cat > /usr/local/bin/nouride <<LAUNCHER\n");
  const end = INSTALL.indexOf("\nLAUNCHER\n", start);
  expect(start).toBeGreaterThan(-1);
  const heredoc = INSTALL.slice(start, end + "\nLAUNCHER\n".length).replace("cat > /usr/local/bin/nouride", "cat");
  const render = `SERVICE_USER=svc\nINSTALL_DIR='${installDir}'\nAGENT_HOME_FOR_LAUNCHER=/home/svc\nSYSTEM_KEY_FILE='${join(installDir, "nouride.env")}'\n${heredoc}`;
  const out = spawnSync(SH, ["-c", render], { encoding: "utf8" });
  expect(out.status).toBe(0);
  return out.stdout;
}

/** Where this machine has a tool the launcher reads root's key file with: linked in, as PATH holds nothing else. */
const TEXT_TOOLS = ["grep", "tail", "cut", "tr"].map((tool) => [tool, spawnSync(SH, ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim()] as const);

/**
 * A directory of stand-ins: `id` answering `uid`, a binary that records it ran and the key it was given, and whatever
 * tools are given, each recording its arguments and the key in its environment.
 */
function host(uid: number, tools: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "nouride-launcher-"));
  dirs.push(dir);
  const script = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!${SH}\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  const keySeen = `printf '%s' "\${NOURIDE_ENCRYPTION_KEY-none}" > "${join(dir, "key-seen")}"`;
  script("id", `echo ${uid}`);
  script("nouride", `echo "binary ran as $(id -u)" > "${join(dir, "ran")}"\n${keySeen}`);
  for (const tool of tools) script(tool, `echo "${tool} $*" > "${join(dir, "dropped")}"\n${keySeen}`);
  for (const [tool, path] of TEXT_TOOLS) if (path) symlinkSync(path, join(dir, tool));
  writeFileSync(join(dir, "launcher"), launcher(dir));
  const run = () => spawnSync(SH, [join(dir, "launcher"), "status"], { encoding: "utf8", env: { PATH: dir } });
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
  const keyFile = (text: string) => writeFileSync(join(dir, "nouride.env"), text, { mode: 0o600 });
  return { run, read, keyFile };
}

/** 32 bytes as base64, the shape `install.sh` writes: a stand-in, never a key anything uses. */
const KEY = "c3RhbmQtaW4ga2V5IGZvciB0aGUgbGF1bmNoZXIgdGU=";

describe("the launcher", () => {
  test("run by root with nothing that drops privileges, refuses — it never runs the binary as root", () => {
    const { run, read } = host(0, []);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nothing on this host can run it as svc");
    expect(read("ran")).toBeNull();
  });

  test.each(["setpriv", "runuser", "su-exec"])("run by root with %s, drops to the service account through it", (tool) => {
    const { run, read } = host(0, [tool]);
    run();
    expect(read("dropped")).toContain(tool);
    expect(read("dropped")).toContain("svc");
    expect(read("ran")).toBeNull();
  });

  test("run by anyone else, runs the binary as them", () => {
    const { run, read } = host(1000, []);
    expect(run().status).toBe(0);
    expect(read("ran")).toBe("binary ran as 1000\n");
  });
});

describe("the secret store's key, root's file", () => {
  test("run by root, handed to the service account in its environment, never as an argument", () => {
    const { run, read, keyFile } = host(0, ["setpriv"]);
    keyFile(`# Nouride: the secret store key.\nNOURIDE_ENCRYPTION_KEY=${KEY}\n`);
    run();
    expect(read("key-seen")).toBe(KEY);
    expect(read("dropped")).toContain("svc");
    expect(read("dropped")).not.toContain(KEY);
  });

  test("the last key line, as systemd and install.sh take it, with `export`, quotes or spaces around it", () => {
    const { run, read, keyFile } = host(0, ["runuser"]);
    keyFile(`NOURIDE_ENCRYPTION_KEY=an-older-one\n  export NOURIDE_ENCRYPTION_KEY = "${KEY}"\n# NOURIDE_ENCRYPTION_KEY=commented-out\n`);
    run();
    expect(read("key-seen")).toBe(KEY);
  });

  test("no file, no key: the variable is not set at all", () => {
    const { run, read } = host(0, ["su-exec"]);
    run();
    expect(read("key-seen")).toBe("none");
  });

  test("run by anyone else, root's file is not the launcher's to read", () => {
    const { run, read, keyFile } = host(1000, []);
    keyFile(`NOURIDE_ENCRYPTION_KEY=${KEY}\n`);
    run();
    expect(read("key-seen")).toBe("none");
  });
});
