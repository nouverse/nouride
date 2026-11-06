/**
 * The private source maps leave CI for the internal release and nowhere else — the binaries' and the images'.
 *
 * A map carries the source it was built from — `sourcesContent`, Pro plugins included — so it goes where the private
 * checksum signatures go: `${GITHUB_REPOSITORY}`, under the guard that keeps private assets off a public repository.
 * The public release takes tarballs, checksums and their signatures, named; the audit fails if a map reached it anyway.
 * An image's map leaves its build through one Dockerfile stage, and is checked against the pushed image first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@nouride/runtime";
import { bundleFlags, compileFlags } from "../../../../scripts/build/core.ts";
import { PUBLIC_EDITIONS } from "../../../../scripts/build/editions.ts";

const ROOT = join(import.meta.dir, "../../../..");
const release = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
/** Put together at run time: written out, this file would carry a map reference, which `lint:public` refuses. */
const REF = ["//# sourceMappingURL", ""].join("=");

/** Each step's text by its `name:`, from its `- ` to the next step's. */
function step(name: string): string {
  const at = release.indexOf(`- name: ${name}\n`);
  if (at < 0) throw new Error(`no step named "${name}"`);
  const next = release.indexOf("\n      - ", at + 1);
  return release.slice(at, next < 0 ? undefined : next);
}

/** Every `gh release upload` command, continuation lines joined. */
function uploads(): string[] {
  return [...release.replace(/\\\n\s*/g, " ").matchAll(/gh release upload [^\n]*/g)].map((m) => m[0]);
}

describe("the source maps a release builds", () => {
  test("go to the internal release, under the guard that keeps private assets off a public repository", () => {
    const upload = step("Upload the private source maps to the internal repository");
    expect(upload).toContain("needs.guard-visibility.outputs.publish_private_assets == 'true'");
    expect(upload).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(upload).toContain(`gh release upload "\${GITHUB_REF_NAME}" dist/*.map --repo "\${GITHUB_REPOSITORY}" --clobber`);
    // For every row: a public row's map is as private as a Pro row's.
    expect(upload).not.toContain("matrix.private");
  });

  test("never go to the public release: what it takes is named, and a map is not among it", () => {
    const toPublic = uploads().filter((command) => command.includes("nouverse/nouride"));
    expect(toPublic.length).toBeGreaterThan(0);
    for (const command of toPublic) {
      const assets = command.replace(/^gh release upload "\$\{GITHUB_REF_NAME\}" /, "").split(" --repo")[0]!.trim().split(/\s+/);
      for (const asset of assets) expect({ command, asset, ok: /(\.tar\.gz|CHECKSUMS(-[a-z-]+)?\*|\*\.sig)$/.test(asset) }).toMatchObject({ ok: true });
    }
  });

  test("and the audit fails a public release that carries one", () => {
    const audit = step("Verify published release assets");
    expect(audit).toContain(`case "$asset" in *.map)`);
    // Said through the step's `error`, which writes the workflow command only when it runs (`release-log.test.ts`).
    expect(audit).toMatch(/\*\.map\) error "[^"]*"; exit 1/);
  });
});

