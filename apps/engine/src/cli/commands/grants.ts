import type { AckResponse, GrantsResponse } from "@/cli/wire.ts";
import { BOLD, DIM, GREEN, RESET, say, usageError } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { flagValue, hasFlag } from "@/cli/args.ts";
import { knownAction } from "@/cli/usage.ts";

export async function grants(client: Client, args: string[]): Promise<void> {
  const [action, target] = args;
  knownAction("grants", action, ["revoke", "list"]);

  if (action === "revoke") {
    if (!target) usageError(`usage: nouride grants revoke <id|--all> [--agent <id>]`);
    const query =
      target === "--all"
        ? `?${flagValue(args, "--agent") ? `agent=${encodeURIComponent(flagValue(args, "--agent")!)}` : ""}`
        : `?id=${encodeURIComponent(target)}`;
    const result = await client.post<AckResponse>(`/grants/revoke${query}`);
    return say(`${GREEN}✓${RESET} revoked ${result.revoked}`);
  }

  const { grants: list, toolGrants } = await client.get<GrantsResponse>(
    `/grants${hasFlag(args, "--all") ? "?all=1" : ""}`,
  );
  const tools = toolGrants ?? [];
  if ((!list || list.length === 0) && tools.length === 0) {
    return say(`${DIM}no standing permissions: under careful, every new command asks once${RESET}`);
  }

  for (const grant of tools) {
    const used = grant.useCount > 0 ? `used ${grant.useCount}×` : "never used";
    const state = grant.revokedAt ? `${DIM}revoked${RESET}` : `${GREEN}active${RESET}`;
    // Named as what it is: a tool inside a directory, not a command. Printing it in the exec shape
    // would make the scope look like a working directory rather than the boundary it is.
    say(`${state} ${BOLD}${grant.tool}${RESET} ${DIM}anywhere under${RESET} ${grant.scopeDir}`);
    say(`    ${DIM}${grant.id} · ${grant.agentId} · ${used}${RESET}`);
  }

  for (const grant of list ?? []) {
    const used = grant.useCount > 0 ? `used ${grant.useCount}×` : "never used";
    const state = grant.revokedAt ? `${DIM}revoked${RESET}` : `${GREEN}active${RESET}`;
    say(`${state} ${BOLD}${grant.commandText}${RESET}`);
    say(`    ${DIM}${grant.id} · ${grant.agentId} · in ${grant.cwd} · ${used}${RESET}`);
    if (grant.fileSha256) {
      // Worth surfacing: it is the reason a grant can stop matching without anyone changing it.
      say(`    ${DIM}bound to the contents of the script it runs${RESET}`);
    }
  }
  say();
  say(`${DIM}nouride grants revoke <id>  ·  nouride grants revoke --all${RESET}`);
}
