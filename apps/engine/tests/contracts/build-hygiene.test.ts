/**
 * What the build, the image and CI agree on, each held to one source.
 *
 * - **The Bun version** was set in five places that disagreed: CI pinned 1.4.2, the image floated on `1.4-alpine`
 *   (1.4.0 on the machine that checked it), the types said 1.4.0. Patch versions matter here — `fs.ts` records one
 *   that changed what `slice().stream()` returned. `.bun-version` is the one place now.
 * - **The licence id** on the public images was `LicenseRef-Nouride`, a placeholder no file defined. Since 2026-11-06
 *   (the owner) the code is under the PolyForm Noncommercial License 1.0.0, so every manifest and image label says its SPDX id,
 *   `PolyForm-Noncommercial-1.0.0`. `packages/wa-bridge` is MIT and stays so.
 * - **Installs in a release path** ran without a frozen lockfile, so the router artefacts were not reproducible from
 *   their lockfiles and the image and the tarball of one edition could resolve different trees.
 * - **The compose healthchecks** fetched port 18254 while `PORT` moved the daemon.
 * - **A plugin's `dir`** has to be a path git knows, since the build prints `git submodule update --init <dir>`.
 * - **`gh`** is on GitHub's images and not on the self-hosted build runner: the release's `sign` job called it
 *   without fetching it, and 0.7.17's first tag failed there with "gh: command not found" after every build passed.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALWAYS, OPTIONAL } from "../../../../scripts/build/edition.ts";

const ROOT = join(import.meta.dir, "../../../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const WORKFLOWS = readdirSync(join(ROOT, ".github/workflows")).filter((name) => name.endsWith(".yml"));
const PINNED = read(".bun-version").trim();
/** The base image's digest, as the Dockerfile pins it. */
const DIGEST = /^ARG BUN_DIGEST=(.+)$/m.exec(read("Dockerfile"))?.[1] ?? "";

