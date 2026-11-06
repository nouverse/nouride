/**
 * The Files tab's Save after a save (0.8.8). A save wrote the file and left the editor holding what was opened, so the
 * button stayed enabled, "Unsaved changes" stayed on, and a second save went out with a stale base and met the 409
 * that stops a stale tab from undoing a write. In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, enabled, press, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const FILE = "/agents/nouva/files/SOUL.md";

/** One file on a stand-in daemon that refuses a write whose base is not what the file holds, as `routes/files.ts` does. */
function onDisk(initial: string) {
  const disk = { content: initial, writes: [] as { content: string; expected?: string; status: number }[] };
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    if (new URL(url, "http://localhost").pathname !== `/api/control${FILE}`) return (spy as typeof fetch)(input as RequestInfo, init);
    const reply = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    if (init?.method !== "POST") return reply(200, { content: disk.content });
    const body = JSON.parse(String(init.body)) as { content: string; expected?: string };
    // No base, no check — the route's own rule, so a save that stopped sending one would be taken here too.
    const status = body.expected === undefined || body.expected === disk.content ? 200 : 409;
    disk.writes.push({ ...body, status });
    if (status === 409) return reply(409, { error: "SOUL.md changed since it was opened" });
    disk.content = body.content;
    return reply(200, { ok: true });
  }) as typeof fetch;
  return { disk, restore: () => void (globalThis.fetch = spy) };
}

const fileList = {
  "/agents/nouva/files": {
    status: 200,
    body: { files: [{ name: "SOUL.md", label: "Soul", description: "Who the agent is", exists: true, bytes: 4, modifiedAt: 0 }] },
  },
};

const saveButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save File") as HTMLButtonElement;

test("a successful save disables Save and clears the badge at once, and the next save goes out on the saved text", async () => {
  answer(fileList);
  const server = onDisk("old\n");
  try {
    await renderPage("/agents/nouva", async (host) => {
      await eventually(() => host.textContent?.includes("SOUL.md") === true, 2_000, "the file list");
      press(host, "SOUL.md");
      await eventually(() => host.querySelector("textarea")?.value === "old\n", 2_000, "the file opened");

      type(host.querySelector("textarea") as HTMLTextAreaElement, "new\n");
      await enabled(host, "Save File");
      expect(host.textContent).toContain("Unsaved changes");
      press(host, "Save File");
      await eventually(() => server.disk.writes.length === 1, 2_000, "the save");
      await eventually(() => saveButton(host).disabled, 2_000, "Save disabled after the save");
      expect(host.textContent).not.toContain("Unsaved changes");
      expect(host.querySelector("[role=alert]")).toBeNull();

      // Edited again, the next save's base is the text just saved — so the daemon takes it rather than a 409.
      type(host.querySelector("textarea") as HTMLTextAreaElement, "newer\n");
      await enabled(host, "Save File");
      press(host, "Save File");
      await eventually(() => server.disk.writes.length === 2, 2_000, "the second save");
      await eventually(() => saveButton(host).disabled, 2_000, "Save disabled after the second save");
      expect(host.querySelector("[role=alert]")).toBeNull();
    });
  } finally {
    server.restore();
  }
  expect(server.disk.writes).toEqual([
    { content: "new\n", expected: "old\n", status: 200 },
    { content: "newer\n", expected: "new\n", status: 200 },
  ]);
  expect(server.disk.content).toBe("newer\n");
});

test("a file changed under an open tab is still refused with a 409, and the edit stays unsaved", async () => {
  answer(fileList);
  const server = onDisk("old\n");
  try {
    await renderPage("/agents/nouva", async (host) => {
      await eventually(() => host.textContent?.includes("SOUL.md") === true, 2_000, "the file list");
      press(host, "SOUL.md");
      await eventually(() => host.querySelector("textarea")?.value === "old\n", 2_000, "the file opened");

      // The agent writes the file meanwhile.
      server.disk.content = "written by the agent\n";
      type(host.querySelector("textarea") as HTMLTextAreaElement, "mine\n");
      await enabled(host, "Save File");
      press(host, "Save File");
      await eventually(() => host.querySelector("[role=alert]")?.textContent?.includes("changed since it was opened") === true, 2_000, "the refusal");
      expect(saveButton(host).disabled).toBe(false);
      expect(host.textContent).toContain("Unsaved changes");
      expect(host.querySelector("textarea")?.value).toBe("mine\n");
    });
  } finally {
    server.restore();
  }
  expect(server.disk.writes).toEqual([{ content: "mine\n", expected: "old\n", status: 409 }]);
  expect(server.disk.content).toBe("written by the agent\n");
});
