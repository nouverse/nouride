/**
 * A second WhatsApp number through the control API: saved as the first was, and paired by its own code.
 *
 * `POST /gateways` with the real settings writer on a real `config.toml`, then `GET /gateways/:id/pairing` for each
 * number over the real adapter on a stand-in bridge. A daemon held one number before: what is held here is that
 * the second is saved with a key and a login folder of its own, and that each number's code and link are its own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { WhatsAppGateway, type BridgeChannel } from "@nouride/gateways";
import { SecretStore } from "@nouride/secrets";
import { BRIDGE_PROTOCOL_VERSION, type BridgeEvent, type Gateway, type GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { registerGatewayRoutes } from "@/modules/web/control/routes/gateways.ts";
import { eventually } from "../wait.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;
let secrets: SecretStore;
let control: Hono<{ Variables: { principal: unknown } }>;
const gateways = new Map<string, Gateway>();
const started: WhatsAppGateway[] = [];
const audited: unknown[] = [];
let role = "admin";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-whatsapp-routes-"));
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, `[daemon]\nname = "nouride"\ndata_dir = "${dir}"\n`);
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [];
  secrets = await SecretStore.open(dir, {});
  const settings = new SettingsService({ config, configPath, secrets, providers: new ProviderRegistry(config.providers, secrets), gatewayStatus: () => new Map() });
  control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: role, role, user: { id: `usr_${role}`, username: role } });
    await next();
  });
  registerGatewayRoutes(control as never, { ctx: { config, gateways }, settings, audit: { record: (row: unknown) => audited.push(row) } } as never);
});

afterEach(async () => {
  for (const gateway of started.splice(0)) await gateway.stop();
  gateways.clear();
  audited.length = 0;
  role = "admin";
  rmSync(dir, { recursive: true, force: true });
});

const post = async (body: unknown) => {
  const res = await control.request("/gateways", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const pairing = async (id: string) => {
  const res = await control.request(`/gateways/${encodeURIComponent(id)}/pairing`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** A bridge a test speaks for: what it says is read by the adapter as the bridge's events. */
function standInBridge() {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const channel: BridgeChannel = {
    writeLine: () => {},
    async *lines() {
      while (!done || queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) yield next;
        else if (!done) await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    close: () => {
      done = true;
      wake?.();
      markClosed();
    },
    closed,
  };
  const says = (event: BridgeEvent) => {
    queue.push(JSON.stringify(event));
    const fn = wake;
    wake = null;
    fn?.();
  };
  return { channel, says };
}

/**
 * A number's adapter as the daemon builds it from the saved connection. Each start of its bridge is a bridge of its
 * own, as a process is, and what the test says goes to the newest.
 */
async function running(id: string) {
  const saved = config.gateways.find((gateway) => gateway.id === id)!;
  const bridges: ReturnType<typeof standInBridge>[] = [];
  const openChannel = () => {
    const bridge = standInBridge();
    bridges.push(bridge);
    return bridge.channel;
  };
  const gateway = new WhatsAppGateway({ id, platform: "whatsapp", sessionDir: saved.sessionDir!, encryptionKey: (await secrets.resolve(saved.encryptionKeySecret!))!, agentId: saved.agent!, openChannel, logoutCheckMs: 10 });
  started.push(gateway);
  gateways.set(id, gateway as unknown as Gateway);
  await gateway.start();
  return { gateway, says: (event: BridgeEvent) => bridges.at(-1)!.says(event), opened: () => bridges.length };
}

describe("a second WhatsApp number", () => {
  test("is saved as the first was: its own table, a key of its own made for it, and a folder of its own for the login", async () => {
    expect(await post({ platform: "whatsapp", name: "main", agent: "nouva" })).toEqual({ status: 200, body: { ok: true, restartRequired: true } });
    expect(await post({ platform: "whatsapp", name: "shop", agent: "nora" })).toEqual({ status: 200, body: { ok: true, restartRequired: true } });

    const file = readFileSync(configPath, "utf8");
    expect(file).toContain('[gateways.whatsapp.main]\nenabled = true\nencryption_key = "whatsapp-main-key"\nagent = "nouva"');
    expect(file).toContain('[gateways.whatsapp.shop]\nenabled = true\nencryption_key = "whatsapp-shop-key"\nagent = "nora"');
    expect(file).not.toContain("session_dir");
    const [main, shop] = ["whatsapp:main", "whatsapp:shop"].map((id) => config.gateways.find((gateway) => gateway.id === id)!);
    // Under the install's data folder, each named for its connection.
    expect([main!.sessionDir, shop!.sessionDir]).toEqual([join(dir, "whatsapp-main"), join(dir, "whatsapp-shop")]);
    // Two keys, each 64 hex characters, and not the same key.
    const keys = [await secrets.resolve("whatsapp-main-key"), await secrets.resolve("whatsapp-shop-key")];
    expect(keys.every((key) => /^[0-9a-f]{64}$/.test(key ?? ""))).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);

    const listed = (await (await control.request("/gateways")).json()) as { gateways: { id: string; agent?: string }[] };
    expect(listed.gateways.map((gateway) => [gateway.id, gateway.agent])).toEqual([["whatsapp:main", "nouva"], ["whatsapp:shop", "nora"]]);
  });

  test("is paired by its own code: one waits for its scan while the other is linked, each asked by its own id", async () => {
    await post({ platform: "whatsapp", name: "main", agent: "nouva" });
    await post({ platform: "whatsapp", name: "shop", agent: "nora" });
    const main = await running("whatsapp:main");
    const shop = await running("whatsapp:shop");
    main.says({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "62811@s.whatsapp.net" });
    shop.says({ type: "qr", qr: "2@the-shop's-code" });
    await eventually(() => main.gateway.isLinked() && shop.gateway.pairingCode() !== null);

    expect(await pairing("whatsapp:main")).toEqual({ status: 200, body: { status: "connected", linked: true, loggedOut: false, qr: null } });
    expect(await pairing("whatsapp:shop")).toMatchObject({ status: 200, body: { linked: false, qr: "2@the-shop's-code" } });

    // Scanned: its code is gone and it is linked, the first as it was.
    shop.says({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "62822@s.whatsapp.net" });
    await eventually(() => shop.gateway.isLinked());
    expect([(await pairing("whatsapp:shop")).body, (await pairing("whatsapp:main")).body]).toEqual([
      { status: "connected", linked: true, loggedOut: false, qr: null },
      { status: "connected", linked: true, loggedOut: false, qr: null },
    ]);
  });

  test("one that is saved and not started yet has no code to give, said as that", async () => {
    await post({ platform: "whatsapp", name: "shop", agent: "nora" });
    expect(await pairing("whatsapp:shop")).toEqual({ status: 404, body: { error: "no such gateway", plain: "That chat connection is not there any more. Reload the page." } });
  });
});

