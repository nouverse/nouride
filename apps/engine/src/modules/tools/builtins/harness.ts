/**
 * Tools that let an agent operate the harness it runs inside: create another agent, look at
 * which models are reachable, change its own model, reload from disk.
 *
 * **Why these are not just `write`.** `write` is confined to the calling agent's own directory
 * by `resolveWithin`, which is what stops one agent from rewriting another's SOUL — the isolation
 * boundary in TD-008 and TD-013. Widening that to reach `agents/` would trade a real guarantee
 * for convenience. A purpose-built tool can create a *new* pack while still being unable to touch
 * an existing one, which is exactly the capability wanted and nothing more.
 *
 * All of these are approval-gated by default (see DEFAULT_APPROVAL_REQUIRED in
 * `@nouride/persona`): they change what the daemon will do after the conversation ends.
 */

import type { LinkFor } from "@/modules/web/links.ts";
import { cleanHeadline, HEADLINE_MAX } from "@/modules/setup/identity-headline.ts";
import { join, listDir, removePath, writeTextFileAtomic } from "@nouride/runtime";
import { editPackFile } from "@/modules/config/config-file.ts";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { createLogger, LOOK_PARTS, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import { underHeading, type AgentRegistry } from "@nouride/persona";
import type { AuditPort } from "@/commons/audit.store.ts";
import { STARTER_AGENTS, STARTER_MEMORY, STARTER_README } from "@/modules/setup/starter-pack.ts";
import { externalAgentLlm } from "@/modules/setup/external-agent.ts";
import { EFFORT_CHOICES, isEffortChoice, withEffort } from "@/modules/setup/agent-effort.ts";
import { cliModelChange, cliModelNotice, type CliModels } from "./cli-model.ts";

const log = createLogger("tools.harness");

/** Agent ids: lowercase, hyphenated, and a valid directory name. */
const VALID_ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Ids that are not agents.
 *
 * `skills` is `agents/skills/` — the pool every agent draws from — and `shared` may hold an install's
 * `.credentials`. Both are skipped by `discoverAgents`, so a pack created under either name would be
 * written to disk and then silently never load: the tool reports success and the agent does not exist.
 */
const RESERVED_IDS = new Set(["shared", "skills", "example"]);

export interface HarnessToolOptions {
  registry: AgentRegistry;
  agentsDir: string;
  /** Provider profile names from the daemon config, and whether each has a credential. */
  providers: () => { name: string; kind: string; baseUrl: string; hasCredential: boolean }[];
  audit?: AuditPort;
  /** The coding CLIs this install knows, and whether each is installed here (0.8.1). Absent: no external agents. */
  clis?: () => Promise<{ id: string; name: string; installed: boolean; install: string }[]>;
  /** The link to a new external agent's sign-in, where one goes into this chat (`web/links.ts`). None: the way there, in words. */
  linkFor?: LinkFor;
  /** The install's default model and the orchestrator's, for a new agent's `[llm]` (`externalAgentLlm`). */
  llm: { defaults: () => { provider: string; model: string }; orchestrator: () => { provider: string; model: string } | undefined };
  /** A coding-CLI agent's CLI, for `agent_configure` to set its model (0.8.8, `cli-model.ts`). Absent: no external agents. */
  cliModels?: (agentId: string, cli: string) => CliModels;
  /** A line from the daemon into the chat a call came from; false where it did not land. */
  tell?: (ctx: ToolContext, text: string) => Promise<boolean>;
}

/** A `[look]` part's key in a pack, e.g. `outfit_color`. */
const LOOK_KEYS: readonly string[] = Object.values(LOOK_PARTS).map((part) => part.key);

/** `external` as given: the CLI, the account and the CLI's model, or what is wrong with it. */
function externalArg(raw: unknown): { cli: string; profile?: string; model?: string } | { error: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const table = raw as { cli?: unknown; profile?: unknown; model?: unknown };
  if (typeof raw !== "object" || typeof table.cli !== "string" || !table.cli.trim()) return { error: "`external` takes the CLI's id as `cli`. `nouride agents scan` lists them." };
  const profile = typeof table.profile === "string" && table.profile.trim() ? table.profile.trim() : undefined;
  const model = typeof table.model === "string" && table.model.trim() ? table.model.trim() : undefined;
  return { cli: table.cli.trim(), ...(profile ? { profile } : {}), ...(model ? { model } : {}) };
}

/** `look` as given: its parts by their pack keys, or the part it does not know. */
function lookArg(raw: unknown): Record<string, string> | { error: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: `\`look\` is a table of parts: ${LOOK_KEYS.join(", ")}.` };
  const parts = Object.entries(raw as Record<string, unknown>);
  const unknown = parts.find(([key]) => !LOOK_KEYS.includes(key));
  if (unknown) return { error: `"${unknown[0]}" is not a part of a look: ${LOOK_KEYS.join(", ")}.` };
  // Each word checked here, before anything is written: the loader's refusal came after, one part a try (0.8.1).
  for (const [key, value] of parts) {
    const words: readonly string[] = Object.values(LOOK_PARTS).find((part) => part.key === key)!.values;
    if (!words.includes(String(value))) return { error: `look's ${key} is one of ${words.join(", ")}, not "${String(value)}".` };
  }
  return Object.fromEntries(parts.map(([key, value]) => [key, String(value)]));
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: false, ...(metadata ? { metadata } : {}) };
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * `agent_create` — write a new persona pack.
 *
 * Refuses to overwrite: an existing directory means an existing identity, possibly with memory
 * the agent has been accumulating for months, and "create" must never be a destructive verb.
 */
