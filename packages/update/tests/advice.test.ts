/**
 * What an install with no published build for its platform is told to build. Every command it is given has to work:
 * the build refuses `--router` by name, since the free build carries the gateway that flag added, so a Router install
 * is told to build the free one — under the free build's name — and to install it with `--variant router`, which
 * switches the gateway on.
 */

import { describe, expect, test } from "bun:test";
import { buildFromSource } from "../src/advice.ts";

describe("building from source", () => {
  test("the free build takes no edition flag, and a Router install builds it too, never `--router`", () => {
    expect(buildFromSource("basic", "darwin-x64")).toEqual([
      "build it from source: bun run build:binary --target darwin-x64",
      "then: sh scripts/install.sh --tarball dist/nouride-darwin-x64.tar.gz",
    ]);
    expect(buildFromSource("router", "darwin-x64")).toEqual([
      "build it from source: bun run build:binary --target darwin-x64",
      "then: sh scripts/install.sh --tarball dist/nouride-darwin-x64.tar.gz --variant router",
    ]);
  });

  test("Pro is built by its own entry point, with its flag, under its own name", () => {
    expect(buildFromSource("pro", "darwin-x64")).toEqual([
      "build it from source: bun run build:pro --pro --target darwin-x64",
      "then: sh scripts/install.sh --tarball dist/nouride-pro-darwin-x64.tar.gz --variant pro",
    ]);
  });
});
