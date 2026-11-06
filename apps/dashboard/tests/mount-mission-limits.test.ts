/**
 * The missions' Limits card keeps what a person typed until they save it (0.8.7). It cleared its fields whenever the
 * settings it read changed: a refetch that brought anything new — the window brought back into focus after someone
 * else saved, an agent turned on — emptied what was being typed and turned Save off. The race the card's mount tests
 * lost on a loaded machine was the same: the clearing effect of the first load ran after the test had typed. In a file
 * of its own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { act } from "react";
import { press, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

/** The card's query key (`MissionSettingsCard.tsx`). */
const KEY = ["mission-settings"];

const saveOn = (host: HTMLElement) => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Save" && !button.disabled);

test("what is typed stays, and Save stays on, when the settings are read again and have changed", async () => {
  let before = "";
  let after = "";
  let stillOn = false;
  await renderPage("/missions", async (host, app) => {
    press(host, "Limits");
    await eventually(() => host.querySelectorAll('input[type="number"]').length >= 4, 2_000, "the fields");
    const turns = () => [...host.querySelectorAll('input[type="number"]')][3] as HTMLInputElement;
    type(turns(), "20");
    await eventually(() => saveOn(host), 2_000, "Save on");
    before = turns().value;
    // A refetch that brought something new: another person set the hours to 13 meanwhile — off every default.
    app.queryClient.setQueryData(KEY, (old: Record<string, unknown> | undefined) => ({ ...old, limitHours: 13 }));
    const hours = () => [...host.querySelectorAll('input[type="number"]')][2] as HTMLInputElement;
    await eventually(() => hours().value === "13", 2_000, "the new settings drawn");
    // The effects of that render run after it is drawn: `act` runs whatever is still waiting before it returns.
    await act(async () => {});
    after = turns().value;
    stillOn = saveOn(host);
  });
  expect(before).toBe("20");
  expect(after).toBe("20");
  expect(stillOn).toBe(true);
});
