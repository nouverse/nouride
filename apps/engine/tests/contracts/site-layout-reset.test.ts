/**
 * A page outside the docs carries its own reset.
 *
 * The landing page is written against `box-sizing: border-box` and no default margins. The build gave it both by
 * accident, through a stylesheet shared with Starlight; the dev server did not, so the page looked right once deployed
 * and wrong while it was being worked on: a padded card was its padding taller and ran into the row below.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const layout = readFileSync(join(import.meta.dir, "../../../site/src/layouts/Site.astro"), "utf8");
const global = /<style is:global>([\s\S]*?)<\/style>/.exec(layout)?.[1] ?? "";

test("the layout sets the box model and clears margins itself, in a layer a page's own rules win over", () => {
  const reset = /@layer reset \{([\s\S]*?)\n  \}/.exec(global)?.[1] ?? "";
  expect(reset).toMatch(/\*,\s*::before,\s*::after \{\s*box-sizing: border-box;/);
  expect(reset).toMatch(/\* \{\s*margin: 0;/);
});
