/**
 * `plainLine`: an agent's Markdown as the words of one line, for a row that draws none.
 */

import { expect, test } from "bun:test";
import { plainLine } from "@/commons/lib/markdown/plain";

test("the marks are taken out and the words kept", () => {
  // As a run's result read on the box's own page.
  expect(plainLine("**Daily Server Report, 2026-11-22 07:00 WIB** **Status:** all `ok`")).toBe("Daily Server Report, 2026-11-22 07:00 WIB Status: all ok");
  expect(plainLine("__bold__, *leaning*, ~~gone~~ and `code`")).toBe("bold, leaning, gone and code");
  expect(plainLine("## Report\n\n- one\n- two\n\n> said")).toBe("Report one two said");
  expect(plainLine("see [the page](https://shop.example.com/a) and ![a chart](https://shop.example.com/c.png \"title\")")).toBe("see the page and a chart");
  expect(plainLine("```sh\ncurl -sf https://shop.example.com\n```\ndone")).toBe("curl -sf https://shop.example.com done");
});

test("what is no mark is left as written", () => {
  expect(plainLine("2 * 3 * 4 is 24")).toBe("2 * 3 * 4 is 24");
  expect(plainLine("see my_file_name.txt and snake_case")).toBe("see my_file_name.txt and snake_case");
  expect(plainLine("a*b*c")).toBe("a*b*c");
  expect(plainLine("step 1 of 4 had nothing to say")).toBe("step 1 of 4 had nothing to say");
  expect(plainLine("")).toBe("");
});

test("a mark the cut left open is taken out too, and the lines become one", () => {
  expect(plainLine("**Daily report** **Stat…")).toBe("Daily report Stat…");
  expect(plainLine("first line\n\n  second   line\n")).toBe("first line second line");
});
