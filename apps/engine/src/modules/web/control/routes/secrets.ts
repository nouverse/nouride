/**
 * The secret store, write-only.
 *
 * Three routes and **not one of them returns a value.** That is the whole design: the store exists so
 * a config file can name a credential instead of holding one, and a route that read one back would
 * hand every authenticated caller — the dashboard, the CLI, and through the CLI an *agent* — a way to
 * exfiltrate every token on the box in a single request.
 *
 * `GET` answers names and where each one resolves from, which is the question anybody actually has:
 * "is `discord_nox_token` set, and is it the store's copy or an environment variable?" is answerable
 * without seeing it.
 *
 * Overwriting is allowed, by decision: an agent that can be handed a rotated key should be able to
 * store it. It is a change worth an audit row and it gets one — with the value's length, never the
 * value.
 *
 * What is said about a secret, its fields (0.8.19), is not secret: listed with its name, given with a value, or changed
 * on its own (`PATCH /secrets/:name/fields`), which leaves the value as it is.
 */

import type { SecretEntry, SecretLock } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import { assertSecretName, type FieldChange, SecretError, type SecretPart } from "@nouride/secrets";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { INCOMPLETE, NO_SETTINGS, notSaved } from "../plain.ts";

/** Each part of a secret a save can be refused for, as the Secrets page's form names it. */
const SECRET_PARTS: Record<SecretPart, string> = {
  name: "the name",
  value: "the value",
  fields: "the details",
};

export function registerSecretRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/secrets", (c) => {
    if (!deps.settings) return c.json({ error: "the secret store is not available" }, 501);
    // Whether the snapshots hold them, sealed, and whether the store is encrypted and where its key is (0.8.19):
    // said beside the names, where somebody looks. Where the key is, never the key.
    return c.json({ secrets: deps.settings.secretInventory(), sealedInSnapshots: Boolean(deps.ctx.config.daemon.backupSeal), lock: deps.settings.secretLock() } satisfies { secrets: SecretEntry[]; sealedInSnapshots?: boolean; lock?: SecretLock });
  });

  /** The backup passphrase (0.8.18): `{ passphrase }` sets it, `{ off: true }` keeps secrets out of snapshots. Admin. */
  control.post("/secrets/seal", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const passphrase = body.off === true ? null : typeof body.passphrase === "string" ? body.passphrase : undefined;
    if (passphrase === undefined) return c.json({ error: "give a passphrase, or off: true", plain: INCOMPLETE }, 400);
    const result = await deps.settings.setBackupSeal({ passphrase, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: "The backup password was not set. Check it, and try again." }, 400);
    // The snapshot taken with it, to open and check; never the passphrase, nor what it derived.
    return c.json({ ok: true, sealedInSnapshots: passphrase !== null, ...(result.snapshot ? { snapshot: result.snapshot } : {}), ...(result.skipped ? { skipped: result.skipped } : {}) } satisfies { ok: true; sealedInSnapshots: boolean; snapshot?: string; skipped?: string });
  });

  control.put("/secrets/:name", async (c) => {
    if (!deps.settings) return c.json({ error: "the secret store is not available" }, 501);
    const principal = c.get("principal");
    // Same bar as editing a gateway or a provider profile, because this is the credential half of
    // both of those.
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const name = c.req.param("name");
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const value = typeof body.value === "string" ? body.value : "";
    if (!value) return c.json({ error: "`value` is required" }, 400);

    try {
      // The same check the config parser applies, so a name that would be refused there is refused
      // here rather than stored and never resolvable.
      assertSecretName(name, "secret name");
    } catch (err) {
      if (err instanceof SecretError) return c.json({ error: err.message, plain: "That name cannot be used. A secret's name takes letters, digits and underscores." }, 400);
      throw err;
    }

    const fields = fieldChange(body.fields);
    if (fields === "bad") return c.json({ error: "`fields` is { set: { name: text }, remove: [names] }", plain: INCOMPLETE }, 400);
    const result = await deps.settings.setSecret({
      name,
      value,
      actor: principal.user?.username ?? principal.kind,
      ...(fields ? { fields } : {}),
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved(result.field && SECRET_PARTS[result.field]) }, 400);

    /**
     * Whether the write will actually be what resolves.
     *
     * An environment variable of the same name wins over the store, so storing a value that is
     * shadowed succeeds and changes nothing — a silent no-op that looks exactly like success. Said
     * back so the caller can act on it.
     */
    return c.json({ ok: true, name, shadowedByEnv: deps.settings.secretShadowedByEnv(name) } satisfies { ok: true; name: string; shadowedByEnv: boolean });
  });

  /** What is said about a stored secret, changed: `{ set: { name: text }, remove: [names] }`. The value untouched. Admin. */
  control.patch("/secrets/:name/fields", async (c) => {
    if (!deps.settings) return c.json({ error: "the secret store is not available" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const change = fieldChange((await jsonBody(c)) ?? {});
    if (!change || change === "bad") return c.json({ error: "give `set` with names and texts, or `remove` with names" }, 400);
    const result = await deps.settings.changeSecretFields({ name: c.req.param("name"), change, actor: principal.user?.username ?? principal.kind });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved(result.field && SECRET_PARTS[result.field]) }, 400);
    return c.json({ ok: true, fields: result.fields ?? {} } satisfies { ok: true; fields: Record<string, string> });
  });

  control.delete("/secrets/:name", async (c) => {
    if (!deps.settings) return c.json({ error: "the secret store is not available" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const deleted = await deps.settings.deleteSecret({
      name: c.req.param("name"),
      actor: principal.user?.username ?? principal.kind,
    });
    return c.json({ deleted } satisfies { deleted: boolean });
  });
}

/**
 * `{ set: { name: text }, remove: [names] }` as a field change: null when nothing was given, "bad" for a shape that is not
 * one. Each name and text is checked by the store, which says what is wrong with it.
 */
function fieldChange(raw: unknown): FieldChange | null | "bad" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "bad";
  const { set, remove } = raw as { set?: unknown; remove?: unknown };
  if (set === undefined && remove === undefined) return null;
  if (set !== undefined && (typeof set !== "object" || set === null || Array.isArray(set) || Object.values(set).some((text) => typeof text !== "string"))) return "bad";
  if (remove !== undefined && (!Array.isArray(remove) || remove.some((name) => typeof name !== "string"))) return "bad";
  return { ...(set ? { set: set as Record<string, string> } : {}), ...(remove ? { remove: remove as string[] } : {}) };
}
