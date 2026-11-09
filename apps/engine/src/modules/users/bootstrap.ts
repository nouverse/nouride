/**
 * Getting a first account onto a fresh install without a terminal.
 *
 * The target is `docker compose up`, a browser, and a working agent — no shell step in the middle. That
 * rules out "run this command to create an admin", and it rules out shipping a well-known default
 * password, which is the same as shipping no authentication at all on anything with a published port.
 *
 * So: the operator may name the account through `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`
 * (Hermes' shape, and the right one for a scripted deployment) — with `INITIAL_ADMIN_MUST_CHANGE=1`
 * when that password is a way in rather than theirs to keep — and if they have not, the daemon
 * generates a password, prints it once where `docker logs` will show it, and **requires it to be
 * changed at first login**. A generated credential the operator did not choose is a way in, not a
 * password, and it should stop working the moment it has been used.
 *
 * Deliberately not done: creating the account lazily from whoever reaches the port first. That is the
 * seamless option, and it hands the instance to whoever finds it before its owner does.
 */

import { createLogger } from "@nouride/shared";
import { randomToken } from "@nouride/runtime";
import type { UsersPort } from "@/modules/users/users.store.ts";

const log = createLogger("users.bootstrap");

export interface BootstrapResult {
  created: boolean;
  username?: string;
  /** Present only when this process generated it, so the caller can print it once. */
  generatedPassword?: string;
  /** Why nothing was created, for a caller that wants to say so. */
  reason?: string;
}

/**
 * A password that survives being copied out of a log by hand.
 *
 * Hex rather than a word list or full base64: `l`/`1` and `O`/`0` are the classic transcription
 * failures, and someone reading this off a terminal and typing it into a browser is the expected path.
 */
function generatePassword(): string {
  return randomToken().slice(0, 20);
}

export async function ensureInitialAdmin(
  users: UsersPort,
  env: Record<string, string | undefined> = process.env,
  /**
   * A password this boot already generated and lent to something else — see `seedSharedInitialAdmin`.
   *
   * Taken here rather than read back out of the environment so the account still carries
   * `mustChangePassword`. Routing a generated password through `INITIAL_ADMIN_PASSWORD` would make it
   * indistinguishable from one the operator chose, and the operator's choice is deliberately exempt
   * from the forced change.
   */
  preGenerated?: string,
): Promise<BootstrapResult> {
  if (users.count() > 0) return { created: false, reason: "an account already exists" };

  const configuredName = (env.INITIAL_ADMIN_USERNAME ?? "").trim();
  const configuredPassword = env.INITIAL_ADMIN_PASSWORD ?? "";

  // Both or neither. A username with no password would otherwise silently fall through to a generated
  // one under a name the operator chose, which reads in the log as though their password was accepted.
  if (configuredName && configuredPassword) {
    try {
      const user = await users.create({
        username: configuredName,
        password: configuredPassword,
        role: "admin",
        createdBy: "bootstrap",
        // A password somebody else chose for the operator — a Nouride Box's first login is the setup
        // PIN printed on its card — is exempt from nothing: it opens the door once.
        ...(/^(1|true|yes)$/i.test(env.INITIAL_ADMIN_MUST_CHANGE ?? "") ? { mustChangePassword: true } : {}),
      });
      log.info("initial admin created from the environment", { user: user.username });
      return { created: true, username: user.username };
    } catch (err) {
      // A password below the floor is the common case. Refusing loudly and continuing to the generated
      // account is better than refusing to boot: the operator still gets in, and the log says why their
      // setting was not used.
      log.warn("INITIAL_ADMIN_* was rejected, falling back to a generated password", {
        error: String(err instanceof Error ? err.message : err),
      });
    }
  } else if (configuredName || configuredPassword) {
    log.warn("INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD must both be set, so both are ignored");
  }

  const password = preGenerated ?? generatePassword();
  const username = configuredName || "admin";
  const user = await users.create({
    username,
    password,
    role: "admin",
    createdBy: "bootstrap",
    mustChangePassword: true,
  });

  return { created: true, username: user.username, generatedPassword: password };
}

/**
 * Both variables set, which means anything else in this process that reads them — the bundled
 * gateway, on its own first run — gets the same credential without anyone arranging it.
 *
 * "Both or neither" is the rule on both sides, so half a configuration shares nothing.
 */
function initialAdminIsFromEnv(env: Record<string, string | undefined>): boolean {
  return Boolean((env.INITIAL_ADMIN_USERNAME ?? "").trim() && (env.INITIAL_ADMIN_PASSWORD ?? ""));
}

/**
 * How the bundled gateway comes to hold this daemon's admin credential, or null for "it does not".
 *
 * `"environment"` needs no action and carries no password: the operator set `INITIAL_ADMIN_*`, both
 * products read those two names, and it is still the password they know. `"generated"` is one this
 * daemon made up and lent, so it carries the value and the way to take it back.
 */
