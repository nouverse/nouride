/**
 * A path an agent writes into an ssh config uses `${HOME}`, not `~` (0.7.17): inside the config `~` is the account's
 * home in /etc/passwd — read-only to the service on an install from before 0.7.17 — not the agents' HOME, so a key
 * made under `~/.ssh` in the shell would not be found by the config that names it.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..", "content", "skills");

test("no shipped skill tells an agent to name a file with ~ inside an ssh config", () => {
  const offenders = readdirSync(root, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".md"))
    .flatMap((path) =>
      readFileSync(join(root, path), "utf8")
        .split("\n")
        .filter((line) => /^\s+(IdentityFile|UserKnownHostsFile|ControlPath|CertificateFile)\s+~/i.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
  expect(offenders).toEqual([]);
});

test("network-reach names its key with ${HOME}", () => {
  expect(readFileSync(join(root, "network-reach", "SKILL.md"), "utf8")).toContain("IdentityFile ${HOME}/.ssh/nouride_ed25519");
});
