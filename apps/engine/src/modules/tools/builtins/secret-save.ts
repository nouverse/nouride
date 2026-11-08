/**
 * `secret_save` — keep a credential somebody sent in chat under a name, for good (0.7.17).
 *
 * A credential sent in chat reaches the agent as a handle (`pipeline/chat-secrets.ts`) and lasts an hour. Asked to keep
 * one — "simpan ini sebagai github_token" — the agent names the handle and the name, and the value goes from the
 * daemon's memory to its secret store without passing through the model. The same write the dashboard's Secrets page
 * and `/secret set` make, audited by name and length, never the value.
 *
 * Kept, it is handed to every command of the agent that kept it — `[security.exec_secrets] <name> = ["*"]` in its pack,
 * unless the pack already names it — so it works at once; narrowing it to some commands is an edit of that line.
 *
 * A new name asks as any tool that changes something does, at the agent's approval level. Replacing a stored value
 * always asks a person, whatever the level — it is the credential a provider, a bot or another agent's commands use
 * now, and a turn talked into swapping it for one somebody else sent would leave nothing to see until it was used.
 *
 * What is said about it, its fields (0.8.19: `site`, `username`, `used for`, any name), is given with the value, so a
 * token a person sent is kept with what it is for. Given alone, without `from`, the fields change and the value stays:
 * nothing is revealed, so nothing asks, except after the turn read outside content, since every later prompt reads
 * the fields.
 */

import { assertSecretName, envNamesFor, type TransientSecrets } from "@nouride/secrets";
import type { GateDecision } from "@nouride/shared";
import type { Tool } from "@nouride/shared";
import { secretScope, type SecretKeeping } from "@/modules/tools/held-secrets.ts";

export function createSecretSaveTool(options: { held: TransientSecrets; keeping: Pick<SecretKeeping, "has" | "keep" | "bind" | "changeFields"> }): Tool {
  return {
    requiresApproval: true,
    definition: {
      name: "secret_save",
      description:
        "Keep a credential somebody sent in this chat under a name, for good, when they ask you to. `from` is its handle ($TMP_SECRET_…); " +
        "`name` is what the secret store will call it; your commands get it from then on as $NAME (upper-case). " +
        "The value never passes through you. A name already set is refused unless `replace` is " +
        "true, and replacing one always asks a person. " +
        "Give `fields` with what you know of it: its site (`site`), its account (`username` or `email`), what it is `used for`, any other name you need. " +
        "Fields are shown to people and to you, so never put a key or a password in one. " +
        "Without `from`, `fields` changes what is said about a stored secret and leaves its value as it is; an empty text removes a field.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Letters, digits, dashes and underscores, e.g. github_token." },
          from: { type: "string", description: "The handle the message gave it, e.g. $TMP_SECRET_3F9A1C2B7D4E." },
          replace: { type: "boolean", description: "Replace the value already stored under this name. Always asks a person." },
          fields: {
            type: "object",
            description: "What is said about it, a name and a text each, e.g. {\"site\": \"github.com\", \"username\": \"nouva-bot\"}. Never a secret.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["name"],
      },
    },

    gate(args, ctx): GateDecision {
      const name = String(args.name ?? "");
      if (args.from === undefined) {
        // Only what is said about it: nothing revealed, so nothing asks, unless this turn read outside content first,
        // for every later prompt reads the fields.
        if (ctx.untrustedRead?.length) {
          return { action: "ask", grantable: false, hardline: true, hardlineClass: "config", reason: `it changes what is said about the secret \`${name}\`, which every later prompt reads, and this turn read outside content first (${ctx.untrustedRead.join(", ")})` };
        }
        return { action: "run", via: "ceiling" };
      }
      if (args.replace === true) {
        return {
          action: "ask",
          grantable: false,
          hardline: true,
          hardlineClass: "secret",
          reason: `it replaces the stored secret \`${name}\` with ${String(args.from ?? "a credential")} sent in this chat`,
        };
      }
      return { action: "ask", grantable: true, reason: `it keeps ${String(args.from ?? "a credential")} sent in this chat as the secret \`${name}\`` };
    },

    async execute(args, ctx) {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const from = typeof args.from === "string" ? args.from.trim() : "";
      try {
        assertSecretName(name, "`name`");
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
      const fields = fieldsOf(args.fields);
      if (fields === "bad") return { content: "`fields` is an object of names and texts, e.g. {\"domain\": \"github.com\"}.", isError: true };
      if (!from) {
        if (!fields) return { content: "Give `from` to keep a credential, or `fields` to change what is said about one.", isError: true };
        const changed = await options.keeping.changeFields({ name, change: { set: fields }, actor: `agent:${ctx.agentId}` });
        if (!changed.ok) return { content: `Not changed: ${changed.error}`, isError: true };
        const said = Object.entries(changed.fields ?? {}).map(([field, text]) => `${field}: ${text}`).join(", ");
        return { content: `\`${name}\` now says ${said || "nothing about itself"}. Its value is as it was.`, isError: false };
      }
      const held = options.held.get(from, secretScope(ctx));
      if (!held) {
        return { content: `${from || "That handle"} is not held in this conversation: it lasts an hour, in the chat it was sent in. Ask for it again.`, isError: true };
      }
      const exists = options.keeping.has(name);
      if (exists && args.replace !== true) {
        return { content: `\`${name}\` is already set. Pick another name, or say \`replace: true\`, which asks the person first.`, isError: true };
      }
      const saved = await options.keeping.keep({ name, value: held.value, actor: `agent:${ctx.agentId}`, ...(fields ? { fields: { set: fields } } : {}) });
      if (!saved.ok) return { content: `Not kept: ${saved.error}`, isError: true };
      const kept = `${exists ? "Replaced" : "Kept"} ${from} as \`${name}\`.`;
      const bound = await options.keeping.bind(ctx.agentId, name);
      if (!bound.ok) {
        return { content: `${kept} Not handed to your commands: ${bound.error}; ${from} still works until its hour is up.`, isError: false };
      }
      const variable = `$${envNamesFor(name)[0]}`;
      // A coding CLI's shell has what its process started with (0.8.11): it is started again with the secret at the
      // agent's next turn (`ExternalAgents.connection`), not this one.
      const when = ctx.lent ? " from your next turn, when your CLI starts again with it" : "";
      return {
        content: bound.changed ? `${kept} Your commands get it as ${variable}${when}.` : `${kept} Your pack already says which commands get it, as ${variable}${when}.`,
        isError: false,
      };
    },
  };
}

/** `fields` as names and texts, null when not given, "bad" when it is not that shape. */
function fieldsOf(raw: unknown): Record<string, string> | null | "bad" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw) || Object.values(raw).some((text) => typeof text !== "string")) return "bad";
  return raw as Record<string, string>;
}