describe("the Bun version", () => {
  test("is one exact version, in .bun-version", () => {
    expect(PINNED).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("is what every workflow installs, read from that file", () => {
    for (const name of WORKFLOWS) {
      const text = read(`.github/workflows/${name}`);
      const setups = text.split("uses: oven-sh/setup-bun@").length - 1;
      const fromFile = text.split("bun-version-file: .bun-version").length - 1;
      expect({ name, setups, fromFile, literal: /bun-version:\s/.test(text) }).toEqual({ name, setups, fromFile: setups, literal: false });
    }
  });

  test("is what the image builds and runs on, and the dev container too", () => {
    const dockerfile = read("Dockerfile");
    expect(/^ARG BUN_VERSION=(.+)$/m.exec(dockerfile)?.[1]).toBe(PINNED);
    const froms = [...dockerfile.matchAll(/^FROM .*oven\/bun:(\S+)/gm)].map((match) => match[1]);
    expect(froms.length).toBeGreaterThan(1);
    for (const from of froms) expect(from).toBe("${BUN_VERSION}-alpine@${BUN_DIGEST}");
    expect(read("docker-compose.dev.yml")).toContain(`image: oven/bun:${PINNED}-alpine@${DIGEST}`);
  });

  /**
   * By digest beside the tag (0.7.11): a tag can be pushed again over other bytes, a digest cannot. Nothing here can ask
   * the registry, so the pair is held two ways — the version the digest was read for is `.bun-version`, and every
   * stage built from it refuses a Bun that is not `BUN_VERSION`, which is what a digest of another version's image
   * would otherwise run without a word.
   */
  test("is the image pinned by digest, read for the version .bun-version names", () => {
    const dockerfile = read("Dockerfile");
    expect(DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(/^# BUN_DIGEST is oven\/bun:(\S+)-alpine's index digest/m.exec(dockerfile)?.[1]).toBe(PINNED);
    const stages = dockerfile.split(/^(?=FROM )/m).filter((stage) => /^FROM .*oven\/bun:/.test(stage));
    expect(stages.length).toBeGreaterThan(1);
    for (const stage of stages) {
      expect(stage).toContain("ARG BUN_VERSION\n");
      expect(stage).toContain(`RUN test "$(bun --version)" = "$BUN_VERSION" || {`);
    }
  });

  test("is what the types describe, and what this suite is running on", () => {
    // The types installed, read from the lockfile. `@types/bun` is a wrapper that follows `bun-types` by a day or two;
    // Bun 1.4.4 waited on it under an override for twelve days (2026-10-22), so the wrapper is held to the pin as well.
    const resolved = /^\s*"bun-types": \["bun-types@([^"]+)"/m.exec(read("bun.lock"))?.[1];
    expect(resolved).toBe(PINNED);
    const manifest = JSON.parse(read("package.json")) as { devDependencies: Record<string, string>; overrides?: Record<string, string> };
    expect(manifest.devDependencies["@types/bun"]).toBe(PINNED);
    expect(manifest.overrides?.["bun-types"]).toBeUndefined();
    // A contributor on another Bun learns it here rather than from a behaviour that differs by a patch version.
    expect(process.versions.bun).toBe(PINNED);
  });
});

describe("the licence id", () => {
  // The SPDX id every manifest and image label carries: free to use, change and share for noncommercial purposes.
  const declared = "PolyForm-Noncommercial-1.0.0";

  test("is what LICENSE says, and the manifests say it as npm does", () => {
    expect(read("LICENSE").split("\n")[0]).toBe("Nouride is licensed under the PolyForm Noncommercial License 1.0.0, below.");
    expect(read("LICENSE")).toContain("# PolyForm Noncommercial License 1.0.0");
    for (const path of ["package.json", "apps/engine/package.json"]) {
      expect({ path, license: (JSON.parse(read(path)) as { license?: string }).license }).toEqual({ path, license: declared });
    }
    expect(read("packages/isolation/root/nouride-run/Cargo.toml")).toContain(`license = "${declared}"`);
    // The bridge is MIT — the owner's call (0.7.10): the bridge open, the rest under the PolyForm Noncommercial terms. Its manifest, its
    // own LICENSE and the root LICENSE's list of separately licensed parts say the same thing.
    expect((JSON.parse(read("packages/wa-bridge/package.json")) as { license?: string }).license).toBe("MIT");
    expect(read("packages/wa-bridge/LICENSE").split("\n")[0]).toBe("MIT License");
    const separate = read("LICENSE").split("Licensed separately, and not by this file:")[1] ?? "";
    expect(separate).toMatch(/packages\/wa-bridge, the WhatsApp bridge: MIT/);
    expect(separate).toMatch(/content\/, the built-in skills and agent templates[\s\S]*?MIT/);
  });

  test("is on every image the Dockerfile makes, every image the release pushes, and what CI checks", () => {
    const labels = [...read("Dockerfile").matchAll(/^LABEL org\.opencontainers\.image\.licenses="([^"]+)"$/gm)].map((match) => match[1]);
    expect(labels.length).toBe(3);
    for (const label of labels) expect(label).toBe(declared);
    expect(read(".github/workflows/release.yml")).toContain(`"licence": "${declared}",`);
    expect(read(".github/workflows/ci-image.yml")).toContain(`[ "$label" = "${declared}" ]`);
    // The public half checks the images it builds from the kits, in the public repository.
    expect(read(".github/workflows/public-release.yml")).toContain(`[ "$got" = "${declared}" ]`);
    for (const path of ["Dockerfile", ".github/workflows/release.yml", ".github/workflows/ci-image.yml"]) {
      expect(read(path)).not.toMatch(/"LicenseRef-Nouride"|= "LicenseRef-Nouride"/);
    }
  });
});

describe("every install a build or a release runs", () => {
  test("is frozen to its lockfile", () => {
    const installs = [
      ...WORKFLOWS.flatMap((name) => [...read(`.github/workflows/${name}`).matchAll(/^\s*(?:-\s*)?(?:run:\s*)?bun install\b.*$/gm)].map((m) => `${name}: ${m[0].trim()}`)),
      ...read("Dockerfile").split("\n").filter((line) => !line.trimStart().startsWith("#")).flatMap((line) => [...line.matchAll(/bun install\b[^;)&]*/g)].map((m) => `Dockerfile: ${m[0]}`)),
    ];
    expect(installs.length).toBeGreaterThan(8);
    for (const install of installs) expect({ install, frozen: install.includes("--frozen-lockfile") }).toEqual({ install, frozen: true });
  });

  test("against the lockfile the image is given, and every build of a Pro edition refreshes its own", () => {
    expect(read(".dockerignore")).not.toContain("bun.lock");
    const core = read("scripts/build/core.ts");
    expect(core).toContain('  await run(["bun", "install", "--frozen-lockfile"], "internals/pro install", undefined, pro);');
    expect(core).not.toContain('if (!existsSync(join(pro, "node_modules")))');
  });
});

describe("the compose healthchecks", () => {
  test("ask the port the daemon listens on", () => {
    for (const path of ["docker-compose.yml", "docker-compose.prod.yml"]) {
      const check = /test: \[(.*)\]/.exec(read(path))?.[1] ?? "";
      expect({ path, env: check.includes("process.env.PORT||18254"), fixed: check.includes("localhost:18254") }).toEqual({ path, env: true, fixed: false });
    }
  });
});

describe("a plugin's dir", () => {
  test("is a submodule .gitmodules names, or a directory of this repository — never a path inside a submodule", () => {
    const submodules = [...read(".gitmodules").matchAll(/^\s*path = (.+)$/gm)].map((match) => match[1]!.trim());
    for (const plugin of [...ALWAYS, ...OPTIONAL]) {
      const inside = submodules.find((path) => plugin.dir !== path && plugin.dir.startsWith(`${path}/`));
      expect({ pkg: plugin.pkg, dir: plugin.dir, insideSubmodule: inside ?? null }).toEqual({ pkg: plugin.pkg, dir: plugin.dir, insideSubmodule: null });
      if (plugin.dir.startsWith("internals/")) expect(submodules).toContain(plugin.dir);
    }
  });
});

describe("the CI path filters", () => {
  /** Whether a repository path matches one of a workflow's `paths` globs (`**` any depth, `*` one segment). */
  const covered = (path: string, globs: string[]) =>
    globs.some((glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`).test(path));
  const pathsOf = (text: string, trigger: "push") => {
    const block = text.slice(text.indexOf(`  ${trigger}:`)).split(/\n {2}\w/)[0]!;
    return [...block.matchAll(/^\s+- "([^"]+)"$/gm)].map((match) => match[1]!);
  };

  test("the image's are what its Dockerfile copies", () => {
    // Each COPY source from the build context, as a file under it would name it.
    // Not `internals`: ci-image builds the free image with no submodule checked out, so the directory is empty there and
    // a submodule bump cannot change what it builds — the private images are built and checked in `release.yml`.
    const sources = [...read("Dockerfile").matchAll(/^COPY (?!--from)(.+) \S+$/gm)]
      .flatMap((match) => match[1]!.split(/\s+/))
      .filter((source) => source !== "internals");
    expect(sources.length).toBeGreaterThan(8);
    const workflow = read(".github/workflows/ci-image.yml");
    for (const trigger of ["push"] as const) {
      const globs = pathsOf(workflow, trigger);
      for (const source of sources) {
        const sample = source.includes(".") && !source.endsWith("/") ? source : `${source.replace(/\/$/, "")}/x/y.ts`;
        expect({ trigger, source, covered: covered(sample, globs) }).toEqual({ trigger, source, covered: true });
      }
      for (const path of ["Dockerfile", ".dockerignore"]) expect(covered(path, globs)).toBe(true);
    }
  });

  test("ci.yml filters nothing: the suite reads docs, the site's constants and every published file", () => {
    expect(read(".github/workflows/ci.yml")).not.toMatch(/paths(-ignore)?:/);
  });

  test("the site's deploy watches both installers it publishes", () => {
    const workflow = read(".github/workflows/deploy-site.yml");
    const sync = read("apps/site/scripts/sync-installer.ts");
    const published = [...sync.matchAll(/join\(ROOT, "([^"]+)"\)/g)].map((match) => match[1]!);
    expect(published).toEqual(["scripts/install.sh", "scripts/install-bundle-router.sh"]);
    for (const path of published) expect(covered(path, pathsOf(workflow, "push"))).toBe(true);
  });
});

describe("the dev container", () => {
  test("gives every workspace member its own node_modules volume, so no member shares the host's install", () => {
    const members = (JSON.parse(read("package.json")) as { workspaces: string[] }).workspaces;
    const mounted = [...read("docker-compose.dev.yml").matchAll(/^\s+- \w+:\/app\/(.+)\/node_modules$/gm)].map((match) => match[1]);
    expect(mounted).toEqual(members);
  });

  test("watches every package's source, read from the tree rather than listed by hand", () => {
    const watch = read("scripts/dev-watch.sh");
    expect(watch).toContain("for src in /app/packages/*/src; do");
    expect(watch).not.toMatch(/\/app\/packages\/[a-z-]+\/src/);
  });
});

describe("a release job that runs gh", () => {
  test("fetches it first, since the self-hosted runner does not have it", () => {
    const jobs = read(".github/workflows/release.yml").split(/^jobs:$/m)[1]?.split(/^(?=  [a-z-]+:$)/m) ?? [];
    const uses = /(^|[\s"(=])gh (release|run|api|pr) /m;
    const missing = jobs
      .filter((job) => uses.test(job))
      .filter((job) => {
        const fetch = job.indexOf("command -v gh >/dev/null && exit 0");
        return fetch < 0 || fetch > job.search(uses);
      })
      .map((job) => job.trim().split(":")[0]);
    expect(jobs.filter((job) => uses.test(job)).length).toBeGreaterThan(3);
    expect(missing).toEqual([]);
  });
});
