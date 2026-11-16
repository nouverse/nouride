/**
 * HTML written straight into a reply is drawn by the dashboard as an `html` block and served by the daemon as a page,
 * each by a rule of its own file: the dashboard shares no code with the daemon. The two must be the same rule. Where
 * they differ, a block the dashboard draws has a "Preview" the daemon refuses, or none at all.
 *
 * So every part of each reply here, from every place and of every length, is asked of both.
 */

import { describe, expect, test } from "bun:test";
import { isHtmlRun as dashboards } from "../../../dashboard/src/commons/lib/html-run.ts";
import { isHtmlRun as daemons } from "@/modules/web/control/html-run.ts";

const REPLIES = [
  ["Raw:", "", '<div style="a">', "  <h3>T</h3>", "</div>", "", "<table><tr><td>c</td></tr></table>", "", "Check it.", "- one"].join("\n"),
  ["<!doctype html>", "<html>", "<body>", "<script>", "a();", "", "b();", "</script>", "</body>", "</html>"].join("\n"),
  ['<img src="a.png">', "", "<b>Note:</b> a sentence.", "", "<your-name>", "", "</div>", "", "<br>"].join("\n"),
  ["```js", "<div>x</div>", "```", "<p>after</p>", "", "```html", "<p>in</p>", "```", "", "<ul>", "<li>a</li>", "</ul>"].join("\n"),
  ["<style>", "p { color: red }", "", "</style>", "", "<details>", "<summary>More</summary>", "", "</details>", "", "Done."].join("\n"),
  ["Text <div> in a line", "    <div>set in</div>", "<svg viewBox='0 0 1 1'>", "<path d='M0 0'/>", "</svg>", "", "<!-- note -->", "<pre>", "", "x", "</pre>"].join("\n"),
];

describe("a run of HTML in a reply, as the dashboard reads it and as the daemon does", () => {
  test("every part of every reply is a run to both, or to neither", () => {
    let runs = 0;
    for (const reply of REPLIES) {
      const differ: string[] = [];
      let found = 0;
      for (let at = 0; at <= reply.length; at++) {
        for (let length = 0; at + length <= reply.length + 1; length++) {
          const [one, other] = [dashboards(reply, at, length), daemons(reply, at, length)];
          if (one !== other) differ.push(`${at},${length}: the dashboard ${one}, the daemon ${other}`);
          if (one) found++;
        }
      }
      expect(differ, reply).toEqual([]);
      // Each reply holds runs: a rule that found none in either would agree on nothing.
      expect(found, reply).toBeGreaterThan(0);
      runs += found;
    }
    expect(runs).toBeGreaterThan(REPLIES.length);
  });
});
