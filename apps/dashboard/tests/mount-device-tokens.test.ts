/**
 * The devices that stay signed in, on Users (`users/components/DeviceTokens.tsx`): an admin sees each device token,
 * who it signs in as and when it last did, and revokes one once asked; nothing on the page makes one.
 */

import { describe, expect, test } from "bun:test";
import { answer, dom, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const DEVICE = { id: "dev_1", label: "Nouride Home on the Mac", userId: "usr_1", username: "gading", createdAt: 1_760_000_000_000, lastUsedAt: null };

function recordDeletes() {
  const deletes: string[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    if (init?.method !== "DELETE") return (spy as typeof fetch)(input as RequestInfo, init);
    deletes.push(new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost").pathname.replace(/^\/api\/control/, ""));
    return Promise.resolve(new Response(JSON.stringify({ id: "dev_1", revoked: true }), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { deletes, restore: () => void (globalThis.fetch = spy) };
}

describe("devices that stay signed in", () => {
  test("listed with who each signs in as, revoked once confirmed, and none made from here", async () => {
    answer({ "/auth/devices": { status: 200, body: { devices: [DEVICE] } } });
    const recorded = recordDeletes();
    const seen = { row: "", asked: "", offersMaking: true };
    try {
      await renderPage("/users", async (host) => {
        await eventually(() => host.querySelector('[data-device="dev_1"]') !== null, 3_000, "the device");
        const row = host.querySelector('[data-device="dev_1"]')!;
        seen.row = row.textContent ?? "";
        seen.offersMaking = [...host.querySelectorAll("button")].some((button) => /new device|add device|make/i.test(button.textContent ?? ""));
        const dialog = () => dom.document.body.querySelector("dialog[open]");
        const inDialog = (label: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === label);
        const confirm = () => inDialog("Revoke");
        const press = async () => {
          [...row.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Revoke")!.click();
          await eventually(() => confirm() !== undefined, 2_000, "the question");
        };
        // Cancelled first: nothing is revoked, so the one revoke below is the only one sent.
        await press();
        inDialog("Cancel")!.click();
        await eventually(() => dialog() === null, 2_000, "the question closed");
        await press();
        seen.asked = dialog()?.textContent ?? "";
        confirm()!.click();
        await eventually(() => recorded.deletes.length > 0, 2_000, "the revoke");
      });
    } finally {
      recorded.restore();
    }
    expect(seen.row).toContain("Nouride Home on the Mac");
    expect(seen.row).toContain("Signs in as gading");
    expect(seen.row).toContain("not used yet");
    expect(seen.asked).toContain("Revoke Nouride Home on the Mac?");
    expect(seen.offersMaking).toBe(false);
    expect(recorded.deletes).toEqual(["/auth/devices/dev_1"]);
  });

  test("with none, it says one is added from the machine itself", async () => {
    answer({ "/auth/devices": { status: 200, body: { devices: [] } } });
    let said = "";
    await renderPage("/users", async (host) => {
      await eventually(() => host.querySelector('[data-devices="none"]') !== null, 3_000, "the empty list");
      said = host.querySelector('[data-devices="none"]')!.textContent ?? "";
    });
    expect(said).toContain("added from the machine Nouride runs on, never from here");
  });
});
