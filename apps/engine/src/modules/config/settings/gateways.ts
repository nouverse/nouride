/**
 * Chat connections, as the dashboard edits them.
 *
 * A gateway's token is written to the secret store and *named* in config.toml, never written into
 * it — invariant 3. Removing one takes it down live first, because a connection that is gone from
 * the file but still holding a socket is a connection nothing can account for.
 */

import { createLogger } from "@nouride/shared";
import { GROUP_CONTEXT_MAX, type ConfigurableGatewayName } from "@nouride/shared";
import { isAbsolute, join, randomBytes, removePath, statFile } from "@nouride/runtime";
import { removeTomlTable, upsertTomlTable } from "@/modules/config/edit.ts";
import { readConfigText } from "@/modules/config/global/index.ts";
import { editConfigFile } from "./file.ts";
import {
  GATEWAY_PLATFORMS,
  NAME_PATTERN,
  type GatewayView,
  type SaveResult,
  type SettingsDeps,
} from "./types.ts";

const log = createLogger("settings");

/** A field of a connection's form a refusal names (0.8.23): the chat app, its name, its key, its own group context. */
export type GatewayField = "platform" | "name" | "token" | "groupContextMessages";

export function gateways(deps: SettingsDeps): GatewayView[] {
  const live = deps.gatewayStatus();
  const names = new Set(deps.secrets.inventory().map((entry) => entry.name));

  return deps.config.gateways.map((gateway) => ({
    ...gateway,
    status: live.get(gateway.id)?.status ?? null,
    // Why it is not up yet, where it said: "connecting" for half an hour reads as hung without it.
    ...(live.get(gateway.id)?.waiting ? { waiting: live.get(gateway.id)!.waiting! } : {}),
    // Whichever secret this platform actually needs — asking about `tokenSecret` on a gateway that
    // has none reports every WhatsApp instance as missing its credential.
    hasCredential: names.has(gateway.encryptionKeySecret ?? gateway.tokenSecret),
  }));
}

/**
 * Create or update one gateway instance.
 *
 * `token` is optional on an update on purpose: a form that requires the credential every time it
 * saves an unrelated field (the owning agent, say) trains people to paste secrets they did not need
 * to, and one of those pastes eventually lands in the wrong box. Omitted means "leave the stored
 * value alone", and the response says which of the two happened.
 */
