# Config and secrets

Three sources, each with one job:

| Source | Holds | Lifetime |
|---|---|---|
| `.nouride/config.toml` | daemon settings, provider profiles, gateway instances | hot-reloadable |
| `agents/<id>/config.toml` | per-agent model, channels, tools (skills are `skills.toml`) | hot-reloadable |
| `agents/mcp.toml` | the install's MCP servers, the library (`[[servers]]`, since 0.7.19) | hot-reloadable; a write reloads the agents using it |
| `agents/<id>/mcp.toml` | which library servers the agent uses, and its own credential for each — rendered whole, like `skills.toml` | hot-reloadable |
| `.env` / `.nouride/data/secrets.enc` | credentials only | env needs a restart; the store does not |

---

## `defaults.ts` is the schema

`apps/engine/src/modules/config/defaults.ts` is not just fallback values — `mergeConfig` treats it
as the shape of a valid config. A camelized key that does not exist there is reported as a
typo and dropped:

```
warn  unknown config key ignored  key=daemon.log_levl
```

**So an optional setting must be listed as `undefined`, not omitted:**

```ts
daemon: {
  // …
  orchestrator: undefined,   // omit this line and `orchestrator` becomes unsettable
}
```

`structuredClone` preserves own properties whose value is `undefined`, which is what makes
this work.

### Adding a fixed config key

1. Add the field to the right interface in `packages/shared/src/types/config.ts`.
2. Add its default to `defaults.ts` — `undefined` if optional.
3. Add it to `config.example.toml` in snake_case, with a comment saying *why* it exists.
4. Describe it in `ANNOTATIONS` (`apps/engine/src/modules/config/schema.docs.ts`) — the
   dashboard's config editor reads it, and `config-schema.test.ts` fails on a leaf of the real
   config that nothing describes.
5. If it has a range or an enum, validate it: structural checks in `validateStructure`
   (inside `parseConfig`, so every entry point gets them), numeric/env-dependent ones in
   `validate` (after `applyEnvOverrides`, because `PORT` can change them) — both in
   `modules/config/global/validate.ts`.
6. Add a case to `apps/engine/tests/config/config.test.ts`.

TOML is snake_case, the codebase is camelCase, and the conversion is automatic. Do not
hand-write a mapper for a fixed section.

**Parse with `parseToml` (`@nouride/runtime`, over `Bun.TOML.parse`), never `import("…toml")`.** The module loader parses TOML but
caches by path and ignores `?v=` and `#fragment`, so an edited file keeps returning its first
parse for the life of the process — which silently broke hot reload and every config-writing
tool while they reported success.

### Two parsing strategies, and why

- **Fixed shape** (`daemon`, `security`, `llm`, `queue`, …) → camelize + deep merge onto
  the defaults. Cheap, and unknown keys get caught.
- **Open shape** (`[providers.*]`, `[gateways.<platform>.<name>]`) → hand-validated field
  by field. The *names* are the user's, so a generic merge cannot tell a new profile from a
  misspelled key. These are pulled out of the raw object before the merge runs, so their
  names are never reported as typos.

Arrays **replace**, never concatenate: `[security.access] allowlist = []` has to be able to mean
"nobody".

### Writing a config file

Never with `writeTextFileAtomic` — `check-arch` refuses it. A save goes through `modules/config/config-file.ts`:
`editDaemonConfig` for the daemon's `config.toml`, `editPackFile` for a file of a pack (it reloads the agent and puts
the file back when it no longer loads), `holdingConfig` when your checks must read what you then change. Each takes
the one file lock, checks the result loads, and keeps `.bak.1`…`.bak.5`.

