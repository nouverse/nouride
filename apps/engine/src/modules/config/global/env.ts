/**
 * Overrides for values a container platform sets rather than a config file.
 */

import { hostTimeZone, isTimeZone, zoneOfFile } from "@nouride/runtime";
import { ConfigError, isLogLevel, type GlobalConfig } from "@nouride/shared";


/**
 * Overrides for values a container platform sets rather than a config file.
 *
 * `client`: for the CLI talking to a daemon, which takes neither `HOST` nor `PORT` — names any web project's `.env`
 * sets, which pointed `nouride status` at whatever answered on 3000. A port of its own, `NOURIDE_PORT`, instead.
 */
export function applyEnvOverrides(config: GlobalConfig, options: { client?: boolean } = {}): void {
  // A container is its own isolation boundary, and a process bound to 127.0.0.1 *inside* one is
  // unreachable through `-p 18254:18254` — the port forward connects to the container's interface,
  // not its loopback. So the default stays loopback (right for a native daemon with no dashboard
  // auth yet) and the image overrides it. Verified: with the default, `curl` from the host got
  // nothing while the same request inside the container answered fine.
  if (process.env.HOST && !options.client) config.dashboard.host = process.env.HOST;

  const name = options.client ? "NOURIDE_PORT" : "PORT";
  const port = process.env[name];
  if (port) {
    const parsed = Number.parseInt(port, 10);
    if (Number.isNaN(parsed)) throw new ConfigError(`${name} is not a number: ${port}`);
    config.dashboard.port = parsed;
  }
  if (process.env.NOURIDE_DATA_DIR) config.daemon.dataDir = process.env.NOURIDE_DATA_DIR;
  if (process.env.NOURIDE_AGENTS_DIR) config.daemon.agentsDir = process.env.NOURIDE_AGENTS_DIR;
  // The CLI keeps going on a zone it cannot use: it formats a time now and then, and refusing to run over that would
  // take away the command that says what is wrong. The daemon is refused, by name, at load.
  try {
    config.daemon.timezone = zoneFor(config.daemon.timezone, process.env.TZ);
  } catch (err) {
    if (!options.client) throw err;
    config.daemon.timezone = hostTimeZone();
  }

  const level = process.env.LOG_LEVEL;
  if (isLogLevel(level)) config.daemon.logLevel = level;

  /**
   * The address this daemon answers on from outside, which a container cannot know for itself.
   *
   * `host:port` inside a container is `0.0.0.0:18254` and reaches nobody, so everything built from
   * it is wrong in a way that only shows up elsewhere: a webhook URL handed to GitHub, a redirect
   * URI sent to an identity provider. On a managed pod the hostname is chosen by the platform at
   * provision time and there is no file to put it in, which is why this is an override and not
   * only a config key.
   */
  if (process.env.NOURIDE_PUBLIC_URL) config.dashboard.publicUrl = process.env.NOURIDE_PUBLIC_URL;

  /**
   * Whether a password may be used at all.
   *
   * Here because a managed pod has no config file: the provisioner decides this
   * alongside the OAuth settings above, and `validate()` — which runs after
   * this — refuses the combination that would lock the owner out.
   */
  const passwordLogin = process.env.NOURIDE_PASSWORD_LOGIN?.trim().toLowerCase();
  if (passwordLogin === "false" || passwordLogin === "0") config.dashboard.passwordLogin = false;
  if (passwordLogin === "true" || passwordLogin === "1") config.dashboard.passwordLogin = true;

  /**
   * External sign-in, for an install somebody else provisioned.
   *
   * All four are here rather than only the ones that look like settings: a client id and the name
   * of a secret are issued *per install* by whoever registered it, so on a managed pod none of
   * them can come from an image or a file that was written before the pod existed.
   *
   * The client secret itself is **not** here. It stays a named secret resolved from
   * `$NOUVERSE_OAUTH` or the store, so it never appears in a config file, a Deployment spec or a
   * log of the environment this function reads.
   *
   * `validate()` runs after these, so a half-configured environment is refused at boot with the
   * same message a half-configured file gets.
   */
  const oauth = config.dashboard.oauth;
  if (process.env.NOURIDE_OAUTH_ISSUER) oauth.issuer = process.env.NOURIDE_OAUTH_ISSUER;
  if (process.env.NOURIDE_OAUTH_CLIENT_ID) oauth.clientId = process.env.NOURIDE_OAUTH_CLIENT_ID;
  if (process.env.NOURIDE_OAUTH_SECRET_NAME) oauth.secretName = process.env.NOURIDE_OAUTH_SECRET_NAME;
  if (process.env.NOURIDE_OAUTH_LABEL) oauth.label = process.env.NOURIDE_OAUTH_LABEL;
}

/**
 * The zone the daemon keeps time in: `TZ` when the environment sets one — how a container says it, and it always won —
 * else `[daemon] timezone`, else this machine's (`hostTimeZone`). "01:00" for the nightly pass, a cron job with no zone
 * of its own, the daily rollover and the Box's update window all mean this zone's clock.
 *
 * Checked here, at load. A zone `Intl` refuses made every `localTime` throw: each turn ran without memory, and the
 * nightly pass's clock, ticking in a timer, took the daemon down a minute after every start. A POSIX `TZ` is not a zone
 * name — `:/etc/localtime` is read for the file it names; `CET-1CEST` is refused with what to set instead.
 */
export function zoneFor(configured: unknown, tz: string | undefined): string {
  const fromEnv = tz?.trim();
  if (fromEnv) {
    if (fromEnv.startsWith(":")) {
      const zone = zoneOfFile(fromEnv.slice(1) || "/etc/localtime");
      if (zone) return zone;
      throw new ConfigError(`TZ=${fromEnv} names no zone file this daemon can read: unset it, or set it to a zone name such as "Asia/Jakarta"`);
    }
    if (isTimeZone(fromEnv)) return fromEnv;
    throw new ConfigError(`TZ=${fromEnv} is not a zone name (a POSIX TZ string is not one): set it to a name such as "Asia/Jakarta", or unset it and set [daemon] timezone`);
  }
  // Not a string is not a name either: `timezone = 7` took the load down on `.trim()`, a TypeError naming nothing.
  const named = typeof configured === "string" ? configured.trim() : JSON.stringify(configured);
  if (!named) return hostTimeZone();
  if (typeof configured === "string" && isTimeZone(named)) return named;
  throw new ConfigError(`[daemon] timezone = ${typeof configured === "string" ? `"${named}"` : named} is not a zone name: use one such as "Asia/Jakarta" or "UTC", or leave it out for this machine's`);
}
