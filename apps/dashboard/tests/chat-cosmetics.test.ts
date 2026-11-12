/**
 * Two things a person reads in a conversation and saw break (2026-10-20): a long URL in their own message ran out of its
 * bubble, and the Reasoning toggle drew a focus ring the width of the whole step card after a click.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (file: string) => readFileSync(join(import.meta.dir, "../src", file), "utf8");

test("a person's own message breaks a long word or URL instead of running out of its bubble", () => {
  const bubble = source("commons/components/chat/Turn.tsx").split("\n").find((line) => line.includes("rounded-tr-xs bg-secondary/20"));
  expect(bubble).toContain("[overflow-wrap:anywhere]");
});

test("the Reasoning toggle is as wide as its word, and only a keyboard focus draws a ring", () => {
  const summary = source("commons/components/turns/Steps.tsx").split("\n").find((line) => line.includes("<summary") && line.includes("text-primary/80"));
  expect(summary).toContain("w-fit");
  expect(summary).toContain("outline-none");
  expect(summary).toContain("focus-visible:");
});