**Never mirror a save into the live config by hand.** `editDaemonConfig` and `holdingConfig` take the running config
(`null` only where no daemon's copy follows the file: the offline `gateway rename`, the whole-file editor), and
`config/follow.ts` puts in it what the loader makes of the new file — only what the save changed, in place, so a
section held by reference stays the object held. Hand-written mirrors drifted from the loader every time.
`tests/config/running-config.test.ts` walks every writer; a new setter needs a row there.

The text itself is changed by `edit.ts` (tables) and `edit-blocks.ts` (`[[mcp_servers]]`, `[[people]]`), on one
reading of the file (`toml-lines.ts`) that knows literal strings, values over several lines, quoted headers, dotted
keys and inline tables. Every editor returns through `edit-check.ts`: the result must parse to exactly what was
there plus the one change, or the edit is refused. Add a shape to `tests/config/config-edit-corpus.test.ts` when you
meet one people write — the corpus is where "the editor handles this" is proved, not assumed.

---

## Provider profiles

A profile is an **endpoint**, not a vendor: protocol + base URL + credential.

```toml
[providers.nougate-anthropic]
kind = "anthropic"                                       # wire format only
base_url = "https://nougate.nouverse.tech/anthropic/v1"
api_key = "nougate"                                      # a secret NAME

[providers.nougate-openai]
kind = "openai"
base_url = "https://nougate.nouverse.tech/openai/v1"
api_key = "nougate"                                      # the same credential
```

An agent then writes `provider = "nougate-anthropic"`.

This shape exists because the earlier one — one environment variable per vendor — could not
express a single key serving two protocol endpoints of one deployment. **`kind` is only the
wire format.** The model behind `antigravity:claude-sonnet-4-6` on an OpenAI-shaped endpoint
is Claude, and nothing in the engine needs to know that.

**No profile exists by default** (`DEFAULT_PROVIDERS` in `defaults.ts` is empty). Two used to
ship predefined, `anthropic` and `openai`; they were removed so that every endpoint an install
talks to is one somebody wrote down. `provider = "anthropic"` with no `[providers.anthropic]`
fails at load, naming the profiles that do exist. To use the conventional variable, write the
profile and name the secret:

```toml
[providers.anthropic]
kind = "anthropic"
base_url = "https://api.anthropic.com/v1"
api_key = "anthropic_api_key"     # resolves $ANTHROPIC_API_KEY
```

Clients are built lazily in `ProviderRegistry`, one per profile, credential resolved once.
A profile nobody references never needs its key — which is why boot *warns* about an active
agent whose secret is missing instead of failing.

---

## Gateway instances

Every connection is named, so each agent can have its own bot identity.

```toml
[gateways.telegram.nouva]        # instance id: telegram:nouva
enabled = true
token = "telegram-nouva"         # a secret name
agent = "nouva"                  # this bot belongs to Nouva
mode = "polling"                 # webhook is refused while unimplemented

[gateways.telegram.nox]          # a second bot, same daemon
enabled = true
token = "telegram-nox"
agent = "nox"
```

The instance id — `platform:name` — is what flows through everything that must tell two
bots apart: session keys, `[channels]` bindings, outbound routing, gateway state. `gateway`
(the platform) is only for formatting decisions.

`agent = "..."` ranks **above** channel bindings in the router. If you gave Nouva her own
bot, everything it receives is hers; enumerating chat ids would break the first time someone
starts a new conversation with her.

An instance that is `enabled` without a token is refused at parse time — except WhatsApp,
which reaches its own bridge rather than a platform API.

---

## The secret store

Config names a secret; `@nouride/secrets` resolves it:

```
api_key = "nougate"  →  $NOUGATE  →  $NOURIDE_SECRET_NOUGATE  →  .nouride/data/secrets.enc
```

**Environment wins over the store.** A container platform injecting the variable must beat a
stale file in the data volume, or a deployment can be silently overridden by its own disk.
`set()` logs a warning when it stores a name the environment already shadows, because
otherwise that write reads as a dashboard bug.

The store exists because env-only cannot serve a dashboard: adding a bot token would mean a
redeploy. `.nouride/data/secrets.enc` is `0600`, gitignored, and encrypted since 0.8.19 under
`NOURIDE_ENCRYPTION_KEY`, kept as far from the data as the install allows (`store-key.ts`: root's
`/etc/nouride/nouride.env`, the container's environment, else a line in the install's `.env`, else
`.nouride/encryption.key`). It is not hand-editable any more: `nouride secret set`, the dashboard, or
`decrypt` and `restore` for the way back and a lost key. A store whose key is not found refuses the
start; never make a key over it. Each secret carries free fields (`site`, `username`, …), shown
beside its name to people and agents, refused when one has a key's shape.

A CLI command that opens the store opens it with `openCommandSecretStore` (or `commandStoreEnv()`), never with
`process.env`: root runs the CLI through the launcher, as the service account, which cannot read root's key file, so
the launcher hands the key over in the environment and `main.ts` sets it aside before any command runs. A test that
only imports the command misses that path: spawn the CLI (`runCli`), and on a box go through `/usr/local/bin/nouride`,
not the binary itself. 0.8.19's first candidate documented `sudo nouride secret decrypt` and its e2e ran the binary
as root, so the way back failed on every Linux install until the systemd sandbox ran it through the launcher.

**It is write-only from the outside.** `inventory()` returns names and origins, never
values. There is deliberately no API that reads a secret back out, so no HTTP route can be
turned into an exfiltration endpoint. If you need a value, you are inside the daemon and you
call `require(name, usedBy)` — which throws naming both the secret and what wanted it.

`assertSecretName` refuses anything that looks like a credential (`sk-…`, `xoxb-…`, `ghp_…`,
a Telegram bot token shape, anything over 63 chars). Without it, pasting a real key where a
name belongs commits the key into `config.toml` and still appears to work.

### Adding a secret

Nothing to register. Pick a name, reference it from config, and set
`$UPPER_SNAKE_NAME` — or write it from the dashboard's Secrets page. Document it in
`.env.example` **as an example of the mechanism**, not as a fixed list: every variable in
that file is there because something in `config.toml` names it.

---

## Agent config

`agents/<id>/config.toml`, parsed by `packages/persona/src/config.ts` — hand-validated
field by field, because a pack is edited by hand far more often than the daemon config and
deserves an error naming the file, the field and the accepted values.

```toml
[llm]
provider = "nougate-anthropic"   # a [providers.*] profile name
model = "antigravity:claude-sonnet-4-6"

[channels]
"telegram:nouva" = ["-1001234567"]     # keyed by gateway INSTANCE id

[tools]
enabled = ["read", "memory_read", "memory_write"]
approval_required = ["exec", "write", "edit"]
blocked = ["rm", "shutdown"]
```

Defaults worth knowing:

- **Absent `enabled` means enabled.** A directory someone created is one they meant to use;
  parking it is explicit.
- **Absent `[tools] enabled` gives a read-only set**, and absent `approval_required` gates
  the mutating tools. An explicit `enabled = []` means no tools — not the defaults.
- **`approval_required` governs every tool except `exec`.** The tool's own `requiresApproval`
  flag is only the default the loader seeds when a pack says nothing, so the safe posture holds
  by default while an operator who writes the list gets what they asked for.
- **`exec` decides for itself.** What a command asks is the approval level over the fixed list (see
  `references/tools.md`); the list neither adds to nor removes `exec`'s gate. Until 0.8.0 listing
  `exec` was a floor against `[security.exec] ask = "off"`, which went with that knob.
- **Skills are not in this file.** Every agent is offered the whole pool (`agents/skills/`
  plus what ships), and a pack lists only its exceptions in `skills.toml` — see
  `docs/ARCHITECTURE.md` §1.1 for why there is one pool and no per-agent scope.

`knownProviders` and `knownGateways` are passed into the loader so a typo or a stale binding
fails at load with the known list in the message, rather than on the agent's first message.

**When you change this schema, update `content/agents/example/config.toml` in the same pass.**
It is the pack every operator copies; it never ships and the daemon never loads it, so
`apps/engine/tests/contracts/agent-example.test.ts` is the only thing that reads it. The
`[channels]` change to instance ids once broke it, back when it was loaded at boot, and the only
symptom was one error line in the boot log.
