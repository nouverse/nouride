/**
 * The public images' kit (0.7.20): the Dockerfile `nouverse/nouride` builds from is this repository's runtime
 * stages, pointed at the kit's files — never a second copy that could drift. Held here against the real Dockerfile, so
 * a package added to the image, a changed CMD or a new `COPY` either reaches the kit or stops the release.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kitDockerfile, kitName } from "../../../../scripts/release/image-kit.ts";

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
  for (const edition of ["basic", "router"] as const) {
    test(`${edition}: the runtime stages as the image has them, every COPY from the kit, only its own edition`, () => {
      const kit = kitDockerfile(DOCKERFILE, edition);
      expect(kit).not.toContain("--from=");
      expect(kit).toContain(`ARG EDITION=${edition}`);
      const others = ["basic", "router", "pro"].filter((other) => other !== edition);
      for (const other of others) expect(kit).not.toContain(`AS edition-${other}`);
      // What the image runs and what it installs are the main Dockerfile's, line for line.
      const strip = (lines: string[]) => lines.filter((line) => !line.startsWith("COPY "));
      expect(strip(stage(kit, "runtime-base"))).toEqual(strip(stage(DOCKERFILE, "runtime-base")));
      expect(strip(stage(kit, `edition-${edition}`))).toEqual(strip(stage(DOCKERFILE, `edition-${edition}`)));
      expect(stage(kit, "runtime")).toEqual(stage(DOCKERFILE, "runtime"));
      // As many COPY lines as the image has, each to the same destination.
      const dest = (lines: string[]) => lines.filter((line) => line.startsWith("COPY ")).map((line) => line.split(" ").at(-1));
      expect(dest(stage(kit, "runtime-base"))).toEqual(dest(stage(DOCKERFILE, "runtime-base")));
    });
  }

  test("a COPY from a build stage it cannot place stops the kit, rather than leave a file out of the image", () => {
    const changed = DOCKERFILE.replace("COPY config.example.toml ./", "COPY config.example.toml ./\nCOPY --from=engine-builder /app/dist/extra /app/extra");
    expect(() => kitDockerfile(changed, "basic")).toThrow("no kit file for");
  });

  test("its file names are the ones the public workflow downloads", () => {
    expect(kitName("basic")).toBe("nouride-image-kit.tar.gz");
    expect(kitName("router")).toBe("nouride-image-kit-router.tar.gz");
  });
});
