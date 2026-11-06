/**
 * The agents' ssh reads the agents' HOME (0.7.17): OpenSSH takes `~/.ssh/config` from /etc/passwd's home, so the
 * daemon puts `ssh`, `scp` and `sftp` first on the agents' PATH naming `$HOME/.ssh/config`, and that config includes
 * the passwd home's — once. Real files and a real shell: the wrapper is what runs, so it is what is run here.
 */

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleSsh } from "@/boot/ssh-config.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A machine: the agents' HOME, the account's passwd home with its own config, `.nouride/bin`, and "real" programs that print their arguments. */
function machine(passwdConfig: string | null = "Host nas\n    User admin\n") {
  const root = mkdtempSync(join(tmpdir(), "nouride-ssh-"));
  roots.push(root);
  const home = join(root, "agents-home"), passwd = join(root, "home-nouride"), bin = join(root, "bin"), system = join(root, "usr-bin");
  for (const dir of [home, join(passwd, ".ssh"), bin, system]) mkdirSync(dir, { recursive: true });
  if (passwdConfig !== null) writeFileSync(join(passwd, ".ssh", "config"), passwdConfig);
  for (const program of ["ssh", "scp", "sftp"]) {
    writeFileSync(join(system, program), `#!/bin/sh\necho "${program} $*"\n`);
    chmodSync(join(system, program), 0o755);
  }
  const ours = join(home, ".ssh", "config");
  const settle = () => settleSsh({ home, passwdHome: passwd, bin, path: `${bin}:${system}` });
  const run = (program: string, ...args: string[]) =>
    spawnSync(join(bin, program), args, { env: { HOME: home, PATH: `${bin}:${system}` }, encoding: "utf8" }).stdout.trim();
  const own = (text: string) => {
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(ours, text);
  };
  return { home, passwd, bin, system, ours, settle, run, own };
}

test("ssh, scp and sftp name the agents' config, and a -F the command gives comes after it and wins", () => {
  const m = machine();
  m.own("Host vpn-gateway\n    HostName 192.0.2.1\n");
  m.settle();
  for (const program of ["ssh", "scp", "sftp"]) expect(m.run(program, "host")).toBe(`${program} -F ${m.ours} host`);
  expect(m.run("ssh", "-F", "/elsewhere", "host")).toBe(`ssh -F ${m.ours} -F /elsewhere host`);
});

test("the agents' config includes the passwd home's after its own entries, under Match all, once", () => {
  const m = machine();
  m.own("Host vpn-gateway\n    HostName 192.0.2.1\n");
  m.settle();
  m.settle();
  const text = readFileSync(m.ours, "utf8");
  expect(text.startsWith("Host vpn-gateway\n    HostName 192.0.2.1\n\n")).toBe(true);
  expect(text.split(`Include ${m.passwd}/.ssh/config`).length - 1).toBe(1);
  // `-F` skips the system config, so it is named again — after the account's, where ssh would have read it.
  expect(text.indexOf("Include /etc/ssh/ssh_config")).toBeGreaterThan(text.indexOf(`Include ${m.passwd}/.ssh/config`));
  expect(text.indexOf("Match all")).toBeLessThan(text.indexOf(`Include ${m.passwd}/.ssh/config`));
});

test("with no config of the agents' own, one is made that only includes the account's", () => {
  const m = machine();
  m.settle();
  expect(readFileSync(m.ours, "utf8")).toContain(`Include ${m.passwd}/.ssh/config\n`);
  expect(m.run("ssh", "host")).toBe(`ssh -F ${m.ours} host`);
});

test("new host keys go to the agents' HOME, which is writable; the account's are still read", () => {
  const m = machine(null);
  m.settle();
  expect(readFileSync(m.ours, "utf8")).toContain("Match all\n    UserKnownHostsFile ${HOME}/.ssh/known_hosts ~/.ssh/known_hosts\n");
  expect(m.run("ssh", "host")).toBe(`ssh -F ${m.ours} host`);
});

test("nothing is touched where the two homes are one, or where there is no ssh", () => {
  const same = machine();
  settleSsh({ home: same.passwd, passwdHome: same.passwd, bin: same.bin, path: `${same.bin}:${same.system}` });
  expect(existsSync(join(same.bin, "ssh"))).toBe(false);
  const none = machine();
  settleSsh({ home: none.home, passwdHome: none.passwd, bin: none.bin, path: none.bin });
  expect(existsSync(join(none.bin, "ssh"))).toBe(false);
  expect(existsSync(none.ours)).toBe(false);
  expect(existsSync(same.ours)).toBe(false);
});