export function createAgentCreateTool(options: HarnessToolOptions): Tool {
  return {
    requiresApproval: true,
    // A new agent's `config.toml` is the one that says what it may run: on the fixed list, as any config written is.
    fixedList: () => ({ class: "config", reason: "writes a new agent's config.toml: the tools it may use and the model it runs on" }),
    definition: {
      name: "agent_create",
      description:
        "Create a new agent: writes agents/<id>/IDENTITY.md, SOUL.md, AGENTS.md, MEMORY.md and config.toml, then loads it. Fails if the id already exists. The new agent starts disabled unless enable is true. Ask the person first: the nouride skill's adding-an-agent guide.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Directory name: lowercase, hyphens, e.g. nox" },
          display_name: { type: "string", description: "Human-facing name" },
          emoji: { type: "string" },
          headline: { type: "string", description: "What it is for, one line of ≤150 characters" },
          soul: { type: "string", description: "SOUL.md body: personality, tone, behaviour rules" },
          provider: { type: "string", description: "The provider profile of Nouride's own model for it; omit for the default" },
          model: {
            type: "string",
            description: "Nouride's own model for it; omit for the default. For an external agent, what answers when its CLI cannot (the CLI's own model is `external.model`)",
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description:
              "Tool names the new agent may use. Omit for the default set: read, glob, grep, plan, delegate, ask_agent, web_fetch, web_search, memory tools, person_record, send_file, session_status and the `nouride` CLI (no exec, write or edit).",
          },
          enable: { type: "boolean", description: "Start it immediately (default false)" },
          external: {
            type: "object",
            description: "A coding CLI installed here answers it instead of a model. Omit for one Nouride runs.",
            properties: {
              cli: { type: "string", description: "Its id, from `nouride agents scan`" },
              profile: { type: "string", description: "The CLI account it answers with, e.g. default" },
              model: { type: "string", description: "The CLI's own model, as the CLI names it; omit for the CLI's default" },
            },
            required: ["cli"],
          },
          look: {
            type: "object",
            description: "Its cat in the Office, by part; a part left out comes from its id",
            properties: Object.fromEntries(Object.values(LOOK_PARTS).map((part) => [part.key, { type: "string", enum: [...part.values] }])),
          },
        },
        required: ["id", "headline", "soul"],
      },
    },

    async execute(args, ctx) {
      const id = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
      if (!VALID_ID.test(id)) {
        return fail(
          `"${id}" is not a valid agent id: lowercase letters, digits and hyphens, starting with a letter, 2–32 characters.`,
        );
      }
      if (RESERVED_IDS.has(id)) return fail(`"${id}" is reserved.`);
      if (options.registry.get(id)) return fail(`An agent called "${id}" already exists.`);

      const dir = join(options.agentsDir, id);
      if (listDir(dir).length > 0) {
        // On disk but not in the registry: a pack that failed to load, or somebody's files. Writing over them would
        // destroy whatever is there — a MEMORY.md that exists nowhere else — while looking like a fresh create; and
        // only a directory this call made is one it may remove again when the pack does not load.
        return fail(
          `agents/${id}/ already exists on disk but did not load. Fix or remove it rather than overwriting.`,
        );
      }

      if (typeof args.headline !== "string" || typeof args.soul !== "string") {
        return fail("`headline` and `soul` must both be strings.");
      }
      const headline = cleanHeadline(args.headline);
      if (!headline) return fail(`\`headline\` is one short line, 1–${HEADLINE_MAX} characters: what to bring this agent.`);

      const displayName =
        typeof args.display_name === "string" && args.display_name.trim()
          ? args.display_name.trim()
          : id;
      const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";

      const providerName = typeof args.provider === "string" ? args.provider : undefined;
      if (providerName) {
        const known = options.providers().map((p) => p.name);
        if (!known.includes(providerName)) {
          return fail(
            `Provider profile "${providerName}" is not configured. Available: ${known.join(", ")}.`,
          );
        }
      }

      const tools = Array.isArray(args.tools) ? args.tools.map(String) : undefined;

      const external = externalArg(args.external);
      if (external && "error" in external) return fail(external.error);
      const look = lookArg(args.look);
      if (look && "error" in look) return fail(look.error);
      // Nouride's own model for it (`[llm]`): as named, else — for an external agent — the install's default or the
      // orchestrator's (`externalAgentLlm`). A model with no provider where the install has no default one left
      // `[llm] provider ""` and a pack that did not load (0.8.1, the live box): said here, before anything is written.
      const defaults = options.llm.defaults();
      const named = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
      const fallback = external && !named && !providerName ? externalAgentLlm(defaults, options.llm.orchestrator()) : null;
      const llmProvider = providerName || fallback?.provider;
      const llmModel = named ?? fallback?.model;
      if (!llmModel && !defaults.model.trim()) return fail("This install has no default model: give `model`, with its `provider`. `nouride provider` lists the profiles.");
      if (!llmProvider && !defaults.provider.trim()) return fail(`This install has no default provider: give \`provider\` with \`model\`; the providers are ${options.providers().map((p) => p.name).join(", ")}.`);
      // A CLI that is not installed here could not answer it: said before anything is written, with how to install it.
      let cli: { name: string } | undefined;
      if (external) {
        const clis = (await options.clis?.()) ?? [];
        const row = clis.find((candidate) => candidate.id === external.cli);
        if (!row) return fail(`"${external.cli}" is not a coding CLI this install knows${clis.length > 0 ? `: ${clis.map((candidate) => candidate.id).join(", ")}` : ""}.`);
        if (!row.installed) {
          return fail(
            `${row.name} is not installed on this machine, so an agent on it could not answer. Install it first (${row.install}): ` +
              "the orchestrator can, through `nouride tools run`, or whoever runs this machine; then ask again.",
          );
        }
        cli = row;
      }

      await writeTextFileAtomic(
        join(dir, "IDENTITY.md"),
        [
          "# IDENTITY",
          "",
          `- **Name:** ${displayName}`,
          `- **Headline:** ${headline}`,
          ...(emoji ? [`- **Emoji:** ${emoji}`] : []),
          `- **Created by:** ${ctx.agentId}`,
          "",
        ].join("\n"),
      );

      await writeTextFileAtomic(join(dir, "SOUL.md"), `${underHeading("SOUL", args.soul)}\n`);
      await writeTextFileAtomic(join(dir, "AGENTS.md"), STARTER_AGENTS);
      await writeTextFileAtomic(join(dir, "MEMORY.md"), STARTER_MEMORY);
      // Not loaded by anything: orientation for whoever edits this pack, at no cost in the prompt.
      await writeTextFileAtomic(join(dir, "README.md"), STARTER_README);

      // Not through `editPackFile`: a new pack, written whole — and removed whole when it does not load.
      await writeTextFileAtomic(
        join(dir, "config.toml"),
        [
          "# Written by agent_create. Hand-edit freely: this is config-as-code.",
          "",
          "[agent]",
          `display_name = ${JSON.stringify(displayName)}`,
          ...(emoji ? [`emoji = ${JSON.stringify(emoji)}`] : []),
          `enabled = ${args.enable === true}`,
          "",
          ...(llmProvider || llmModel
            ? ["[llm]", ...(llmProvider ? [`provider = ${JSON.stringify(llmProvider)}`] : []), ...(llmModel ? [`model = ${JSON.stringify(llmModel)}`] : []), ""]
            : []),
          ...(tools ? ["[tools]", `enabled = ${JSON.stringify(tools)}`, ""] : []),
          ...(external
            ? ["[external]", `cli = ${JSON.stringify(external.cli)}`, ...(external.profile ? [`profile = ${JSON.stringify(external.profile)}`] : []), ...(external.model ? [`model = ${JSON.stringify(external.model)}`] : []), ""]
            : []),
          ...(look && Object.keys(look).length > 0 ? ["[look]", ...Object.entries(look).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), ""] : []),
        ].join("\n"),
      );

      try {
        await options.registry.reload(id);
      } catch (err) {
        // Removed whole, as `nouride setup` does: left behind, the next attempt at this id fails on "already exists"
        // and the next boot carries a pack that does not load.
        removePath(dir);
        return fail(`agents/${id}/ did not load, so nothing was kept: ${String(err)}`);
      }

      options.audit?.record({
        action: "agent_created",
        agentId: ctx.agentId,
        actor: ctx.senderId,
        details: { created: id, enabled: args.enable === true },
      });
      log.info("agent created", { by: ctx.agentId, created: id });

      // An external agent answers nothing until its CLI is signed in — on its Brain tab, so the code never passes a chat.
      const signIn = external
        ? ` It answers with ${cli?.name ?? external.cli} on the account "${external.profile ?? "default"}", and cannot until that is signed in. Sign in at ` +
          `${options.linkFor?.(ctx, { kind: "agent-cli", agentId: id }) ?? `the dashboard, Agents → ${displayName} → Brain`} and finish it there; never ask for the code in a chat.`
        : "";
      return ok(
        `Created agent "${id}" (${displayName})${args.enable === true ? " and enabled it" : `, disabled. Turn it on with the \`nouride\` tool: {"args": ["agent", "enable", "${id}"]}`}. ` +
          `Its files are at agents/${id}/.${signIn}`,
        { created: id },
      );
    },
  };
}

/**
 * `agent_configure` — change the caller's own model, provider or effort, persistently. Effort (0.8.7) is how long its
 * model thinks, and its coding CLI's where the CLI offers that level: asked to think harder, an agent had no way to. A
 * coding CLI's agent sets its CLI's model too (0.8.8, `cli-model.ts`), never its `[llm]`.
 *
 * Scoped to the calling agent: `ctx.agentId`, not a parameter. An agent reconfiguring a
 * *different* agent's model is the same isolation break as writing its SOUL, and there is no
 * use case for it that an operator could not do better.
 *
 * Distinct from `/model`, which is a session override that dies with the conversation.
 */
export function createAgentConfigureTool(options: HarnessToolOptions): Tool {
  return {
    requiresApproval: true,
    fixedList: () => ({ class: "config", reason: "changes this agent's own config.toml (its provider, model or effort) for every turn after" }),
    definition: {
      name: "agent_configure",
      description:
        "Change your own provider profile, model and/or effort in your config.toml, persistently. To see which profiles exist and which have a credential, first run the `nouride` tool with `{\"args\": [\"provider\"]}`. " +
        "On a coding CLI, `model` is your CLI's, one it offers on your account, and your chat is told; your provider and [llm] stay the dashboard's.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "A configured provider profile name" },
          model: { type: "string" },
          effort: { type: "string", enum: [...EFFORT_CHOICES], description: "How long you think: your model's, and your coding CLI's where it offers it. default: the install's." },
        },
      },
    },

    async execute(args, ctx) {
      const provider = typeof args.provider === "string" ? args.provider : undefined;
      const model = typeof args.model === "string" ? args.model : undefined;
      const effort = args.effort === undefined ? undefined : isEffortChoice(args.effort) ? args.effort : null;
      if (effort === null) return fail(`\`effort\` is one of ${EFFORT_CHOICES.join(", ")}.`);
      if (!provider && !model && !effort) return fail("Give at least one of `provider`, `model` or `effort`.");
      // A coding CLI's model is its CLI's (`[external]`); `[llm]`'s is the one Nouride answers its reviews and memory
      // with, and stays the dashboard's. "Use opus" sets the CLI's, to one it offers on the account (0.8.8).
      const agent = options.registry.get(ctx.agentId);
      const external = agent?.config.external;
      if (external && provider) return fail("Your provider is Nouride's own, for its reviews and memory: a person sets it on the dashboard. `model` here is your coding CLI's.");
      const cli = external && model ? cliModelChange(model, external, options.cliModels?.(ctx.agentId, external.cli)) : null;
      if (cli && "refused" in cli) return fail(cli.refused);

      if (provider) {
        const known = options.providers();
        const match = known.find((p) => p.name === provider);
        if (!match) {
          return fail(
            `Provider profile "${provider}" is not configured. Available: ${known.map((p) => p.name).join(", ")}.`,
          );
        }
        if (!match.hasCredential) {
          // Switching to a profile with no key would break the agent on its next message, and it
          // would have no way to connect that failure to this call.
          return fail(
            `Profile "${provider}" has no credential set, so switching to it would break your next message.`,
          );
        }
      }

      // Checked, written and reloaded as one — and put back when it no longer loads, which leaving it would make an
      // agent gone at the next restart (`config/config-file.ts`).
      const saved = await editPackFile({
        path: join(options.agentsDir, ctx.agentId, "config.toml"),
        reload: () => options.registry.reload(ctx.agentId),
        // The one editor every config write uses: it found `model =` in any table and missed a commented `[llm]`.
        edit: (existing) => {
          const set = { ...(provider ? { provider } : {}), ...(model && !cli ? { model } : {}) };
          const llm = Object.keys(set).length > 0 ? upsertTomlTable(existing, "llm", set) : existing;
          // The key the CLI tab writes: the next turn sets it in the session already open, as a change there is.
          const next = cli ? upsertTomlTable(llm, "external", { model: cli.to }) : llm;
          return effort ? withEffort(next, effort) : next;
        },
      });
      if (!saved.ok) return fail(saved.error);

      options.audit?.record({
        action: "agent_configured",
        agentId: ctx.agentId,
        actor: ctx.senderId,
        details: cli ? { cliModel: cli.to, from: cli.from, account: cli.account, cli: external?.cli, effort } : { provider, model, effort },
      });

      if (cli) {
        const told = await options.tell?.(ctx, cliModelNotice(agent?.config.displayName ?? ctx.agentId, cli));
        return ok(
          `Your ${cli.cli} model is now ${cli.to} (it was ${cli.from}), on the account "${cli.account}": kept in your pack, and set in this session from your next turn. Your [llm] is unchanged.` +
            `${effort ? ` Effort: ${effort}.` : ""} ${told ? "The person here was told." : "This chat could not be told; the audit log has it."}`,
        );
      }

      return ok(
        `Updated your config: ${[provider && `provider=${provider}`, model && `model=${model}`, effort && `effort=${effort}`]
          .filter(Boolean)
          .join(", ")}. Reloaded: it takes effect on your next message.`,
      );
    },
  };
}

