/**
 * `root/nouride-pkg` keeps its rules whoever asks — the script itself, run as it is shipped,
 * against stand-in package managers that print what the real ones printed.
 *
 * The rules are the root half of system packages: the daemon asks a person first, and this is what
 * holds when something goes around that. Each case below is a request the script must refuse without
 * the package manager ever being told to change anything — the stand-in logs every call that is not a
 * simulation, and a refusal must leave that log empty.
 *
 * The apt output is Debian 13's (apt 3.0), captured on a live box and in `debian:trixie-slim`,
 * including the case that shaped `pkg_known`: `apt-get install j.q` reads an unknown dotted name as a
 * regular expression and plans a dozen unrelated packages.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG = join(import.meta.dir, "../root");

/** What the stand-in repositories carry, and what is installed. */
const REPO = ["jq", "jq-dev", "libjq1", "libonig5", "sl", "libedit2", "openssh-client", "openssh-server", "curl"];
const INSTALLED = ["libedit2", "openssh-client", "openssh-server", "curl"];

let dir = "";
let ranLog = "";

function tool(name: string, body: string): void {
  const path = join(dir, "bin", name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-pkg-"));
  ranLog = join(dir, "ran.log");
  mkdirSync(join(dir, "bin"));
  tool("apt-cache", `[ "$1" = pkgnames ] || exit 1\nfor n in ${REPO.join(" ")}; do case "$n" in "$2"*) echo "$n";; esac; done`);
  tool(
    "dpkg-query",
    `n="$3"\nfor i in ${INSTALLED.join(" ")}; do [ "$i" = "$n" ] && { printf 'install ok installed'; exit 0; }; done\nexit 1`,
  );
  // Simulations answer from fixtures; anything else is a real change, and is logged.
  tool(
    "apt-get",
    `case " $* " in
  *" -s install jq "*) printf 'Inst libonig5 (6.9.9-1+b1 Debian:13.7/stable [amd64])\\nInst libjq1 (1.7.1-6 Debian:13.7/stable [amd64])\\nInst jq (1.7.1-6 Debian:13.7/stable [amd64])\\nConf jq (1.7.1-6 Debian:13.7/stable [amd64])\\n' ;;
  *" -s install sl "*) printf 'Inst sl (5.02-1+b1 Debian:13.7/stable [amd64])\\n' ;;
  *" -s remove curl "*) printf 'Remv curl [8.14.1-2]\\n' ;;
  *" -s remove libedit2 "*) printf 'Remv openssh-client [1:10.0p1-7]\\nRemv libedit2 [3.1-20250104-1]\\n' ;;
  *" -s upgrade "*) printf 'Inst libc6 [2.41-12+deb13u2] (2.41-12+deb13u4 Debian:13.7/stable [amd64])\\n' ;;
  *" -s "*) exit 100 ;;
  *) echo "apt-get $*" >> "${ranLog}"; echo "Setting up ..." ;;
esac`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function pkg(args: string[], stdin?: string, more: Record<string, string> = {}) {
  // Only these in its environment: the script sets its own PATH, and these are what move it.
  const result = spawnSync("sh", [join(PKG, "nouride-pkg"), ...args], {
    cwd: dir,
    timeout: 20_000,
    encoding: "utf8",
    input: stdin ?? "",
    env: {
      NOURIDE_PKG_PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      NOURIDE_PKG_LIB: PKG,
      NOURIDE_PKG_LOCK: join(dir, "lock"),
      ...more,
    },
  });
  const lines = result.stdout.trim().split("\n");
  return { status: lines[lines.length - 1] ?? "", out: result.stdout, ran: existsSync(ranLog) ? readFileSync(ranLog, "utf8") : "" };
}

describe("nouride-pkg: what it refuses, changing nothing", () => {
  const refusals: [string, string[], string][] = [
    ["an option", ["install", "-o", "APT::Update::Pre-Invoke::=sh"], "not a package name: -o"],
    ["a path", ["install", "./evil.deb"], "not a package name: ./evil.deb"],
    ["a glob", ["install", "*"], "not a package name: *"],
    ["a version", ["install", "jq=1.6"], "not a package name: jq=1.6"],
    ["apt's remove suffix", ["install", "openssh-server-"], "not a package name: openssh-server-"],
    ["a dotted name apt would read as a pattern", ["install", "j.q"], "no package called j.q"],
    ["a protected package, named", ["remove", "openssh-server"], "openssh-server is protected"],
    ["a protected package, reached through a dependency", ["remove", "libedit2"], "would remove protected packages: openssh-client"],
    ["removing what is not installed", ["remove", "sl"], "sl is not installed"],
    ["an unknown operation", ["purge", "jq"], "unknown operation: purge"],
  ];

  for (const [what, args, says] of refusals) {
    test(what, async () => {
      const result = await pkg(args);
      expect(result.status).toStartWith("@nouride-pkg refused");
      expect(result.status).toContain(says);
      expect(result.ran).toBe("");
    });
  }

  test("a package the host names as protected too — what a container image ships (0.8.15)", async () => {
    // As apk keeps its world: a name, and now and then a version or a tag after it.
    writeFileSync(join(dir, "image-world"), "bash\ncurl>=8\n");
    const result = await pkg(["remove", "curl"], undefined, { NOURIDE_PKG_PROTECTED: join(dir, "image-world") });
    expect(result.status).toBe("@nouride-pkg refused curl is protected: removing it could leave this box unreachable");
    expect(result.ran).toBe("");
    // Without the file it is an ordinary removal.
    expect((await pkg(["remove", "curl"])).status).toBe("@nouride-pkg ok remove done");
  });

  test("too many names in one request", async () => {
    const result = await pkg(["install", ...Array.from({ length: 21 }, () => "jq")]);
    expect(result.status).toContain("at most 20 packages");
    expect(result.ran).toBe("");
  });
});

describe("nouride-pkg: what it does", () => {
  test("status names the backend", async () => {
    expect((await pkg(["status"])).status).toBe("@nouride-pkg ok protocol=1 backend=apt");
  });

  test("check prints the plan and changes nothing", async () => {
    const result = await pkg(["check", "install", "jq"]);
    expect(result.out).toContain("+ libonig5\n+ libjq1\n+ jq\n");
    expect(result.status).toBe("@nouride-pkg ok planned");
    expect(result.ran).toBe("");
  });

  test("install and remove run the manager without prompts, after the plan", async () => {
    const install = await pkg(["install", "sl"]);
    expect(install.out).toContain("+ sl\n");
    expect(install.status).toBe("@nouride-pkg ok install done");
    expect(install.ran).toContain("install sl");
    expect(install.ran).toContain("--force-confold");

    expect((await pkg(["remove", "curl"])).status).toBe("@nouride-pkg ok remove done");
  });

  test("upgrade with no names is everything, and a protected package may be upgraded", async () => {
    const result = await pkg(["upgrade"]);
    expect(result.out).toContain("+ libc6");
    expect(result.status).toBe("@nouride-pkg ok upgrade done");
  });

  test("as a socket service: one line on stdin, split without globbing", async () => {
    expect((await pkg(["--serve"], "check install jq\n")).status).toBe("@nouride-pkg ok planned");
    const glob = await pkg(["--serve"], "install *\n");
    expect(glob.status).toBe("@nouride-pkg refused not a package name: *");
    const chained = await pkg(["--serve"], "install jq;reboot\n");
    expect(chained.status).toContain("refused not a package name");
    expect(chained.ran).toBe("");
  });
});