describe("the images", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  /** Each stage of the Dockerfile by name, from its `FROM` to the next. */
  const stages = new Map(
    dockerfile
      .split(/^(?=FROM )/m)
      .filter((part) => part.startsWith("FROM "))
      .map((part): [string, string] => [/ AS (\S+)/.exec(part.split("\n")[0]!)?.[1] ?? "", part]),
  );

  test("mangle as the binaries do: one set of flags for both", () => {
    const basic = PUBLIC_EDITIONS[0]!;
    expect(bundleFlags(basic)).toContain("--minify-identifiers");
    expect(compileFlags(basic)).toEqual(expect.arrayContaining(bundleFlags(basic)));
  });

  test("let the map out of one stage only, and no runtime stage copies one", () => {
    const instructions = (stages.get("source-map") ?? "").split("\n").filter((line) => line.trim() && !line.startsWith("#"));
    expect(instructions).toEqual(["FROM scratch AS source-map", "COPY --from=engine-builder /app/dist/*.map /"]);
    for (const [name, text] of stages) {
      if (name === "source-map") continue;
      const copies = text.split("\n").filter((line) => line.startsWith("COPY"));
      expect({ name, mapCopies: copies.filter((line) => /\.map\b/.test(line)) }).toEqual({ name, mapCopies: [] });
      expect({ name, from: text.split("\n")[0] }).toEqual({ name, from: expect.not.stringContaining("source-map") });
    }
    // What the runtime takes from the build stage's `dist/`: the bundle, by name, and nothing else.
    expect(dockerfile.match(/COPY --from=engine-builder \/app\/dist\/\S+/g)).toEqual([
      "COPY --from=engine-builder /app/dist/*.map",
      "COPY --from=engine-builder /app/dist/nouride.bundle.js",
    ]);
    // Nor does a map from the checkout reach a build context.
    const ignored = readFileSync(join(ROOT, ".dockerignore"), "utf8").split("\n");
    expect(ignored).toEqual(expect.arrayContaining(["dist", ".cache", "**/*.map"]));
  });

  test("take the map out, prove it fits the pushed image, and only then upload it to the internal release", () => {
    const exported = step("Export the image's private source map");
    expect(exported).toContain("target: source-map");
    expect(exported).toContain("outputs: type=local,dest=${{ runner.temp }}/image-map");
    const checked = step("The source map fits the bundle in the pushed image");
    expect(checked).toContain("sh scripts/release/image-map-fits.sh");
    expect(checked).toContain("MAP_DIR: ${{ runner.temp }}/image-map");
    const upload = step("Upload the image's private source map to the internal repository");
    expect(upload).toContain("if: startsWith(github.ref, 'refs/tags/v') && needs.guard-visibility.outputs.publish_private_assets == 'true'");
    expect(upload).toContain(`gh release upload "\${GITHUB_REF_NAME}" "\${{ runner.temp }}"/image-map/*.map --repo "\${GITHUB_REPOSITORY}" --clobber`);
    // In that order: a step that fails stops the ones after it.
    expect(release.indexOf(exported)).toBeLessThan(release.indexOf(checked));
    expect(release.indexOf(checked)).toBeLessThan(release.indexOf(upload));
    // The images job may now write a release asset, and says why.
    const images = release.slice(release.indexOf("\n  images:\n"), release.indexOf("\n  release:\n"));
    expect(images).toContain("      contents: write # the image's private source map goes on the internal release");
    // A pull request's image is held to the same check.
    expect(readFileSync(join(ROOT, ".github/workflows/ci-image.yml"), "utf8")).toContain("sh scripts/release/image-map-fits.sh");
  });
});

