/**
 * `nouride doctor`'s toolchain lines: what agents have installed, and what about it needs attention.
 *
 * Read from disk, so it answers with the daemon down. Who installed what is in `nouride audit`, which
 * already records every command with its agent — this is the state, not the history.
 */

import { dirname, fileExistsSync, fileOwner, join, realPath, runCommand, whichBinary } from "@nouride/runtime";
import { binProblems, binReport } from "@/modules/toolchain/bin-report.ts";
import { pythonEnvDir } from "@/modules/toolchain/env.ts";
import { binDirFor } from "@/modules/toolchain/facts.ts";
import { venvVersion } from "@/modules/toolchain/python.ts";

type Check = { level: "ok" | "warn" | "bad"; message: string; hint?: string };

/** Left by an `npm install` run in the data directory itself — not a global install, and nothing reads it. */
const STRAY = ["package.json", "package-lock.json", "node_modules"];

export async function toolchainChecks(dataDir: string): Promise<Check[]> {
  const nouride = dirname(dataDir);
  const install = dirname(nouride);
  const bin = binDirFor(dataDir);
  // A service keeps the agents' HOME inside `.nouride`; a checkout someone runs by hand does not.
  const service = fileExistsSync(join(nouride, "home"));
  const checks: Check[] = [];

  const entries = binReport(bin);
  const shadowing = entries.filter((entry) => entry.shadows && !entry.critical).map((entry) => entry.name);
  checks.push({
    level: "ok",
    message:
      entries.length === 0
        ? `agents' programs: none yet in ${bin}`
        : `agents' programs in ${bin}: ${entries.map((entry) => (entry.target ? `${entry.name} → ${entry.target}` : entry.name)).join(", ")}` +
          (shadowing.length > 0 ? ` (found ahead of the system's own: ${shadowing.join(", ")})` : ""),
  });
  for (const { name, problem } of binProblems(entries)) {
    checks.push({ level: "warn", message: `agents' programs: ${problem}`, hint: `Reinstall it properly, or remove it: rm ${join(bin, name)}` });
  }

  const stray = STRAY.filter((name) => fileExistsSync(join(nouride, name)));
  if (stray.length > 0) {
    checks.push({
      level: "warn",
      message: `${stray.join(", ")} in ${nouride}: an \`npm install\` run in the data directory, not a global install`,
      hint: "Nothing here reads them; remove them once you have checked: global installs go to .nouride/lib/node_modules.",
    });
  }

  if (service) {
    checks.push({
      level: "ok",
      message: `installs: global npm, bun, pipx, uv, go and cargo installs land in ${bin}; the daemon sets this up at start`,
    });
    const python = pythonEnvDir(nouride);
    const version = venvVersion(python);
    if (version && fileExistsSync(join(python, "bin", "pip"))) {
      checks.push({ level: "ok", message: `python env: ${python} (Python ${version}), what \`python3\` and \`pip\` are for agents` });
      checks.push(...(await pipCheck(python)));
    } else if (whichBinary("python3") === null) {
      // The container image has none unless EXTRA_PACKAGES adds it: nothing to build, nothing wrong.
      checks.push({ level: "ok", message: "python env: none (this host has no python3)" });
    } else {
      checks.push({
        level: "warn",
        message: `python env: not built at ${python}, so \`pip install\` meets PEP 668`,
        hint: "The daemon builds it at start. Why it could not: nouride logs | grep 'Python env' (usually the python3-venv package).",
      });
    }
    checks.push(...(await sizes(nouride)));
  }

  // Root runs `nouride` through `/usr/local/bin`. A symlink there makes root run a binary the service
  // account can rewrite — which every agent's commands run as. `install.sh` installs a launcher that
  // runs the CLI as the service account instead.
  const launcher = "/usr/local/bin/nouride";
  // Only when that binary is not root's: in the container image it is, and the link is harmless.
  const target = join(install, "nouride");
  if (service && process.platform === "linux" && realPath(launcher) === target && fileOwner(target) !== 0) {
    checks.push({
      level: "warn",
      message: `CLI: ${launcher} is a link to ${join(install, "nouride")}, so root running \`nouride\` runs a file the service account can change`,
      hint: "Re-run install.sh once: it replaces the link with a launcher that runs the CLI as the service account. .nouride/ is left alone.",
    });
  }
  return checks;
}

