/**
 * A password a person types can be seen before it is saved (0.8.23): making the admin on the first visit, the owner
 * could not check the password, as no field had an eye. Each field has its own, hidden until pressed and hidden again by
 * the same button, the text kept; the button does not submit the form. In a file of its own over the shared harness.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

/** Each password field's type and its eye's name, in the page's order. */
const fields = (host: HTMLElement) =>
  [...host.querySelectorAll("button[aria-pressed]")]
    .filter((button) => /password/i.test(button.getAttribute("aria-label") ?? ""))
    .map((button) => ({ button: button as HTMLButtonElement, input: button.parentElement!.querySelector("input")! }));

describe("an eye on every password a person types", () => {
  test("the first visit: the new password and its confirmation, each with its own eye", async () => {
    const seen: Record<string, unknown> = {};
    await renderPage("/welcome", async (host) => {
      await eventually(() => fields(host).length === 2, 2_000, "two password fields with an eye");
      const [first, second] = fields(host);
      type(first!.input, "correct horse battery");
      seen.before = [first!.input.type, first!.button.getAttribute("aria-label"), first!.button.getAttribute("aria-pressed")];
      first!.button.click();
      await eventually(() => first!.input.type === "text", 2_000, "shown");
      seen.shown = [first!.input.type, first!.button.getAttribute("aria-label"), first!.button.getAttribute("aria-pressed"), first!.input.value];
      // Its own eye: the confirmation stays hidden.
      seen.other = second!.input.type;
      seen.submits = first!.button.type;
      first!.button.click();
      await eventually(() => first!.input.type === "password", 2_000, "hidden again");
      seen.hidden = [first!.input.type, first!.input.value];
    });
    expect(seen.before).toEqual(["password", "Show password", "false"]);
    expect(seen.shown).toEqual(["text", "Hide password", "true", "correct horse battery"]);
    expect(seen.other).toBe("password");
    expect(seen.submits).toBe("button");
    expect(seen.hidden).toEqual(["password", "correct horse battery"]);
  });

  test("signing in, and changing one's password, have the eye too", async () => {
    let login = 0;
    let account = 0;
    // Signed out, as the sign-in page is seen.
    answer({ "/auth/me": { status: 401, body: { error: "unauthorized" } } });
    await renderPage("/login", async (host) => {
      await eventually(() => fields(host).length > 0, 2_000, "the sign-in's password");
      login = fields(host).length;
    });
    answer({});
    await renderPage("/account", async (host) => {
      await eventually(() => fields(host).length === 3, 2_000, "the account's three passwords");
      account = fields(host).length;
    });
    expect(login).toBe(1);
    expect(account).toBe(3);
  });
});
