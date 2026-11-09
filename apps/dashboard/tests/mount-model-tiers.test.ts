/**
 * The install's model tiers and each helper's, on the Models page: a button in its header that opens them in a dialog.
 * As a panel between the tabs and the providers they pushed the list down and broke its scroll; they are the page's
 * setting, not its content. An agent's own pair is on its Model tab (mount.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { answer, dom, errors, press, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const dialog = () => dom.document.body.querySelector('[role="dialog"][aria-label="Model tiers"]');

describe("model tiers on the Models page", () => {
  test("a header button opens them in a dialog with every helper's setting, and the page itself holds none of it", async () => {
    answer({});
    let page = "";
    let models = "";
    await renderPage("/models", async (host) => {
      await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Model tiers"), 2_000, "the button");
      page = text(host.innerHTML);
      press(host, "Model tiers");
      await eventually(() => dialog() !== null, 2_000, "the dialog");
      models = text(dialog()!.innerHTML);
    });
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(page).not.toContain("all three are the default model");
    expect(page).not.toContain("What each helper runs on");
    expect(models).toContain("Model tiers");
    expect(models).toContain("all three are the default model");
    for (const helper of ["[llm.context] summary_model", "[memory] pass_model", "[queue] steer_reply_model", "[media] image_model", "[skills.learning] model"]) {
      expect(models).toContain(helper);
    }
    expect(models).toContain("Small tier (the cheapest)");
    expect(models).toContain("High tier (the strongest)");
  });
});
