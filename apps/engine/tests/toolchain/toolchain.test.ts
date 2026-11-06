/**
 * Where agents' installs land, the one PATH, and the shared Python env.
 *
 * The behaviour under test is the one an agent meets: `npm i -g` with no flags lands in the bin
 * directory, `pip install` meets a venv instead of PEP 668, and none of it touches a person's own
 * machine. Each test builds a throwaway install and restores the process environment after itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch as osArch, platform as osPlatform, tmpdir } from "node:os";
import type { GlobalConfig, SandboxResult } from "@nouride/shared";
import { settleToolchain } from "@/boot/toolchain.ts";
import { agentBins, composePath, ownUserEnv, pythonEnvDir, toolchainEnv, TOOLCHAIN_ENV_NAMES } from "@/modules/toolchain/env.ts";
import { agentsOwnHome, describeHost, hostReadRoots, installedTools } from "@/modules/toolchain/facts.ts";
import { ensurePythonEnv, venvVersion } from "@/modules/toolchain/python.ts";
import { binProblems, binReport, OWN_WRAPPER } from "@/modules/toolchain/bin-report.ts";
import { toolchainChecks } from "@/cli/commands/doctor-toolchain.ts";

const SAVED = ["HOME", "PATH", "NOURIDE_BIN", "NOURIDE_PATH", ...TOOLCHAIN_ENV_NAMES] as const;
let saved: Record<string, string | undefined>;
let root: string;
let nouride: string;

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));
  for (const name of TOOLCHAIN_ENV_NAMES) delete process.env[name];
  root = mkdtempSync(join(tmpdir(), "nouride-toolchain-"));
  nouride = join(root, ".nouride");
  mkdirSync(join(nouride, "bin"), { recursive: true });
  mkdirSync(join(nouride, "home"), { recursive: true });
  mkdirSync(join(nouride, "data"), { recursive: true });
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function config(): GlobalConfig {
  return { daemon: { dataDir: join(nouride, "data") } } as unknown as GlobalConfig;
}

const noPython = async () => ({ state: "unavailable", why: "test" }) as const;

describe("the installers' own settings", () => {
  test("every global install lands in the bin directory, and the larger ones under opt", () => {
    const env = toolchainEnv("/srv/nouride/.nouride");
    expect(env.NPM_CONFIG_PREFIX).toBe("/srv/nouride/.nouride");
    for (const name of ["BUN_INSTALL_BIN", "UV_TOOL_BIN_DIR", "PIPX_BIN_DIR", "GOBIN", "XDG_BIN_HOME"] as const) {
      expect(env[name]).toBe("/srv/nouride/.nouride/bin");
    }
    // cargo appends `bin/` itself.
    expect(env.CARGO_INSTALL_ROOT).toBe("/srv/nouride/.nouride");
    expect(env.PIPX_HOME).toBe("/srv/nouride/.nouride/opt/pipx");
    expect(Object.keys(env).sort()).toEqual([...TOOLCHAIN_ENV_NAMES].sort());
  });

  test("one PATH: the bin directory, the Python env, the system's, then HOME's tool directories last", () => {
    const path = composePath({ bin: "/n/bin", python: "/n/opt/python", startup: "/usr/bin:/bin:/n/bin", home: "/n/home" });
    expect(path).toBe("/n/bin:/n/opt/python/bin:/usr/bin:/bin:/n/home/.local/bin:/n/home/.cargo/bin");
  });
});

describe("boot", () => {
  test("a service — HOME is the agents' own — gets the redirects and the composed PATH", () => {
    process.env.HOME = join(nouride, "home");
    process.env.NOURIDE_BIN = join(nouride, "bin");
    process.env.PATH = `${join(nouride, "bin")}:/usr/bin:/bin`;
    settleToolchain(config(), noPython);

    expect(process.env.NPM_CONFIG_PREFIX).toBe(nouride);
    expect(process.env.PIPX_BIN_DIR).toBe(join(nouride, "bin"));
    expect(process.env.PATH).toBe(
      [join(nouride, "bin"), join(nouride, "opt", "python", "bin"), "/usr/bin", "/bin", join(nouride, "home", ".local", "bin"), join(nouride, "home", ".cargo", "bin")].join(":"),
    );
    expect(process.env.NOURIDE_PATH).toBe(process.env.PATH);
  });

  test("a value the operator set wins, when it is somewhere this process can write", () => {
    process.env.HOME = join(nouride, "home");
    process.env.NPM_CONFIG_PREFIX = join(root, "mine");
    settleToolchain(config(), noPython);
    expect(process.env.NPM_CONFIG_PREFIX).toBe(join(root, "mine"));
  });

  test("a preset value naming a directory nobody here can write is replaced, not kept", () => {
    // The container's base image sets BUN_INSTALL_BIN=/usr/local/bin, root's: kept, every `bun add -g` failed.
    const locked = join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    process.env.HOME = join(nouride, "home");
    process.env.BUN_INSTALL_BIN = locked;
    process.env.NPM_CONFIG_UPDATE_NOTIFIER = "true";
    settleToolchain(config(), noPython);
    expect(process.env.BUN_INSTALL_BIN).toBe(join(nouride, "bin"));
    // A switch is the operator's either way.
    expect(process.env.NPM_CONFIG_UPDATE_NOTIFIER).toBe("true");
    chmodSync(locked, 0o755);
  });

  test("a person's own machine is left alone: no installer is repointed", () => {
    process.env.HOME = join(root, "someone");
    process.env.PATH = `${join(nouride, "bin")}:/usr/bin`;
    settleToolchain(config(), noPython);
    expect(process.env.NPM_CONFIG_PREFIX).toBeUndefined();
    expect(process.env.PATH).toBe(`${join(nouride, "bin")}:/usr/bin`);
    expect(agentsOwnHome(join(nouride, "data"))).toBeNull();
  });
});

describe("what an agent is told", () => {
  test("the bin directory's contents, re-read when it changes", () => {
    const bin = join(nouride, "bin");
    expect(installedTools(bin)).toEqual([]);
    writeFileSync(join(bin, "rg"), "");
    writeFileSync(join(bin, ".hidden"), "");
    // A new mtime is what makes it re-read; force one rather than depend on the clock's resolution.
    utimesSync(bin, new Date(), new Date(Date.now() + 5000));
    expect(installedTools(bin)).toEqual(["rg"]);
  });

  test("the host as release assets name it", () => {
    expect(describeHost({ platform: "linux", arch: "x86_64", libc: "musl" })).toBe("linux/x86_64 with musl");
    expect(describeHost({ platform: "darwin", arch: "aarch64", libc: null })).toBe("darwin/aarch64");
  });

  test("and it is this machine's, as the operating system says it", () => {
    // What the prompt tells an agent to download for. Read from `os.platform()`/`os.arch()`, which no compile folds:
    // a Mac binary built from Linux code said "linux/x86_64 with glibc" and agents fetched Linux binaries.
    const arch = osArch() === "x64" ? "x86_64" : osArch() === "arm64" ? "aarch64" : osArch();
    expect(describeHost().startsWith(`${osPlatform()}/${arch}`)).toBe(true);
  });

  test("HOME and the program directories are readable by path, for a service", () => {
    process.env.HOME = join(nouride, "home");
    expect(hostReadRoots(join(nouride, "bin"))).toEqual([join(nouride, "home"), join(nouride, "bin"), join(nouride, "lib"), join(nouride, "opt")]);
    process.env.HOME = join(root, "someone");
    expect(hostReadRoots(join(nouride, "bin"))).not.toContain(join(root, "someone"));
  });
});

/** A `runCommand` double: the probe answers `version`, the venv command creates what a venv has. */
function fakePython(version: string, opts: { venvFails?: string } = {}) {
  const calls: string[][] = [];
  const run = async (argv: string[]): Promise<SandboxResult> => {
    calls.push(argv);
    const done = (stdout: string, exitCode = 0, stderr = ""): SandboxResult => ({ stdout, stderr, exitCode, timedOut: false, truncated: false, durationMs: 1 });
    if (argv[1] === "-c") return done(`${version}\n`);
    const dir = argv.at(-1)!;
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "pyvenv.cfg"), `home = /usr/bin\ninclude-system-site-packages = true\nversion = ${version}.5\n`);
    writeFileSync(join(dir, "bin", "python3"), "");
    // As venv does without ensurepip: the env made, and it stops before pip.
    if (opts.venvFails) return done("", 1, opts.venvFails);
    writeFileSync(join(dir, "bin", "pip"), "");
    return done("");
  };
  return { run: run as never, calls };
}

