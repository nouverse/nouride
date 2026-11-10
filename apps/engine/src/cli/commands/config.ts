import { join, loadTomlIfExists, readTextFileIfExists } from "@nouride/runtime";
import { holdLines, plural, type GlobalConfig } from "@nouride/shared";
import { assertGatewayExecPosture, defaultConfigPath, noteOf, type ConfigNote } from "@/modules/config/global/index.ts";
import { profilesBehind } from "@/modules/config/known-endpoints.ts";
import { commandSecretLookup } from "@/boot/secret-store.ts";
import { assertUpgradeFloor, loadConfigPastTheFloor } from "@/boot/upgrade-floor.ts";
import { configJsonSchema, describeConfig, fieldsIn, findField, lintConfig } from "@/modules/config/schema.ts";
import { AgentRegistry } from "@nouride/persona";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, emit, fail, say, usageError } from "@/cli/ui.ts";
import { helpFor, unknownAction } from "@/cli/usage.ts";
import { unreadableConfig } from "@/cli/load-config.ts";

/**
 * `nouride config check [file]` — would this configuration start?
 *
 * The gap it closes is the one that cost a live outage. An agent wrote a config, restarted the daemon
 * to apply it, and the refusal arrived *after* the process was gone — taking with it the conversation
 * that could have fixed it. Nothing could be done in-process about that, because the check only ran at
 * boot and boot is where the damage happened.
 *
 * Running the same checks without starting anything moves the answer to before the restart, where
 * somebody can still act on it. Deliberately talks to no daemon: it has to work when none is running,
 * which is exactly the state a broken config leaves behind.
 */
export async function configCmd(args: string[]): Promise<void> {
  const action = args[0];
  if (action === "schema") return configSchemaCmd(args.slice(1));
  if (action === "explain") return configExplainCmd(args.slice(1));
  if (action !== "check") {
    if (action !== undefined) unknownAction("config", action);
    // Bare, what the group does — said as help, as `--help` is.
    return helpFor("config");
  }

  return await configCheck(args[1]);
}

/**
 * What the check loads, as the daemon would: the config, every pack, and the posture the two make together.
 *
 * The real loader, not a re-implementation: a check that validates differently from the thing it predicts is worse
 * than no check, because it is believed. `$NOURIDE_CONFIG` is the loader's own first candidate, so pointing it at a file
 * reuses the exact resolution the daemon does rather than adding a second way to find a config.
 */
async function loadForCheck(target: string | undefined) {
  if (target) process.env.NOURIDE_CONFIG = target;
  // The floor too, as the daemon checks it: on data no 0.8.0 has run on, a config that loads would still not start.
  const { config, source, notes } = await loadConfigPastTheFloor({ quiet: true });
  await assertUpgradeFloor(config.daemon.dataDir);
  const registry = await AgentRegistry.create({
    agentsDir: config.daemon.agentsDir,
    llmDefaults: config.llm.defaults,
    knownProviders: Object.keys(config.providers),
    knownGateways: config.gateways.map((g) => g.id),
  });
  // The posture check needs the loaded agents to know who holds `exec`, which is why it cannot live
  // in `parseConfig` and why this command loads them too.
  assertGatewayExecPosture({
    gatewaysEnabled: config.gateways.some((g) => g.enabled),
    agentsWithExec: registry
      .active()
      .filter((agent) => agent.config.tools.enabled.includes("exec"))
      .map((agent) => agent.config.id),
    accessMode: config.security.access.mode,
  });
  return { config, source, notes, registry };
}

/**
 * Each profile, and for one on the OpenAI wire whose output limit goes in another field than `max_tokens`, that field:
 * a profile on OpenAI's own API that sends `max_tokens` fails every reply on its newer models, so it is said where it
 * differs.
 */
function providersLine(providers: GlobalConfig["providers"]): string {
  const named = Object.entries(providers).map(([name, profile]) => (profile.maxTokensField ? `${name} (output limit as ${profile.maxTokensField})` : name));
  return named.join(", ") || "none";
}

/** What the next start writes into a profile on a known endpoint (`boot/endpoint-keys.ts`), said before it does. */
async function broughtForward(source: string): Promise<ConfigNote[]> {
  const text = await readTextFileIfExists(source);
  return profilesBehind(text ?? "").map((behind) => ({
    message: `[providers.${behind.profile}] will be given ${Object.entries(behind.set).map(([key, value]) => `${key} = "${value}"`).join(", ")} at the next start`,
    ...(behind.why ? { hint: behind.why } : {}),
  }));
}

