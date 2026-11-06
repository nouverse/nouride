/**
 * What a command this agent runs may see in its environment.
 *
 * The one place a credential turns from a name into a value, and it happens as late as possible:
 * at the moment `exec` spawns a child, for one agent, from the list that agent's pack opted into.
 * Nothing upstream holds a value — not the prompt, not a tool result, not the transcript. A model
 * can therefore use a credential it has never seen, which is the only way to use one safely.
 *
 * `NOURIDE_CREDENTIALS_DIR` rides along for the credentials that cannot be an environment variable:
 * a service-account JSON a library opens by path, an OAuth cache that gets rewritten on refresh.
 * The directory is deliberately not a workspace root, so `read` cannot reach it — see
 * `[security] credentials_dir`.
 *
 * So does the ssh-agent socket, for an agent whose pack says `[security] ssh_agent = true` (S11). A path rather than
 * a key: the safer of the two ways to give an agent SSH, since the key material stays where no command can copy it.
 * But the other end signs with every key it holds for whoever asks, so it is a credential in what it does, and it
 * reaches the agents that need one — not, as it did until 0.7.9, every command of every agent from the allowlist.
 */

import { secretsFor } from "@nouride/policy";
import { createLogger, type ExecSecret } from "@nouride/shared";
import { execEnvAllowlist } from "@/modules/tools/builtins/exec.ts";
import { setCredentialsDir } from "@/modules/tools/credential-files.ts";
import { variableOf, type ChildEnv } from "@/modules/tools/exec-secrets.ts";

const log = createLogger("daemon");

/**
 * Every value an agent's commands could be handed, and what one command is handed: the secrets bound to its argv
 * (`[security.exec_secrets]`, S6). Masking takes the first — it must cover whatever any command could print — and
 * spawning the second, so a `curl` that was not bound to a token never holds one.
 */
export function childEnvFor(deps: {
  credentialsDir: string;
  /** The pack's `exec_secrets`, read per call: a reload or a rotation must apply to the next command. */
  execSecrets: (agentId: string) => ExecSecret[];
  /** The pack's `[security] ssh_agent`, read per call for the same reason. Absent, no agent gets the socket. */
  sshAgent?: (agentId: string) => boolean;
  resolve: (name: string) => string | undefined;
}): ChildEnv {
  // The file tools learn where it is here too: a `read` of anything inside it is refused, whatever the
  // directory is called (`tools/credential-files.ts`).
  setCredentialsDir(deps.credentialsDir);
  const reserved = new Set(execEnvAllowlist());
  const warned = new Set<string>();
  /** The named secrets' values, under the variables they arrive as — those that are set. */
  const valuesOf = (agentId: string, names: readonly string[]): CommandValues => {
    const env: Record<string, string> = { NOURIDE_CREDENTIALS_DIR: deps.credentialsDir };
    const handed: string[] = [];
    for (const name of names) {
      const value = deps.resolve(name);
      if (value === undefined) {
        // Named but absent is worth saying once — the symptom otherwise is a script failing to
        // authenticate, which reads as the credential being wrong rather than missing. Once per agent and
        // name: it was said on every command that named it.
        if (!warned.has(`missing:${agentId}:${name}`)) {
          warned.add(`missing:${agentId}:${name}`);
          log.warn("exec_secrets names a secret that is not set", { agent_id: agentId, secret_name: name });
        }
        continue;
      }
      // Upper-cased with dashes flattened, because that is what a shell variable looks like:
      // `twit_auth_token` arrives as `$TWIT_AUTH_TOKEN`.
      const variable = variableOf(name);
      // A name the allowlist already carries — `path`, `home` — never reaches the child: `buildEnv`
      // lets the allowlist win, so `PATH` cannot be replaced by a secret. Said once, not per command.
      if (reserved.has(variable) && !warned.has(`${agentId}:${variable}`)) {
        warned.add(`${agentId}:${variable}`);
        log.warn("exec_secrets names a secret whose variable is reserved, so commands never see it: rename the secret", {
          agent_id: agentId,
          secret_name: name,
          variable,
        });
      }
      env[variable] = value;
      handed.push(name);
    }
    return { env, secrets: handed };
  };
  const all = (agentId: string) => valuesOf(agentId, deps.execSecrets(agentId).map((secret) => secret.name)).env;
  return Object.assign(all, {
    forCommand: (agentId: string, argv: readonly string[] | null) => {
      const secrets = deps.execSecrets(agentId);
      const everywhere = new Set(secrets.filter((secret) => secret.commands.includes("*")).map((secret) => secret.name));
      const handed = valuesOf(agentId, secretsFor(argv, secrets));
      // Spawning only, never masking: a socket path printed is not a secret printed, and `all` is what output is
      // masked with.
      const socket = deps.sshAgent?.(agentId) ? process.env.SSH_AUTH_SOCK : undefined;
      return {
        ...handed,
        env: socket ? { SSH_AUTH_SOCK: socket, ...handed.env } : handed.env,
        bound: handed.secrets.filter((name) => !everywhere.has(name)),
      };
    },
  });
}

interface CommandValues {
  env: Record<string, string>;
  secrets: string[];
}