export async function saveGateway(deps: SettingsDeps, input: {
  platform: string;
  name: string;
  enabled: boolean;
  token?: string;
  agent?: string;
  actor: string;
  /** WhatsApp only; ignored elsewhere. */
  sessionDir?: string;
  /**
   * Per-connection override for `[agents] group_context_messages`.
   *
   * Omitted leaves whatever the file says, the same rule `token` follows. A value equal to the
   * daemon's own default is not written unless this connection already overrides it — otherwise
   * every gateway table would grow a line restating a setting nobody changed.
   */
  groupContextMessages?: number;
}): Promise<SaveResult<GatewayField>> {
  const platform = input.platform as ConfigurableGatewayName;
  if (!GATEWAY_PLATFORMS.includes(platform)) {
    return { ok: false, field: "platform", error: `unknown platform "${input.platform}"` };
  }

  const name = input.name.trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      field: "name",
      error: "name must start with a letter or digit and contain only letters, digits, - and _",
    };
  }

  const id = `${platform}:${name}`;
  const existing = deps.config.gateways.find((gateway) => gateway.id === id);

  /**
   * WhatsApp's credential is not a token.
   *
   * There is nothing to paste: pairing is a QR scan, and the secret this gateway needs is the key
   * its *session* is encrypted with. It lands under `encryption_key`, not `token` — the loader
   * reads a different field for it, so writing `token` produced a gateway that saved cleanly and
   * then could not start.
   */
  const pairs = platform === "whatsapp";
  const secretName = pairs
    ? (existing?.encryptionKeySecret ?? `${platform}-${name}-key`)
    : (existing?.tokenSecret ?? `${platform}-${name}`);

  let token = input.token?.trim();
  if (!token && !existing) {
    if (!pairs) return { ok: false, field: "token", error: "a token is required to add a gateway" };
    // Generated once, at creation, and kept. Nobody should have to run `openssl rand -hex 32` to
    // add a gateway — and generating it per boot instead would lock you out of your own session,
    // which is why the loader refuses to default it.
    token = randomBytes(32).toString("hex");
    log.info("generated a whatsapp session key", { id, secret_name: secretName });
  }

  const agent = input.agent?.trim() ?? existing?.agent ?? "";

  /**
   * The per-connection group-context override, or nothing to write.
   *
   * Refused here as well as in the loader: this path edits the file without going through it, so a
   * dashboard that sent 5000 would install a value the next boot dies on.
   *
   * A number equal to the daemon's own default is dropped rather than written, unless this
   * connection already carries an override — a form that submits its own placeholder would
   * otherwise add a redundant line to every gateway table on every unrelated save. There is no
   * "clear it" here because `upsertTomlTable` only ever writes keys: setting a connection back to
   * the daemon value pins the same number, which behaves identically.
   */
  const groupContext = input.groupContextMessages;
  if (groupContext !== undefined) {
    if (!Number.isInteger(groupContext) || groupContext < 0 || groupContext > GROUP_CONTEXT_MAX) {
      return {
        ok: false,
        field: "groupContextMessages",
        error: `group context must be a whole number between 0 (off) and ${GROUP_CONTEXT_MAX}`,
      };
    }
  }
  const groupContextOverride =
    groupContext !== undefined &&
    (groupContext !== deps.config.agents.groupContextMessages ||
      existing?.groupContextMessages !== undefined)
      ? groupContext
      : undefined;

  const values: Record<string, string | number | boolean> = {
    enabled: input.enabled,
    // The NAME of the secret. If this line ever renders a credential, the bug is here.
    ...(pairs ? { encryption_key: secretName } : { token: secretName }),
  };
  if (agent) values.agent = agent;
  if (groupContextOverride !== undefined) {
    values.group_context_messages = groupContextOverride;
  }
  if (platform === "telegram") values.mode = existing?.mode ?? "polling";
  if (platform === "whatsapp") {
    // Written only when given: left out, the login lives under `data_dir` (`global/paths.ts`), and
    // a line that repeated the default would pin a path the default could no longer move.
    const sessionDir = input.sessionDir?.trim();
    if (sessionDir) values.session_dir = sessionDir;
    // No `bridge_transport`: the bridge runs in this process, which is what the key left out means. A save wrote
    // `"stdio"` once, a transport that no longer exists, and later `"inproc"`, the only value left.
    if (sessionDir && isAbsolute(sessionDir) && !sessionDir.startsWith(deps.config.daemon.dataDir)) {
      log.warn("whatsapp session directory is outside the data directory", { id, sessionDir });
    }
  }

  // The running config's list is the file's now (`config/follow.ts`), so the list this same request refreshes shows
  // the change, and the next save reads its fallbacks — a ws bridge saved a moment ago — off what the loader made of
  // it. The adapter is untouched; that is what `restartRequired` is telling the caller. The connection's own group
  // context is live all the same: the pipeline reads it off the running config per message.
  //
  // An agent has one connection on each chat app, as its Connections page offers: a second bot or number on an app it
  // answers on was made from the command line all the same. Only a connection that comes to the agent is refused, new
  // or given to it; two written into the file by hand are each still edited, and still load. Asked of the file as it
  // is under the save's lock, not of the running copy: two saves at once each passed a check of the list as it was
  // before either landed, and the whole-file editor's save is the next boot's, which the running copy does not follow.
  const held: { id?: string } = {};
  const saved = await editConfigFile(deps, (source) => {
    const there = readConfigText(source, deps.configPath).gateways;
    if (agent && there.find((gateway) => gateway.id === id)?.agent !== agent) {
      held.id = there.find((gateway) => gateway.platform === platform && gateway.agent === agent)?.id;
      if (held.id) return { refused: `${agent} already has ${held.id}` };
    }
    return upsertTomlTable(source, `gateways.${platform}.${name}`, values);
  });
  if (held.id) {
    return {
      ok: false,
      field: "platform",
      error: `${agent} already has ${held.id}, and an agent has one connection on each chat app: change that one, or remove it first`,
    };
  }
  if (!saved.ok) return saved;
  // Stored once the save is through: a save refused above or by the file's own check used to have replaced the
  // working token with the new one all the same.
  if (token) await deps.secrets.set(secretName, token);

  log.info("gateway saved", { id, enabled: input.enabled, actor: input.actor });
  deps.audit?.record({
    action: "gateway_configured",
    actor: input.actor,
    details: { id, enabled: input.enabled, credentialChanged: Boolean(token) },
  });

  return { ok: true, restartRequired: true };
}