/** Whether a pack that did not load is one the daemon would run: `[agent] enabled` unless it says `false` — or does not parse. */
async function packEnabled(dir: string): Promise<boolean> {
  try {
    const raw = await loadTomlIfExists<{ agent?: { enabled?: unknown } }>(join(dir, "config.toml"));
    return raw?.agent?.enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Would it start — and would every agent with it.
 *
 * What the loading logs is held for the length of it (`holdLines`) and said here, as lines of the verdict: "agent pack
 * failed to load", written as JSON above "✓ this configuration would start", was the only place a pack that would not
 * load was said — and the release notes send people here before an upgrade. Each
 * enabled pack that will not load is a `✗` with why, and the check fails: the daemon would start, and that agent would
 * not. A disabled one is said, and fails nothing — nothing would run it.
 */
async function configCheck(target: string | undefined): Promise<void> {
  const release = holdLines();
  let loaded: Awaited<ReturnType<typeof loadForCheck>>;
  try {
    loaded = await loadForCheck(target);
  } catch (err) {
    release();
    // A file this user may not read is no verdict on it — the daemon's user may — so it is said as every command says it.
    // Non-zero, so a script — or an agent — can branch on it rather than parsing this text.
    fail(unreadableConfig(err) ?? `this configuration would NOT start:\n${err instanceof Error ? err.message : String(err)}`);
  }
  const { config, source, notes, registry } = loaded;
  // The registry's own line for each pack that did not load is said below, with its pack; what else was logged is a note.
  const held = release().filter((line) => line.message !== "agent pack failed to load");

  const failures: { id: string; error: string; enabled: boolean }[] = [];
  for (const failure of registry.loadFailures()) failures.push({ ...failure, enabled: await packEnabled(join(config.daemon.agentsDir, failure.id)) });
  const failed = failures.filter((failure) => failure.enabled);
  const parked = failures.filter((failure) => !failure.enabled);
  const verdict = failed.length > 0 ? `this configuration would start, but ${failed.length} ${plural(failed.length, "agent")} will not load` : null;

  if (verdict) {
    say(`${RED}✗${RESET} ${verdict}`);
    // Set here, beside the line that says it: the lines below are what failed, and why.
    process.exitCode = 1;
  } else {
    say(`${GREEN}✓${RESET} this configuration would start`);
  }
  say(`${DIM}  source    ${source ?? "built-in defaults"}${RESET}`);
  say(`${DIM}  agents    ${registry.enabled().length} enabled${failed.length > 0 ? `, ${failed.length} will not load` : ""}${RESET}`);
  say(`${DIM}  gateways  ${config.gateways.filter((g) => g.enabled).map((g) => g.id).join(", ") || "none"}${RESET}`);
  say(`${DIM}  providers ${providersLine(config.providers)}${RESET}`);

  // Booting and working are different questions. Everything above answers the first; these are the
  // combinations that start fine and then fail at the first call — an endpoint the SSRF guard
  // refuses, a queue timeout below the turn deadline. Reported, never fatal: this command's verdict
  // is about whether the daemon comes up.
  const secretSet = await commandSecretLookup({ dataDir: config.daemon.dataDir, configPath: source ?? defaultConfigPath() });
  const lints = lintConfig(config, secretSet ? { secretSet } : {});
  const said = [...notes, ...(source ? await broughtForward(source) : []), ...held.map((line) => ({ ...noteOf(line), agent: line.agent_id }))];
  if (failures.length > 0 || lints.length > 0 || said.length > 0) say("");
  for (const failure of failed) say(`${RED}✗${RESET} agent ${failure.id} will not load: ${failure.error}`);
  for (const failure of parked) say(`${YELLOW}!${RESET} agent ${failure.id} is disabled, and would not load: ${failure.error}`);
  for (const note of said) {
    const who = "agent" in note && note.agent ? `agent ${note.agent}: ` : "";
    say(`${YELLOW}!${RESET} ${who}${note.message}${note.detail ? ` ${DIM}(${note.detail})${RESET}` : ""}`);
    if (note.hint) say(`${DIM}  ${note.hint}${RESET}`);
  }
  for (const lint of lints) {
    const mark = lint.level === "bad" ? `${RED}✗${RESET}` : `${YELLOW}!${RESET}`;
    say(`${mark} ${lint.message}`);
    say(`${DIM}  ${lint.hint}${RESET}`);
  }
  emit({
    starts: true,
    source: source ?? null,
    agents: registry.active().map((agent) => agent.config.id),
    gateways: config.gateways.filter((g) => g.enabled).map((g) => g.id),
    providers: Object.entries(config.providers).map(([name, profile]) => ({
      name,
      kind: profile.kind,
      ...(profile.kind === "openai" ? { maxTokensField: profile.maxTokensField ?? "max_tokens" } : {}),
    })),
    failed: failed.map(({ id, error }) => ({ id, error })),
    disabledFailed: parked.map(({ id, error }) => ({ id, error })),
    lints,
    notes: said,
    ...(verdict ? { error: verdict } : {}),
  });
}

/**
 * `nouride config schema [section]` — every valid key, for something with no source to read.
 *
 * JSON rather than prose because the first reader is an agent, and JSON Schema because that is the
 * one shape a model does not have to be taught. Nested to match the TOML: the mistake this answers is
 * `[web]` versus `[security.web]`, and a flat list of dotted paths would answer the easy half.
 *
 * Talks to no daemon on purpose. It has to work on a box where the config is broken enough that
 * nothing is running, which is exactly when someone needs it.
 */
function configSchemaCmd(args: string[]): void {
  const section = args[0];
  if (section && fieldsIn(section).length === 0) {
    fail(`no such section: ${section}`, `try one of: ${sections().join(", ")}`);
  }
  const schema = configJsonSchema(section);
  emit(schema);
  say(JSON.stringify(schema, null, 2));
}

/** The config's top-level sections, for a name that is not one of them. */
function sections(): string[] {
  return [...new Set(describeConfig().map((f) => f.path.split(".")[0]!))].sort();
}

/**
 * When a change to a key takes effect (`ConfigField.live`). The hand edit is said for both, because that is the
 * surprise: a key the dashboard applies at once still waits for a restart when `config.toml` is edited by hand.
 */
function appliesLine(live: boolean): string {
  return live
    ? "at once when saved from the dashboard or a nouride command, but a hand edit to config.toml waits for a restart"
    : "after a restart: the daemon reads it at boot, so a saved change waits for `nouride restart`";
}

/**
 * `nouride config explain <path>` — one key, and the thing about it that is not guessable.
 *
 * The caveat is the point. A type and a default can be inferred from a working example; "this does
 * nothing until you also set that" cannot, and it is where the trial-and-error goes.
 */
function configExplainCmd(args: string[]): void {
  const path = args[0];
  if (!path) usageError("usage: nouride config explain <path>", "e.g. security.web.search_endpoint");

  const field = findField(path);
  if (!field) {
    // Near misses rather than the whole list, and the *section's* keys rather than a substring match:
    // the common failure is a typo in the last segment, which matches nothing by substring — so
    // "search_endpont" would have printed no suggestions at all, which is the moment they are wanted.
    const section = path.split(".").slice(0, -1).join(".");
    const near = section ? fieldsIn(section) : describeConfig();
    fail(
      `no such key: ${path}`,
      near.length > 0 && near.length <= 20
        ? `keys in ${section || "the config"}:\n${near.map((candidate) => `    ${candidate.path}`).join("\n")}`
        : `sections: ${sections().join(", ")}`,
    );
  }

  const section = field.path.split(".").slice(0, -1).join(".");
  const key = field.path.split(".").pop()!;
  emit(field);

  say(`${BOLD}${field.path}${RESET}`);
  say(`${DIM}type    ${RESET}${field.type}${field.enum ? `, one of ${field.enum.map((v) => `"${v}"`).join(", ")}` : ""}`);
  say(
    `${DIM}default ${RESET}${
      field.default === undefined ? "(unset)" : JSON.stringify(field.default)
    }`,
  );
  if (field.secretRef) {
    say(`${DIM}holds   ${RESET}the ${BOLD}name${RESET} of a credential, resolved at call time, never the value itself`);
  }
  say(`${DIM}applies ${RESET}${appliesLine(field.live)}`);
  // Rarely needed, so the example file leaves it out — said here, where somebody who needs it is already looking.
  if (field.advanced) say(`${DIM}advanced${RESET} rarely changed: left out of config.example.toml; the docs' Advanced settings list it`);
  if (field.description) {
    say("");
    say(field.description);
  }
  if (field.caveat) {
    say("");
    say(`${YELLOW}watch out${RESET}  ${field.caveat}`);
  }
  say("");
  say(`${DIM}in TOML${RESET}`);
  if (field.example) {
    for (const line of field.example.split("\n")) say(`  ${line}`);
  } else if (section) {
    say(`  [${section}]`);
    say(`  ${key} = ${field.default === undefined ? "…" : JSON.stringify(field.default)}`);
  } else {
    say(`  ${key} = ${field.default === undefined ? "…" : JSON.stringify(field.default)}`);
  }
}