describe("scripts/release/image-map-fits.sh", () => {
  /**
   * Run against a `docker` that answers from fixtures: `docker cp` hands out `bundle-<arch>.js`, `docker export` a
   * tarball of `fs-<arch>/`. The script is what stands between a map and the internal release, so each way it must
   * refuse is driven here.
   */
  let dir: string;
  const bundle = "#!/usr/bin/env bun\n// @bun\nvar a=1;\n";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nr-image-map-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin", "docker"),
      [
        "#!/bin/sh",
        'case "$1" in',
        "  pull) exit 0 ;;",
        '  create) echo "fake-${3##*/}" ;;',
        '  cp) arch=${2%%:*}; cp "$FAKE/bundle-${arch#fake-}.js" "$3" ;;',
        '  export) tar -cf - -C "$FAKE/fs-${2#fake-}" . ;;',
        "  rm) exit 0 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** One image: what each platform carries, and the map exported for it. */
  function image(name: string, opts: { amd64?: string; arm64?: string; stamp?: Record<string, string>; extra?: string } = {}) {
    const fake = join(dir, name);
    mkdirSync(fake, { recursive: true });
    for (const arch of ["amd64", "arm64"] as const) {
      writeFileSync(join(fake, `bundle-${arch}.js`), opts[arch] ?? bundle, { flag: "w" });
      mkdirSync(join(fake, `fs-${arch}`, "app"), { recursive: true });
      writeFileSync(join(fake, `fs-${arch}`, "app", "nouride.bundle.js"), opts[arch] ?? bundle);
    }
    if (opts.extra) writeFileSync(join(fake, "fs-arm64", opts.extra), "{}");
    mkdirSync(join(fake, "maps"), { recursive: true });
    const stamp = { version: "0.7.10", edition: "router", target: "image", codeSha256: sha(bundle), ...opts.stamp };
    writeFileSync(join(fake, "maps", "nouride-router-image.map"), JSON.stringify({ version: 3, x_nouride: stamp }));
    return fake;
  }

  async function check(fake: string) {
    return runCommand(["sh", join(ROOT, "scripts/release/image-map-fits.sh")], {
      cwd: dir,
      timeoutMs: 20_000,
      maxOutputBytes: 64_000,
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        FAKE: fake,
        MAP_DIR: join(fake, "maps"),
        IMAGE: "ghcr.io/nouverse/nouride-router:0.7.10",
        EDITION: "router",
        VERSION: "0.7.10",
      },
    });
  }

  test("passes a map whose stamp is this build and whose hash is the bundle on every platform", async () => {
    const ok = await check(image("ok"));
    expect(ok.stdout.trim().split("\n")).toEqual([
      `linux/amd64: /app/nouride.bundle.js is the bundle nouride-router-image.map maps (sha256 ${sha(bundle)}), and the image carries no source map`,
      `linux/arm64: /app/nouride.bundle.js is the bundle nouride-router-image.map maps (sha256 ${sha(bundle)}), and the image carries no source map`,
    ]);
    expect(ok.exitCode).toBe(0);
  });

  test("refuses one platform's different bundle, a .map anywhere in an image, a bundle naming a map, and another build's stamp", async () => {
    const other = await check(image("other-arm64", { arm64: "#!/usr/bin/env bun\n// @bun\nvar b=2;\n" }));
    expect({ code: other.exitCode, out: other.stdout }).toEqual({
      code: 1,
      out: expect.stringContaining("(linux/arm64) carries a bundle that is not the one nouride-router-image.map maps"),
    });
    const leaked = await check(image("leaked", { extra: "app/nouride.bundle.js.map" }));
    expect({ code: leaked.exitCode, out: leaked.stdout }).toEqual({ code: 1, out: expect.stringContaining("(linux/arm64) carries a source map: ./app/nouride.bundle.js.map") });
    const named = `${bundle}${REF}nouride.bundle.js.map\n`;
    const naming = await check(image("naming", { amd64: named, arm64: named, stamp: { codeSha256: sha(named) } }));
    expect({ code: naming.exitCode, out: naming.stdout }).toEqual({ code: 1, out: expect.stringContaining("carries a bundle that names a source map") });
    const stamps: Record<string, string>[] = [{ version: "0.7.9" }, { edition: "basic" }, { target: "linux-x64" }];
    for (const stamp of stamps) {
      const wrong = await check(image(`stamp-${Object.values(stamp)[0]}`, { stamp }));
      expect({ code: wrong.exitCode, out: wrong.stdout }).toEqual({ code: 1, out: expect.stringContaining("nouride-router-image.map is stamped") });
    }
  });

  test("refuses an export that is not exactly the edition's one map", async () => {
    const fake = image("two-maps");
    writeFileSync(join(fake, "maps", "nouride-image.map"), "{}");
    const two = await check(fake);
    expect({ code: two.exitCode, out: two.stdout }).toEqual({ code: 1, out: expect.stringContaining("the router image's map is nouride-router-image.map, and only it") });
  });
});