export type InitialAdminSharing =
  | { mode: "environment" }
  | { mode: "generated"; username: string; password: string; clear(): void };

/**
 * One first-run password for both halves of a bundled build.
 *
 * With its LLM gateway switched on, a build hosts it in this same process, and that gateway
 * bootstraps its own admin account exactly the way this one does: the same two variable names, the
 * same "both or neither" rule, and the same fallback to a password it generates and prints. On a
 * first run that leaves the operator reading two banners and typing two different passwords into
 * what they experience as one product.
 *
 * So the daemon generates the password *before* the gateway boots and lends it through the
 * variables the gateway already reads. They are set for the duration of that boot and put back
 * immediately after — a generated admin password has no business sitting in the environment of
 * every command the agent goes on to run.
 *
 * Returns the answer to "which password opens the gateway" rather than only doing the lending,
 * because the wizard has to say so and the two facts are read from the same place. Read separately
 * they had to be read in the right order — the environment, and then the seeder that overwrites it
 * — which is a thing to get wrong rather than a thing to know.
 */
export function seedSharedInitialAdmin(input: {
  firstRun: boolean;
  env?: Record<string, string | undefined>;
}): InitialAdminSharing | null {
  const env = input.env ?? process.env;

  /**
   * Answered before `firstRun`, and deliberately not gated on it.
   *
   * The gateway keeps its users somewhere else entirely, so it can be doing its own first run on a
   * daemon that is long past its own. The operator's pair still
   * reaches it either way, and there is nothing here to arrange: overwriting it would replace a
   * password they chose with one they have never seen.
   */
  if (initialAdminIsFromEnv(env)) return { mode: "environment" };
  if (!input.firstRun) return null;

  const configuredName = (env.INITIAL_ADMIN_USERNAME ?? "").trim();
  const hadUsername = env.INITIAL_ADMIN_USERNAME;
  const hadPassword = env.INITIAL_ADMIN_PASSWORD;
  const hadMustChange = env.INITIAL_ADMIN_MUST_CHANGE;
  const username = configuredName || "admin";
  const password = generatePassword();
  env.INITIAL_ADMIN_USERNAME = username;
  env.INITIAL_ADMIN_PASSWORD = password;
  // Lent with the flag, or the gateway reads a password this daemon generated as one the operator
  // chose, and keeps it for good while the daemon beside it forces a change — which is what shipped.
  env.INITIAL_ADMIN_MUST_CHANGE = "1";

  log.info("lending the first-run password to the bundled gateway", { user: username });

  return {
    mode: "generated",
    username,
    password,
    clear() {
      // Restored rather than deleted. Half-set variables are a case both bootstraps warn about, and
      // swallowing the operator's half here would silence the warning that tells them why.
      if (hadUsername === undefined) delete env.INITIAL_ADMIN_USERNAME;
      else env.INITIAL_ADMIN_USERNAME = hadUsername;
      if (hadPassword === undefined) delete env.INITIAL_ADMIN_PASSWORD;
      else env.INITIAL_ADMIN_PASSWORD = hadPassword;
      if (hadMustChange === undefined) delete env.INITIAL_ADMIN_MUST_CHANGE;
      else env.INITIAL_ADMIN_MUST_CHANGE = hadMustChange;
    },
  };
}

/**
 * The block printed to stdout when a password was generated.
 *
 * Written to stdout rather than through the structured logger on purpose. This is the one line of
 * output an operator has to read and act on, and a JSON log line with a password inside a `data` object
 * is exactly the shape people scroll past — and the shape a log shipper forwards somewhere it should
 * not go. Returned as a string so it can be tested without capturing console output.
 */
export function firstRunBanner(input: {
  username: string;
  password: string;
  url: string;
  /** Other addresses it answers on — this machine's LAN addresses when it is bound to every interface. */
  alsoAt?: string[];
  /** Where the bundled gateway answers, when it took this same credential — see `seedSharedInitialAdmin`. */
  gatewayUrl?: string;
}): string {
  const line = "─".repeat(64);
  return [
    "",
    line,
    "  Nouride is ready. Open the dashboard to finish setting it up:",
    "",
    `    ${input.url}`,
    ...(input.alsoAt?.length ? ["", "  or from another device on this network:", ...input.alsoAt.map((url) => `    ${url}`)] : []),
    "",
    `    username  ${input.username}`,
    `    password  ${input.password}`,
    "",
    "  This password was generated for the first login and must be changed",
    "  straight away. The daemon keeps only its hash, but this text stays in",
    "  wherever this log goes (the journal, a log file) until the password is changed.",
    "  Set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD to choose your own.",
    ...(input.gatewayUrl
      ? [
          "",
          "  The bundled LLM gateway took the same username and password:",
          `    ${input.gatewayUrl}/frontend/`,
        ]
      : []),
    line,
    "",
  ].join("\n");
}
