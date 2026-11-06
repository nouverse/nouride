/**
 * What `/secret` keeps and changes for good (`hooks/builtins/secrets.ts`), over the store and the packs boot holds: a
 * value under a name, through the same write the dashboard's Secrets page makes — audited by name and length, never the
 * value — and the `exec_secrets` line that hands a kept secret to an agent's commands, through the checked write and
 * reload every pack edit takes.
 */

import { join } from "@nouride/runtime";
import type { AgentRegistry } from "@nouride/persona";
import type { SecretStore } from "@nouride/secrets";
import type { AuditPort } from "@/commons/audit.store.ts";
import { bindPackSecret } from "@/modules/config/settings/agents.ts";
import { changeSecretFields, setSecret } from "@/modules/config/settings/secrets.ts";
import type { SecretKeeping } from "@/modules/tools/held-secrets.ts";

export function secretKeepingFor(deps: { secrets: SecretStore; audit: AuditPort; registry: AgentRegistry }): SecretKeeping {
  return {
    has: (name) => deps.secrets.has(name),
    keep: (input) => setSecret(deps, input),
    changeFields: (input) => changeSecretFields(deps, input),
    bind: async (agentId, name) => {
      const agent = deps.registry.get(agentId);
      if (!agent) return { ok: false, error: `no agent "${agentId}"` };
      return await bindPackSecret({ agentConfigPath: join(agent.dir, "config.toml"), reload: () => deps.registry.reload(agentId), name });
    },
  };
}