describe("the shared Python env", () => {
  test("built once, layered over the system's packages, and left alone while it matches", async () => {
    const dir = pythonEnvDir(nouride);
    const first = fakePython("3.13");
    expect(await ensurePythonEnv(dir, { python: "/usr/bin/python3", env: {}, run: first.run })).toEqual({ state: "ready", version: "3.13" });
    expect(first.calls[1]).toEqual(["/usr/bin/python3", "-m", "venv", "--system-site-packages", dir]);
    expect(venvVersion(dir)).toBe("3.13");

    const again = fakePython("3.13");
    await ensurePythonEnv(dir, { python: "/usr/bin/python3", env: {}, run: again.run });
    expect(again.calls).toHaveLength(1);
  });

  test("rebuilt when the system's Python moved on, with what it held listed beside the old copy", async () => {
    const dir = pythonEnvDir(nouride);
    await ensurePythonEnv(dir, { python: "/usr/bin/python3", env: {}, run: fakePython("3.13").run });
    mkdirSync(join(dir, "lib", "python3.13", "site-packages", "pandas-2.3.1.dist-info"), { recursive: true });

    expect(await ensurePythonEnv(dir, { python: "/usr/bin/python3", env: {}, run: fakePython("3.14").run })).toEqual({ state: "ready", version: "3.14" });
    const aside = readdirSync(join(nouride, "opt")).find((name) => name.startsWith("python.broken-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(nouride, "opt", aside!, "requirements.txt"), "utf8")).toBe("pandas==2.3.1\n");
  });

  test("a missing python3-venv is named, so the hint can say what to install", async () => {
    const failing = fakePython("3.13", { venvFails: "The virtual environment was not created successfully because ensurepip is not\navailable.  On Debian/Ubuntu systems, you need to install the python3-venv\npackage" });
    expect(await ensurePythonEnv(pythonEnvDir(nouride), { python: "/usr/bin/python3", env: {}, run: failing.run })).toEqual({
      state: "failed",
      why: "the python3-venv package is not installed",
    });
  });

  test("a failed build leaves nothing, so the next boot does not set a half-made env aside again", async () => {
    // Found on a box without python3-venv: every boot set the last one's half-made env aside, and the copies piled up.
    const failing = fakePython("3.13", { venvFails: "ensurepip is not available" });
    for (let boot = 0; boot < 3; boot += 1) await ensurePythonEnv(pythonEnvDir(nouride), { python: "/usr/bin/python3", env: {}, run: failing.run });
    expect(readdirSync(join(nouride, "opt")).filter((name) => name.startsWith("python"))).toEqual([]);
  });

  test("no python3 at all is not an error", async () => {
    expect((await ensurePythonEnv(pythonEnvDir(nouride), { python: null, env: {} })).state).toBe("unavailable");
  });
});

describe("what doctor and boot say about the bin directory", () => {
  test("a link into a cache, a broken link, and a program that hides the system's", () => {
    const bin = join(nouride, "bin");
    mkdirSync(join(root, ".cache", "x"), { recursive: true });
    writeFileSync(join(root, ".cache", "x", "ffprobe"), "");
    symlinkSync(join(root, ".cache", "x", "ffprobe"), join(bin, "ffprobe"));
    symlinkSync(join(root, "gone"), join(bin, "old"));
    writeFileSync(join(bin, "tar"), "");

    const problems = binProblems(binReport(bin)).map((found) => found.problem).join("\n");
    expect(problems).toContain("ffprobe is a link into a cache");
    expect(problems).toContain("old points at");
    expect(problems).toContain("tar is found ahead of the system's");
  });

  test("the daemon's own ssh wrapper is ahead of the system's on purpose, and is not a problem; another ssh is", () => {
    const bin = join(nouride, "bin");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\n${OWN_WRAPPER} (0.7.17) — edits here do not last.\nexec /usr/bin/ssh "$@"\n`);
    expect(binProblems(binReport(bin))).toEqual([]);
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\n# mine\nexec /usr/bin/ssh \"$@\"\n");
    expect(binProblems(binReport(bin)).map((found) => found.problem).join("\n")).toContain("ssh is found ahead of the system's");
  });

  test("doctor names the stray package.json and the missing Python env", async () => {
    writeFileSync(join(nouride, "package.json"), "{}");
    const checks = await toolchainChecks(join(nouride, "data"));
    const text = checks.map((check) => `${check.level} ${check.message}`).join("\n");
    expect(text).toContain("warn package.json");
    expect(text).toContain("warn python env: not built");
    expect(text).toContain("installs: global npm, bun, pipx, uv, go and cargo installs land in");
  });
});

/** The real Python answers what imports; `pip check` is played back from a file, as the live box gave it. */
const systemPython = spawnSync("/usr/bin/python3", ["-c", "pass"], { timeout: 10_000 }).status === 0;

function envWithPipCheck(lines: readonly string[]): void {
  const python = pythonEnvDir(nouride);
  mkdirSync(join(python, "bin"), { recursive: true });
  writeFileSync(join(python, "pyvenv.cfg"), "home = /usr/bin\ninclude-system-site-packages = true\nversion = 3.13.5\n");
  writeFileSync(join(python, "bin", "pip"), "");
  writeFileSync(join(python, "check.out"), lines.map((line) => `${line}\n`).join(""));
  writeFileSync(join(python, "bin", "python3"), `#!/bin/sh\nif [ "$1 $2" = "-m pip" ]; then cat "${join(python, "check.out")}"; exit 1; fi\nexec /usr/bin/python3 "$@"\n`);
  chmodSync(join(python, "bin", "python3"), 0o755);
}

describe("doctor's pip check", () => {
  test.skipIf(!systemPython)("a requirement pip has no metadata for but Python imports is not broken; a wrong version and a missing one are", async () => {
    envWithPipCheck([
      "apt-listchanges 4.8 requires json, which is not installed.",
      "pyopenssl 25.0.0 has requirement cryptography<45,>=41.0.5, but you have cryptography 49.0.0.",
      "acme 4.0 requires nouride_gone, which is not installed.",
    ]);
    const text = (await toolchainChecks(join(nouride, "data"))).map((check) => `${check.level} ${check.message}`).join("\n");
    expect(text).toContain("warn python env: 2 broken requirement(s): pyopenssl 25.0.0 has requirement");
    expect(text).toContain("acme 4.0 requires nouride_gone");
    expect(text).not.toContain("apt-listchanges");
  });

  test.skipIf(!systemPython)("with only those, the env is clean — and doctor says which it let through", async () => {
    envWithPipCheck(["apt-listchanges 4.8 requires json, which is not installed."]);
    const text = (await toolchainChecks(join(nouride, "data"))).map((check) => `${check.level} ${check.message}`).join("\n");
    expect(text).toContain("ok python env: no broken requirements (pip check; json imports, though installed without pip's metadata)");
    expect(text).not.toContain("warn python env");
  });
});

describe("a command run as its agent's own user (0.8.0)", () => {
  const own = "/w/private/nouva";
  const env = ownUserEnv(own, "/n/bin:/n/opt/python/bin:/usr/bin:/bin:/n/home/.local/bin:/n/home/.cargo/bin", "/n/home/.rustup");

  test("its HOME is its own folder, and what it installs lands there, first on its PATH, as `$NOURIDE_BIN`", () => {
    expect(env.HOME).toBe(own);
    expect(env.NOURIDE_BIN).toBe(`${own}/.local/bin`);
    expect(env.NPM_CONFIG_PREFIX).toBe(`${own}/.local`);
    expect(env.PIPX_BIN_DIR).toBe(`${own}/.local/bin`);
    expect(env.CARGO_INSTALL_ROOT).toBe(`${own}/.local`);
  });

  test("what is installed for every agent stays on the PATH behind its own — the daemon's HOME's tools last, as before", () => {
    expect(env.PATH).toBe(`${own}/.local/bin:${own}/.local/opt/python/bin:/n/bin:/n/opt/python/bin:/usr/bin:/bin:/n/home/.local/bin:/n/home/.cargo/bin:${own}/.cargo/bin`);
    expect(env.NOURIDE_PATH).toBe(env.PATH);
  });

  test("Rust's toolchains are the shared ones where there are any; what cargo downloads is its own", () => {
    expect(env.RUSTUP_HOME).toBe("/n/home/.rustup");
    expect(env).not.toHaveProperty("CARGO_HOME");
    expect(ownUserEnv(own, "/usr/bin")).not.toHaveProperty("RUSTUP_HOME");
  });

  test("what it is told: its own bin and HOME, the shared bin behind — or the shared bin alone, as before", () => {
    expect(agentBins("/n/bin", own, true)).toEqual({ binDir: `${own}/.local/bin`, ownHome: own, sharedBinDir: "/n/bin" });
    expect(agentBins("/n/bin", own, false)).toEqual({ binDir: "/n/bin" });
    expect(agentBins("/n/bin", undefined, true)).toEqual({ binDir: "/n/bin" });
  });
});