/**
 * Forget a gateway instance, and everything that only existed for it.
 *
 * This used to keep the credential, on the reasoning that a mistaken delete should be undoable by
 * re-adding rather than by hunting for a token again. That was wrong, and the operator was right to
 * call it strange — "removed, but the credential is kept" is a confusing thing to tell someone who
 * just pressed delete, and for a paired platform it is worse than confusing:
 *
 * - The WhatsApp credential is a **session key the daemon generated**, not something anyone
 *   obtained. Keeping it preserves nothing a person could not have regenerated.
 * - The key plus `session_dir` is a **working login**. Leaving both behind means deleting a
 *   connection leaves the account still linked on disk, which is the opposite of what delete means.
 * - Re-adding overwrites the key anyway (there is no `existing` to read the old name from), so the
 *   kept copy could never decrypt that session again. It was orphaned bytes, not a safety net.
 *
 * So this removes the table, the credential, and — for a platform that pairs — the session
 * directory. A token shared with another instance is left alone; nothing else references it by
 * construction, but checking is cheaper than being wrong.
 */
export async function removeGateway(deps: SettingsDeps, id: string, actor: string, how: { keepToken?: boolean } = {}): Promise<SaveResult> {
  const existing = deps.config.gateways.find((gateway) => gateway.id === id);
  if (!existing) return { ok: false, error: `no gateway "${id}"` };

  /**
   * The live connection goes first, and for WhatsApp that ordering is the fix.
   *
   * Baileys writes `creds.enc` on every credential update, so removing the session directory while
   * the bridge is still running gets it recreated within seconds — which is what "I deleted it and
   * it is still there" was. Log out, stop the process, *then* delete what is left on disk.
   */
  const retired = await deps.retireGateway?.(id);

  const saved = await editConfigFile(deps, (source) => removeTomlTable(source, `gateways.${existing.platform}.${existing.name}`));
  if (!saved.ok) return saved;

  // Read off the running config, which is the file's list now: a second connection a hand edit pointed at the same
  // secret is in it, restarted or not, and keeps its credential.
  const secretName = existing.encryptionKeySecret ?? existing.tokenSecret;
  const stillUsed = deps.config.gateways.some(
    (gateway) => (gateway.encryptionKeySecret ?? gateway.tokenSecret) === secretName,
  );
  let credentialRemoved = false;
  // `keepToken`, for a connection that goes with its deleted agent: a token a person obtained stays in Secrets, where
  // they can delete it or name it in another connection. A session key the daemon made itself goes as it always did.
  const kept = how.keepToken === true && !existing.encryptionKeySecret;
  if (secretName && !stillUsed && !kept) {
    credentialRemoved = await deps.secrets.delete(secretName);
  }

  // The session is the login. Removed with the connection, because leaving it is how a deleted
  // gateway stays signed in.
  let sessionRemoved = false;
  // Whether it held a login, read before it goes: a folder with none was never linked, and no phone lists it.
  const hadLogin = existing.platform === "whatsapp" && existing.sessionDir !== undefined && statFile(join(existing.sessionDir, "creds.enc")) !== null;
  if (existing.platform === "whatsapp" && existing.sessionDir) {
    try {
      removePath(existing.sessionDir);
      sessionRemoved = true;
    } catch (err) {
      // Said, not swallowed: a session that outlives its gateway is a credential nobody is
      // tracking, and the operator should know it is still there.
      log.warn("could not remove the whatsapp session directory", {
        id,
        dir: existing.sessionDir,
        error: String(err),
      });
    }
  }

  log.info("gateway removed", {
    id,
    actor,
    credentialRemoved,
    sessionRemoved,
    stopped: retired?.stopped ?? false,
    logged_out: retired?.loggedOut ?? false,
  });
  deps.audit?.record({
    action: "gateway_removed",
    actor,
    details: {
      id,
      credentialRemoved,
      sessionRemoved,
      stopped: retired?.stopped ?? false,
      loggedOut: retired?.loggedOut ?? false,
    },
  });

  // A restart is only needed for what could not be retired live. Saying "restart required" after
  // the connection is already down and its files are gone sends the operator to do nothing.
  // A number removed without its phone being told is still listed there: said, as the place to finish removing it.
  const stillOnThePhone = hadLogin && sessionRemoved && retired?.loggedOut !== true;
  return { ok: true, restartRequired: !retired?.stopped, ...(stillOnThePhone ? { stillOnThePhone: true as const } : {}) };
}
