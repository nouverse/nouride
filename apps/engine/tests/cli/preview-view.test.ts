/**
 * An approval's edit in the terminal (`renderPreview`): a line taken out red, put in green — and a kept line a persona
 * change shows (0.8.13), what a reworded rule now covers, dim: green read it as put in.
 */

import { expect, test } from "bun:test";
import { renderPreview } from "@/cli/preview-view.ts";

test("a kept line of a persona change is dim, neither red nor green", () => {
  const lines = renderPreview(
    {
      kind: "edit",
      path: "SOUL.md",
      added: 1,
      removed: 1,
      hunk: [
        { sign: "-", text: "[# SOUL] - Ask before deleting" },
        { sign: "+", text: "[# SOUL] - Free to delete" },
        { sign: " ", text: "  anything in /home." },
      ],
      clipped: false,
    },
    {},
  );
  expect(lines).toContain("  \x1b[31m- [# SOUL] - Ask before deleting\x1b[0m");
  expect(lines).toContain("  \x1b[32m+ [# SOUL] - Free to delete\x1b[0m");
  expect(lines).toContain("  \x1b[90m    anything in /home.\x1b[0m");
});
