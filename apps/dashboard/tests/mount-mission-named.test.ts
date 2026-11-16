/**
 * A mission in the strip above its chat's message box, mounted: with no step to name, it is called by its title. Its
 * goal stood there, the start of what the agent was told. In a file of its own over the shared harness
 * (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

test("the chat's strip calls a mission by its title, and by its goal only where the daemon sends no title", async () => {
  const [first] = (WIRE["/missions"] as { missions: Record<string, unknown>[] }).missions;
  const { title: _title, ...untitled } = first!;
  const here = { gatewayId: "web:dashboard", chatId: "web-1", status: "running", checklist: null };
  answer({
    "/missions": {
      status: 200,
      body: {
        missions: [
          { ...untitled, id: "msn_named", ...here, title: "The client upgrade", goal: "Move the client to the new API. Then run its tests." },
          { ...untitled, id: "msn_older", ...here, goal: "Sum up the week's mail." },
        ],
      },
    },
  });
  const said: Record<string, string> = {};
  await renderPage("/chat/ses_1", async (host) => {
    const row = (id: string) => host.querySelector<HTMLElement>(`a[href="/dashboard/missions/${id}"]`);
    await eventually(() => row("msn_named") !== null && row("msn_older") !== null, 2_000, "the strip");
    for (const id of ["msn_named", "msn_older"]) said[id] = row(id)!.textContent ?? "";
  });
  expect(said.msn_named).toContain("The client upgrade");
  expect(said.msn_named).not.toContain("Move the client to the new API");
  expect(said.msn_older).toContain("Sum up the week's mail.");
});
