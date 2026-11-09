/**
 * The public image's kit: the Dockerfile `nouverse/nouride` builds from is this repository's runtime stages, pointed
 * at the kit's files — never a second copy that could drift. Held here against the real Dockerfile, so a package added
 * to the image, a changed CMD or a new `COPY` either reaches the kit or stops the release.
 *
 * One kit, the free edition's: it carries the LLM gateway, as the Router image it replaced did, and Router's image is
 * the free one with a line added (`router-image.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kitDockerfile, kitFrontend, kitName } from "../../../../scripts/release/image-kit.ts";
import { NOUGATE } from "../../../../scripts/build/edition.ts";

const ROOT = join(import.meta.dir, "../../../..");
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");

/** The instructions of a stage, as written, minus comments and blank lines. */
function stage(text: string, name: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^FROM .* AS ${name}$`).test(line));
  const end = lines.findIndex((line, at) => at > start && line.startsWith("FROM "));
  return lines.slice(start, end < 0 ? undefined : end).filter((line) => line.trim() && !line.startsWith("#"));
}

describe("the kit's Dockerfile", () => {
  test("the runtime stages as the image has them, every COPY from the kit, only its own edition", () => {
    const kit = kitDockerfile(DOCKERFILE, "basic");
    expect(kit).not.toContain("--from=");
    expect(kit).toContain("ARG EDITION=basic");
    expect(kit).not.toContain("AS edition-pro");
    // What the image runs and what it installs are the main Dockerfile's, line for line.
    const strip = (lines: string[]) => lines.filter((line) => !line.startsWith("COPY "));
    expect(strip(stage(kit, "runtime-base"))).toEqual(strip(stage(DOCKERFILE, "runtime-base")));
    expect(strip(stage(kit, "edition-basic"))).toEqual(strip(stage(DOCKERFILE, "edition-basic")));
    expect(stage(kit, "runtime")).toEqual(stage(DOCKERFILE, "runtime"));
    // As many COPY lines as the image has, each to the same destination.
    const dest = (lines: string[]) => lines.filter((line) => line.startsWith("COPY ")).map((line) => line.split(" ").at(-1));
    expect(dest(stage(kit, "runtime-base"))).toEqual(dest(stage(DOCKERFILE, "runtime-base")));
  });

  test("the free image carries the gateway's frontend and port, and there is no Router stage to build", () => {
    const basic = stage(kitDockerfile(DOCKERFILE, "basic"), "edition-basic");
    expect(basic).toContain("COPY frontend /usr/local/bin/frontend");
    expect(basic).toContain("EXPOSE 18256");
    expect(DOCKERFILE).not.toContain("AS edition-router");
    expect(DOCKERFILE).not.toContain('FLAG="--router"');
  });

  test("a COPY from a build stage it cannot place stops the kit, rather than leave a file out of the image", () => {
    const changed = DOCKERFILE.replace("COPY config.example.toml ./", "COPY config.example.toml ./\nCOPY --from=engine-builder /app/dist/extra /app/extra");
    expect(() => kitDockerfile(changed, "basic")).toThrow("no kit file for");
  });

  test("its file name is the one the public workflow downloads", () => {
    expect(kitName("basic")).toBe("nouride-image-kit.tar.gz");
    expect(readFileSync(join(ROOT, ".github/workflows/public-release.yml"), "utf8")).toContain("kit=nouride-image-kit.tar.gz");
  });
});

describe("the kit's frontend", () => {
  const carrying = `var a=1;const db="${NOUGATE.marker}";`;

  test("is the gateway's built frontend when the bundle carries the gateway, and that is required", () => {
    expect(kitFrontend(carrying, true)).toBe("copy");
    expect(() => kitFrontend(carrying, false)).toThrow("the bundle carries the LLM gateway, and its frontend is not built");
  });

  test("is an empty directory for a bundle built without it, which the image's COPY still takes", () => {
    expect(kitFrontend("var a=1;", false)).toBe("empty");
    expect(kitFrontend("var a=1;", true)).toBe("empty");
  });
});
