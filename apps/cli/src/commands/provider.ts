/**
 * `nouride provider` — the profiles an agent's model is resolved through.
 *
 * The route and the writer already existed; only the dashboard could reach them. That gap was worth
 * closing because of what it did to the *other* commands: `agent_configure` refuses to switch to a
 * profile with no credential, and nothing outside a browser could create one — so an agent asked to
 * "use a different provider" could get exactly as far as naming the problem.
 *
 * The API key follows the same rule as everywhere else: on stdin, or by naming a secret that is
 * already stored. Inline is available and documented as the worse choice, because everything in
 * `argv` is kept in the exec grant, the audit table and the daemon's log table, permanently.
 */

import type { ProbeResponse, ProvidersResponse, Client } from "@nouride/cli-kit";
import { readStdin } from "@nouride/runtime";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, fail, say, usageError, usageLines, flagValue, hasFlag } from "@nouride/cli-kit";
import { saidSaved } from "../saved.ts";

export async function provider(client: Client, args: string[]): Promise<void> {
  const [action, name] = args;
  const flag = (key: string): string | undefined => flagValue(args, `--${key}`);
  const has = (key: string): boolean => hasFlag(args, `--${key}`);

  if (!action || action === "list") {
    const { providers } = await client.get<ProvidersResponse>("/providers");
    if (providers.length === 0) return say(`${DIM}no provider profiles configured${RESET}`);
    for (const p of providers as {
      name: string;
      kind: string;
      baseUrl: string;
      hasCredential: boolean;
      builtIn: boolean;
    }[]) {
      // The credential is the field that decides whether a profile is usable at all, so it leads.
      const cred = p.hasCredential ? `${GREEN}●${RESET}` : `${RED}○ no key${RESET}`;
      say(`${cred} ${BOLD}${p.name}${RESET} ${DIM}${p.kind} · ${p.baseUrl}${p.builtIn ? " · built-in" : ""}${RESET}`);
    }
    say();
    return say(`${DIM}nouride provider add <name> --kind openai|anthropic --url <base> --stdin${RESET}`);
  }

  if (action === "add" || action === "set") {
    if (!name) {
      usageLines(
        `${DIM}nouride provider add <name> --kind <openai|anthropic> --url <base-url>\n` +
          `  --stdin                    read the API key from stdin (preferred)\n` +
          `  --key <value>              inline, kept forever in the grant and the audit log\n` +
          `  --no-probe                 skip the reachability check\n\n` +
          `The key is stored as \`<name>_api_key\`. If it is already there (say you ran\n` +
          `\`secret set nougate_api_key\` first), add the profile with no key at all and it\n` +
          `picks the stored one up.\n\n` +
          `A profile is a name, an endpoint and a credential. Agents then reference the NAME.\n` +
          `See \`agent_configure\` and \`nouride agents\`.${RESET}`,
      );
    }

    // Read before the request, so a missing key is not a half-created profile.
    let apiKey = flag("key");
    if (hasFlag(args, "--stdin")) {
      apiKey = (await readStdin()).trim();
      if (!apiKey) return fail("--stdin was given but nothing arrived on stdin");
    }
    /**
     * A missing key is allowed, and it is not an oversight.
     *
     * `saveProvider` names the secret `<name>_api_key` itself, so `secret set nougate_api_key`
     * followed by `provider add nougate` is a complete, two-step path that never puts the value in
     * an argument. Refusing here would close the safest route to the thing this command is for.
     */
    if (!apiKey && action === "add") {
      say(`${DIM}  no key given: expecting one already stored as ${name}_api_key${RESET}`);
    }

    const kind = flag("kind") ?? "openai";
    const baseUrl = flag("url");
    if (action === "add" && !baseUrl) {
      return usageError("--url is required.", "e.g. --url https://api.openai.com/v1");
    }

    /**
     * Probed before it is written, unless told not to.
     *
     * A key that does not work is the single most common way a fresh provider fails, and it surfaces
     * on the agent's next message — long after this command said it succeeded. `--no-probe` exists
     * for an endpoint that is not reachable from the daemon yet.
     */
    if (apiKey && baseUrl && !has("no-probe")) {
      const probe = await client.post<ProbeResponse>("/providers/probe", { kind, baseUrl, apiKey });
      if (!probe.ok) {
        say(`${YELLOW}!${RESET} ${probe.error ?? "the endpoint did not answer"}`);
        return fail("Refusing to write a profile that does not answer.", "Re-run with --no-probe to write it anyway.");
      }
      say(`${DIM}  probe ok: ${probe.models?.length ?? 0} model(s) offered${RESET}`);
    }

    const answer = await client.post<{ restartRequired?: boolean }>("/providers", {
      name,
      kind,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    });
    saidSaved(`profile ${BOLD}${name}${RESET}`, answer);
    return say(`${DIM}  Point an agent at it: nouride agents, then agent_configure provider=${name}${RESET}`);
  }

  if (action === "rm" || action === "delete") {
    if (!name) return usageError("Which profile?", "nouride provider rm <name>");
    const answer = await client.del<{ restartRequired?: boolean }>(`/providers/${encodeURIComponent(name)}`);
    return saidSaved(`removed ${BOLD}${name}${RESET}`, answer);
  }

  usageError(`Unknown provider action "${action}".`, "Use: list, add <name>, set <name>, rm <name>");
}
