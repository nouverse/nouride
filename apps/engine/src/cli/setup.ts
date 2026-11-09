/**
 * `nouride setup` — turn an empty directory into a working install.
 *
 * The dashboard wizard has done this since Phase 3, and it is the right flow for someone who has a
 * browser. On a server reached over SSH it is not: the dashboard needs the daemon running, the daemon
 * needs a port forwarded, and the whole point of the native shape is that it can be driven from a
 * terminal. So this drives the *same* `SetupService` — the profile write, the live provider probe, the
 * pack scaffold — rather than reimplementing any of it. A second implementation of "create an agent"
 * would drift from the first, and the two would disagree about what a valid install looks like.
 *
 * It runs **before** the daemon, not against it. `nouride setup && nouride start` is the sequence, so
 * the pieces it needs — the secret store, the provider registry, the agent registry — are built here
 * exactly as `index.ts` builds them at boot. In Docker the daemon is up first and setup runs beside it
 * (`docker compose exec`): the store is safe for two writers (`SecretStore`), and the next step it
 * prints is the daemon's restart, since what setup writes is read when the daemon starts.
 *
 * ## Credentials never arrive as arguments
 *
 * There is no `--api-key`. A key on a command line is in the shell history, in `ps` output for as long
 * as the process runs, and in any CI log that echoes its commands. `--api-key-from-env` names a
 * variable instead, and the interactive path reads the value without echoing it. What lands in
 * `config.toml` either way is the secret's *name* (invariant 3).
 */

import {
  ensureDir,
  fileExists,
  join,
  openLinePrompt,
  type LinePrompt,
} from "@nouride/runtime";
import { openCommandSecretStore } from "@/boot/secret-store.ts";
import { AgentRegistry } from "@nouride/persona";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { FIRST_AGENT } from "@/modules/setup/presets.ts";
import { SetupService } from "@/modules/setup/service.ts";
import type { ProviderKind } from "@/modules/setup/probe.ts";
import { flagValue, hasFlag } from "@/cli/args.ts";
import { restartHint } from "@/cli/client.ts";
import { runningDaemon } from "@/cli/daemon-lock.ts";

const RESET = "\x1b[0m";
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function flag(args: string[], name: string): string | undefined {
  return flagValue(args, `--${name}`);
}

function has(args: string[], name: string): boolean {
  return hasFlag(args, `--${name}`);
}

/** Endpoints that come with the wire format, so nobody has to look them up. */
const KNOWN_ENDPOINTS: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};

