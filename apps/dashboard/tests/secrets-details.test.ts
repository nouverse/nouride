/**
 * The Secrets page's 0.8.19 parts, in plain words for people who are not technical: a secret's details (free fields)
 * shown in its row and changed in place as one change; a new secret asked for its site and account; the backup
 * password set from the page, asked twice and never sent back; and how the secrets are kept, said by how far the key is.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "HTMLInputElement", "Event", "InputEvent"] as const;
let dom: Window;
let realFetch: typeof fetch;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/secrets" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** What a person sees: words a non-technical reader would trip on are not on these parts. */
const TECHNICAL = /daemon|snapshot|seal|passphrase|config|environment|route|gateway|nouride secret|--stdin|\.env|encryption\.key/i;

async function mountTo(element: unknown) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(React.createElement(QueryClientProvider, { client }, element as never));
  return { host, unmount: () => root.unmount() };
}

/** Types into a controlled input as a person does: the value set, then the event React listens for. */
function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as never);
}

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) as HTMLButtonElement | undefined;

describe("a secret's details", () => {
  test("rows as one change: changed and new texts set, emptied and removed names removed, unchanged left out", async () => {
    const { changeFrom } = await import("@/modules/secrets/components/FieldsEditor");
    expect(
      changeFrom({ site: "github.com", username: "old", note: "x" }, [
        { name: "site", text: "github.com" },
        { name: "username", text: "nouva-bot" },
        { name: "used for", text: "the release upload" },
        { name: "note", text: "" },
      ]),
    ).toEqual({ set: { username: "nouva-bot", "used for": "the release upload" }, remove: ["note"] });
  });

  test("shown in the row, changed in place, saved as that change; the value is never on the page", async () => {
    const React = await import("react");
    const { SecretRow } = await import("@/modules/secrets/components/SecretRow");
    const saved: unknown[] = [];
    const entry = { name: "github_token", origin: "store", usedBy: ["gateway telegram:main"], shadowed: false, fields: { site: "github.com" }, addedAt: "2026-11-05T00:00:00Z", addedBy: "agent:nouva" };
    const { host, unmount } = await mountTo(
      React.createElement(SecretRow, { entry: entry as never, admin: true, busy: false, onReplace: () => {}, onDelete: () => {}, onSaveFields: async (change: unknown) => (saved.push(change), true) }),
    );
    try {
      await eventually(() => (host.textContent ?? "").includes("site:"));
      expect(host.textContent).toContain("github.com");
      expect(host.textContent).toContain("Needed by connection telegram:main");
      expect(host.textContent).toContain("by nouva");
      button(host, "Details")?.click();
      await eventually(() => host.querySelectorAll("input").length >= 2);
      expect(host.textContent).toContain("Never put a password in one");
      const inputs = [...host.querySelectorAll("input")] as HTMLInputElement[];
      type(inputs[1] as HTMLInputElement, "gitlab.com");
      button(host, "Save details")?.click();
      await eventually(() => saved.length === 1);
      expect(saved[0]).toEqual({ set: { site: "gitlab.com" }, remove: [] });
      expect(host.textContent ?? "").not.toMatch(TECHNICAL);
    } finally {
      unmount();
    }
  });
});

describe("the backup password", () => {
  function serve(sealed: boolean) {
    const posted: { path: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (init?.method === "POST") {
        posted.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
        return json({ ok: true, sealedInSnapshots: true, snapshot: "/b/config/2026" });
      }
      return json({ secrets: [], sealedInSnapshots: sealed });
    }) as typeof fetch;
    return { posted };
  }

  test("not set: said plainly; set from the page, asked twice, at least twelve characters, sent once", async () => {
    const React = await import("react");
    const { BackupPasswordCard } = await import("@/modules/secrets/components/BackupPasswordCard");
    const { posted } = serve(false);
    const { host, unmount } = await mountTo(React.createElement(BackupPasswordCard, { sealed: false, admin: true, onTurnOff: async () => true }));
    try {
      await eventually(() => (host.textContent ?? "").includes("Backup password"));
      expect(host.textContent).toContain("Without one, your backups do not include your secrets");
      button(host, "Set a backup password")?.click();
      await eventually(() => host.querySelectorAll('input[type="password"]').length === 2);
      expect(host.textContent).toContain("nobody can recover it for you");
      const [first, again] = [...host.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
      type(first as HTMLInputElement, "too short");
      await eventually(() => (host.textContent ?? "").includes("At least 12 characters."));
      type(first as HTMLInputElement, "a long walk to the river");
      type(again as HTMLInputElement, "a long walk to the sea");
      await eventually(() => (host.textContent ?? "").includes("The two do not match."));
      expect(button(host, "Save backup password")?.disabled).toBe(true);
      type(again as HTMLInputElement, "a long walk to the river");
      await eventually(() => button(host, "Save backup password")?.disabled === false);
      button(host, "Save backup password")?.click();
      await eventually(() => posted.length === 1);
      expect(posted[0]).toEqual({ path: "/api/control/secrets/seal", body: { passphrase: "a long walk to the river" } });
      await eventually(() => (host.textContent ?? "").includes("Backup password set."));
      expect(host.textContent).not.toContain("a long walk to the river");
      expect(host.textContent ?? "").not.toMatch(TECHNICAL);
    } finally {
      unmount();
    }
  });

  test("set: turned off after the person says yes; a viewer is told only an admin can change it", async () => {
    const React = await import("react");
    const { BackupPasswordCard } = await import("@/modules/secrets/components/BackupPasswordCard");
    const { posted } = serve(true);
    const admin = await mountTo(React.createElement(BackupPasswordCard, { sealed: true, admin: true, onTurnOff: async () => true }));
    try {
      await eventually(() => (admin.host.textContent ?? "").includes("locked with this password"));
      button(admin.host, "Turn off")?.click();
      await eventually(() => posted.length === 1);
      expect(posted[0]?.body).toEqual({ off: true });
    } finally {
      admin.unmount();
    }
    const viewer = await mountTo(React.createElement(BackupPasswordCard, { sealed: true, admin: false, onTurnOff: async () => true }));
    try {
      await eventually(() => (viewer.host.textContent ?? "").includes("Only an admin can change this."));
      expect(button(viewer.host, "Change it")).toBeUndefined();
    } finally {
      viewer.unmount();
    }
  });
});

describe("how the secrets are kept", () => {
  test("said by how far the key is, and the one worth acting on marked so", async () => {
    const { lockWords } = await import("@/modules/secrets/components/LockNote");
    expect(lockWords({ encrypted: true, key: { where: "/etc/nouride/nouride.env", level: "outside" } })).toEqual({ text: "Your secrets are saved locked, and the key that opens them is kept apart from them.", warn: false });
    expect(lockWords({ encrypted: true, key: { where: "/srv/nouride/.env", level: "install" } }).text).toContain("moves somewhere safer the next time Nouride is installed again");
    expect(lockWords({ encrypted: true, key: { where: "/app/.nouride/encryption.key", level: "data" } })).toMatchObject({ warn: true });
    expect(lockWords({ encrypted: false }).text).toBe("Your secrets will be locked a few minutes after this update finishes.");
    for (const lock of [{ encrypted: true, key: { where: "/x", level: "outside" as const } }, { encrypted: true, key: { where: "/x", level: "install" as const } }, { encrypted: true, key: { where: "/x", level: "data" as const } }, { encrypted: false }]) {
      expect(lockWords(lock).text).not.toMatch(TECHNICAL);
      expect(lockWords(lock).text).not.toContain("/x");
    }
  });
});