const linkAgain = async (id: string) => {
  const res = await control.request(`/gateways/${encodeURIComponent(id)}/link-again`, { method: "POST" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("a number logged out from its phone", () => {
  test("says so where its code is asked for, and is linked again on an admin's word: its old login gone, a new code to scan", async () => {
    await post({ platform: "whatsapp", name: "shop", agent: "nora" });
    const shop = await running("whatsapp:shop");
    shop.says({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "62822@s.whatsapp.net" });
    await eventually(() => shop.gateway.isLinked());
    const folder = config.gateways.find((gateway) => gateway.id === "whatsapp:shop")!.sessionDir!;
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "creds.enc"), "the old link");

    // Linked: there is nothing to link again, and its login is left as it is.
    expect(await linkAgain("whatsapp:shop")).toMatchObject({ status: 409, body: { plain: "This number is not logged out, so there is nothing to link again. Reload the page." } });
    expect(existsSync(join(folder, "creds.enc"))).toBe(true);

    // WhatsApp ends the link: the bridge says both, for one event. Not yet said to be logged out: its old login is
    // tried once more first.
    const endsTheLink = () => {
      shop.says({ type: "session_expired" });
      shop.says({ type: "status", status: "disconnected", reason: "logged out" });
    };
    endsTheLink();
    await eventually(() => shop.gateway.status === "dead");
    expect((await pairing("whatsapp:shop")).body).toEqual({ status: "dead", linked: false, loggedOut: false, qr: null });
    await eventually(() => shop.opened() === 2);
    // Said again to the old login: logged out from the phone. No code comes, and the page is told why.
    endsTheLink();
    await eventually(() => shop.gateway.isLoggedOut());
    expect((await pairing("whatsapp:shop")).body).toEqual({ status: "dead", linked: false, loggedOut: true, qr: null });

    expect(await linkAgain("whatsapp:shop")).toMatchObject({ status: 200, body: { ok: true, id: "whatsapp:shop" } });
    // The old login is gone, a new bridge was started on the empty folder, and its code is the one served.
    expect(existsSync(join(folder, "creds.enc"))).toBe(false);
    expect(shop.opened()).toBe(3);
    shop.says({ type: "qr", qr: "2@a-new-code" });
    await eventually(() => shop.gateway.pairingCode() !== null);
    expect(await pairing("whatsapp:shop")).toMatchObject({ status: 200, body: { linked: false, loggedOut: false, qr: "2@a-new-code" } });
    expect(audited).toEqual([{ action: "gateway_link_again", actor: "admin", gatewayId: "whatsapp:shop" }]);
  });

  test("is an admin's to link again, and only a connection that pairs with a code is", async () => {
    await post({ platform: "whatsapp", name: "shop", agent: "nora" });
    const shop = await running("whatsapp:shop");

    role = "operator";
    expect(await linkAgain("whatsapp:shop")).toEqual({ status: 403, body: { error: "admin only" } });
    expect(shop.opened()).toBe(1);
    role = "admin";
    gateways.set("telegram:bot", { id: "telegram:bot", status: "connected" } as unknown as Gateway);
    expect(await linkAgain("telegram:bot")).toEqual({ status: 400, body: { error: "this gateway does not pair with a code", plain: "This chat connection does not pair with a code." } });
    expect(await linkAgain("whatsapp:gone")).toEqual({ status: 404, body: { error: "no such gateway", plain: "That chat connection is not there any more. Reload the page." } });
    expect(audited).toEqual([]);
  });

  test("a login that could not be removed is said as that, and not as a refusal", async () => {
    gateways.set("whatsapp:stuck", { id: "whatsapp:stuck", status: "connecting", linkAgain: async () => ({ ok: false, refused: false, reason: "its old login could not be removed: EACCES" }) } as unknown as Gateway);
    expect(await linkAgain("whatsapp:stuck")).toEqual({ status: 500, body: { error: "its old login could not be removed: EACCES", plain: "Its old link could not be removed, so it was not linked again. The log says why." } });
    expect(audited).toEqual([]);
  });
});
