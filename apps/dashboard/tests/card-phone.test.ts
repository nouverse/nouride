/**
 * A card's header on a phone (0.8.12). A mission's Brief, folded: "Named in its goal: /srv/nouride/.nouride/workspace/…/
 * BRIEF.md" ran past the card's edge and under the BRIEF.md button beside it on the owner's iPhone. A description breaks
 * anywhere it has to, and a folded card's title takes 16rem before its actions sit beside it — so on a phone they go under.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Card } from "@/commons/components/ui/ui";

const path = "Named in its goal: /srv/nouride/.nouride/workspace/private/nix/scratch/mg-skill-eval/BRIEF.md";
const draw = (folded: boolean) =>
  renderToString(
    createElement(Card, {
      title: "Brief",
      description: path,
      actions: createElement("button", { type: "button" }, "BRIEF.md"),
      ...(folded ? { folded: { open: false, toggle: () => {} } } : {}),
      children: "the brief",
    }),
  );

describe("a card's header", () => {
  test("breaks a long path inside the card, folded or not", () => {
    for (const html of [draw(true), draw(false)]) {
      expect(html).toMatch(/<p class="[^"]*\[overflow-wrap:anywhere\][^"]*">Named in its goal/);
    }
  });

  test("folded, its title holds 16rem before the actions share its line", () => {
    expect(draw(true)).toMatch(/<button type="button" class="[^"]*flex-\[1_1_16rem\][^"]*" aria-expanded="false"/);
  });
});