export async function setup(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const configPath = flag(args, "config") ?? defaultConfigPath(cwd);
  const unattended = has(args, "yes");
  // A TTY is what makes a question answerable. Checked rather than assumed: a setup step in a
  // provisioning script has no terminal, and prompting there hangs until the job times out.
  const interactive = Boolean(process.stdin.isTTY) && !unattended;

  if (await fileExists(configPath)) {
    // Refused, not merged. This command writes a provider profile and scaffolds an agent; run against
    // a configured install it would look like a no-op that quietly changed the orchestrator.
    say(`${RED}✗${RESET} ${configPath} already exists: this install is already set up.`);
    say(`${DIM}  edit it directly, or use the dashboard to add a provider or an agent.${RESET}`);
    process.exitCode = 1;
    return;
  }

  const { config } = await loadConfig();
  const { dataDir, agentsDir, workspaceDir } = config.daemon;

  // Created before anything is written into them, and before the first question, so an operator who
  // abandons the prompt still has a directory tree that `nouride start` accepts.
  for (const dir of [
    dataDir,
    agentsDir,
    join(workspaceDir, "shared"),
    join(workspaceDir, "private"),
  ]) {
    ensureDir(dir);
  }

  say(`${BOLD}nouride setup${RESET}`);
  say(`${DIM}  root      ${configPath.replace(/\/config\.toml$/, "")}${RESET}`);
  say(`${DIM}  data      ${dataDir}${RESET}`);
  say(`${DIM}  agents    ${agentsDir}${RESET}`);
  say(`${DIM}  workspace ${workspaceDir}  (shared/ + private/<agent>/)${RESET}`);
  say();

  const prompt: LinePrompt | null = interactive ? openLinePrompt() : null;

  const ask = async (question: string, fallback: string): Promise<string> => {
    if (!prompt) return fallback;
    const suffix = fallback ? ` ${DIM}[${fallback}]${RESET}` : "";
    return (await prompt.ask(`${question}${suffix}: `)).trim() || fallback;
  };

  try {
    // Encrypted from its first value (0.8.19), with the key's places as the daemon will find them.
    const secrets = await openCommandSecretStore({ dataDir, configPath });
    const providers = new ProviderRegistry(config.providers, secrets);
    const registry = await AgentRegistry.create({
      agentsDir,
      llmDefaults: config.llm.defaults,
      // A function, not a snapshot: the profile is written a few lines below, and the agent created
      // after it names that profile. A list taken now would not contain it yet.
      knownProviders: () => providers.names(),
    });

    const service = new SetupService({
      config,
      configPath,
      dataDir,
      agentsDir,
      secrets,
      providers,
      registry,
      userCount: () => 1,
    });

    // ── provider ────────────────────────────────────────────────────────────
    const kindInput = flag(args, "provider") ?? (await ask("provider  anthropic | openai", "anthropic"));
    if (kindInput !== "anthropic" && kindInput !== "openai") {
      say(`${RED}✗${RESET} provider must be "anthropic" or "openai", got "${kindInput}"`);
      process.exitCode = 1;
      return;
    }
    const kind: ProviderKind = kindInput;
    const baseUrl = flag(args, "base-url") ?? (await ask("base_url ", KNOWN_ENDPOINTS[kind]));

    const envVar = flag(args, "api-key-from-env");
    const apiKey = envVar ? process.env[envVar] : await askSecret(prompt, "api key ");
    if (!apiKey) {
      say(
        envVar
          ? `${RED}✗${RESET} $${envVar} is empty or unset`
          : `${RED}✗${RESET} an api key is required: pass --api-key-from-env VAR when unattended`,
      );
      process.exitCode = 1;
      return;
    }

    // The endpoint is called before anything is written. A key that does not work is the single most
    // common way a fresh install fails, and it surfaces on the agent's first message — long after
    // setup said it had succeeded.
    say(`${DIM}  probing ${baseUrl} …${RESET}`);
    const saved = await service.saveProvider({ kind, baseUrl, apiKey, actor: "cli" });
    if (!saved.ok) {
      say(`${RED}✗${RESET} ${saved.error}`);
      process.exitCode = 1;
      return;
    }
    say(`${GREEN}✓${RESET} provider reachable ${DIM}(${saved.models.length} models)${RESET}`);
    say(`${DIM}  key stored as secret "${saved.secret}" in ${join(dataDir, "secrets.enc")}, encrypted${RESET}`);
    say(`${DIM}  config.toml holds the NAME, never the value${RESET}`);

    // ── first agent ─────────────────────────────────────────────────────────
    // A Nourider named Nourider unless told otherwise, as the dashboard's wizard makes it.
    const agentId = flag(args, "agent") ?? (await ask("agent id ", FIRST_AGENT.id));
    const displayName = flag(args, "name") ?? (agentId === FIRST_AGENT.id ? FIRST_AGENT.name : agentId);

    // Asked, not assumed. The default is the first model the endpoint listed, which is meaningful for
    // a vendor API and arbitrary for a proxy — a real run against Nougate listed **414**, and taking
    // `[0]` silently picked one of them. The dashboard shows this list; so does this.
    let model = flag(args, "model") ?? "";
    if (!model) {
      const suggested = saved.models[0] ?? "";
      if (prompt && saved.models.length > 1) {
        const preview = saved.models.slice(0, 5).join(", ");
        const more = saved.models.length > 5 ? `, … ${saved.models.length - 5} more` : "";
        say(`${DIM}  models: ${preview}${more}${RESET}`);
      }
      model = await ask("model ", suggested);
    }
    if (!model) {
      say(`${YELLOW}!${RESET} no model could be determined: pass --model`);
      process.exitCode = 1;
      return;
    }
    if (saved.models.length > 0 && !saved.models.includes(model)) {
      // A warning, not a refusal: proxies routinely serve models their listing omits, and refusing
      // here would block the deployment this daemon was written for.
      say(`${YELLOW}!${RESET} "${model}" is not in the endpoint's listing, continuing anyway`);
    }

    // Every field the dashboard wizard collects, so the two paths produce the same pack rather than
    // merely calling the same code. They already shared `SetupService`; what differed was what got
    // *asked*, and a CLI install that silently skipped the persona produced an agent with a generic
    // SOUL.md — the same service, a different agent. (Who the operator is is not asked: People holds that.)
    // Empty is the Nourider's own SOUL.md, the one the wizard fills in.
    const systemPrompt = flag(args, "prompt") ?? (await ask("persona  one line (enter for the Nourider's)", ""));

    // What its peers read to decide whom to ask — one short line, not the persona. Empty is the preset's.
    const headline = flag(args, "headline") ?? (await ask("headline  one short line, what to bring it (enter for the default)", ""));

    const created = await service.createAgent({
      id: agentId,
      displayName,
      systemPrompt,
      model,
      actor: "cli",
      ...(headline ? { headline } : {}),
      // Off unless asked. `exec` is the one capability whose blast radius is the host rather than a
      // file, and a setup default is the wrong place to hand it out.
    });
    if (!created.ok) {
      say(`${RED}✗${RESET} ${created.error}`);
      process.exitCode = 1;
      return;
    }

    say(`${GREEN}✓${RESET} agent ${BOLD}${created.id}${RESET} ${DIM}(${model} via ${created.provider})${RESET}`);
    say();
    say(`${DIM}next:${RESET}`);
    if (runningDaemon(dataDir) !== null) {
      // A daemon already up — Docker's docs start it first and run setup beside it — reads config.toml and the pack
      // only when it starts, and `nouride start` there is a second daemon its lock refuses (0.8.15).
      say(`  ${restartHint()}   ${DIM}# the running daemon reads what setup wrote when it starts again${RESET}`);
    } else {
      say(`  nouride start        ${DIM}# then talk to it${RESET}`);
      say(`  nouride chat         ${DIM}# from this directory${RESET}`);
    }
  } finally {
    prompt?.close();
  }
}

/**
 * Read a secret without echoing it.
 *
 * ## Why this is not raw mode
 *
 * The first version put stdin into raw mode and read it with `for await (const chunk of stdin)`. That
 * is a **second consumer** on a stream `readline` already owns, and on the first real run — against an
 * operator's actual provider key — it failed in three ways at once:
 *
 *   1. The key was echoed in full. Raw mode changes nothing while readline is still driving the
 *      terminal, and readline echoed the line as it was typed.
 *   2. `break` out of the async iterator *destroyed* stdin, surfacing as a bare
 *      `AbortError: The operation was aborted` from `createAsyncIterator`.
 *   3. Every later question hung forever, waiting on a stream that no longer existed.
 *
 * So there is exactly one consumer now. Echo is suppressed by muting the output readline writes to,
 * which is the only surface those characters ever reach.
 */
async function askSecret(prompt: LinePrompt | null, label: string): Promise<string | undefined> {
  if (!prompt) return undefined;
  return (await prompt.askHidden(`${label}${DIM}(hidden)${RESET}: `)).trim() || undefined;
}