/**
 * What `pip check` says about the shared env — which sees the system's packages too.
 *
 * Every agent installs into the same env, so one agent's `pip install -U numpy` can leave the system's
 * pandas unimportable for all of them, and nothing else would say so. It also reports what was broken
 * before the env existed — on the live box, python-pptx without the lxml it needs — and since the env,
 * both are fixed the same way, with a `pip install` that needs no root.
 */
async function pipCheck(python: string): Promise<Check[]> {
  const result = await runCommand([join(python, "bin", "python3"), "-m", "pip", "check"], {
    cwd: python,
    timeoutMs: 60_000,
    maxOutputBytes: 64_000,
    env: { PATH: "/usr/bin:/bin", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
  }).catch(() => null);
  if (!result || result.exitCode === null) return [];
  if (result.exitCode === 0) return [{ level: "ok", message: "python env: no broken requirements (pip check)" }];
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const present = await importableWithoutMetadata(python, lines);
  const broken = lines.filter((line) => !present.has(missingName(line) ?? ""));
  if (broken.length === 0) {
    return [{ level: "ok", message: `python env: no broken requirements (pip check; ${[...present].join(", ")} imports, though installed without pip's metadata)` }];
  }
  return [
    {
      level: "warn",
      message: `python env: ${broken.length} broken requirement(s): ${broken.slice(0, 4).join("; ")}${broken.length > 4 ? "; …" : ""}`,
      hint:
        "Install what is missing into the shared env, as the service account: `pip install <name>`; put back a version an agent" +
        " changed with `pip install '<name>==<version>'`. Past repair: remove .nouride/opt/python and restart, and the daemon builds it again.",
    },
  ];
}

/** `pip check`'s line for a requirement it found no metadata for. A dotted name is left out: finding it imports its parent. */
const NOT_INSTALLED = /^\S+ \S+ requires ([A-Za-z0-9_-]+), which is not installed\.$/;

function missingName(line: string): string | null {
  return NOT_INSTALLED.exec(line)?.[1] ?? null;
}

/**
 * The "not installed" requirements Python imports anyway. The OS's own packages can ship a module with no metadata
 * pip reads — Debian's `python3-debconf`, which its `apt-listchanges` requires — and `pip install` would not fix
 * what is not broken. Found with `find_spec`, which runs none of the module's code.
 */
async function importableWithoutMetadata(python: string, lines: readonly string[]): Promise<Set<string>> {
  const names = lines.map(missingName).filter((name): name is string => name !== null);
  if (names.length === 0) return new Set();
  const find = "import importlib.util, sys\nfor n in sys.argv[1:]:\n  try:\n    if importlib.util.find_spec(n.replace('-', '_')): print(n)\n  except Exception: pass";
  const result = await runCommand([join(python, "bin", "python3"), "-I", "-c", find, ...names], {
    cwd: python,
    timeoutMs: 30_000,
    maxOutputBytes: 16_000,
    env: { PATH: "/usr/bin:/bin" },
  }).catch(() => null);
  return new Set(result?.exitCode === 0 ? result.stdout.split("\n").filter((name) => names.includes(name)) : []);
}

/** How much the toolchain and its caches take, so a full disk has a first place to look. */
async function sizes(nouride: string): Promise<Check[]> {
  const home = join(nouride, "home");
  const dirs = [join(nouride, "bin"), join(nouride, "lib"), join(nouride, "opt"), join(home, ".cache"), join(home, ".bun"), join(home, ".npm"), join(home, ".cargo"), join(home, ".rustup")].filter(fileExistsSync);
  if (dirs.length === 0) return [];
  const result = await runCommand(["du", "-sk", ...dirs], { cwd: nouride, timeoutMs: 15_000, maxOutputBytes: 16_000, env: { PATH: "/usr/bin:/bin" } }).catch(() => null);
  if (!result || result.exitCode !== 0) return [];
  const listed = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\t"))
    .map(([kb, path]) => `${(path ?? "").replace(`${nouride}/`, "")} ${formatKb(Number(kb))}`);
  return [{ level: "ok", message: `toolchain disk use: ${listed.join(", ")}` }];
}

function formatKb(kb: number): string {
  return kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`;
}
