/**
 * An agent's Settings page, where it follows the default for helpers in the background and nobody set that default:
 * the number is what the server has room for, and the page says so. "It tracks changes to it" pointed at a setting
 * nobody had made.
 */

import { describe, expect, test } from "bun:test";
import { answer, errors, renderPage, useMountHarness } from "./mount-harness.ts";

useMountHarness();

const settingsWith = async (policy: Record<string, unknown>) => {
  answer({ "/policy/delegate": { status: 200, body: { max: 4, editable: true, ...policy } } });
  const text = (await renderPage("/agents/nouva/settings")).replace(/<[^>]*>/g, "");
  expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
  return text;
};

describe("helpers in the background, following the default", () => {
  test("a default nobody set is said as what the server has room for", async () => {
    const settings = await settingsWith({ maxBackground: 3, auto: true });
    expect(settings).toContain("Follows the default (currently 3, what this server has room for)");
    expect(settings).toContain("Up to 3 at once: one for a task that takes a while, more only for independent pieces.");
  });

  test("a default somebody set is said as one that can change", async () => {
    const settings = await settingsWith({ maxBackground: 2, auto: false });
    expect(settings).toContain("Follows the default (currently 2, and it tracks changes to it)");
    // And one set to 0 is off, whoever set it.
    expect(await settingsWith({ maxBackground: 0, auto: false })).toContain("Follows the default (currently off, and it tracks changes to it)");
  });
});
