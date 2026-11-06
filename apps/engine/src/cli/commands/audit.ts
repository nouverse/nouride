import type { AuditResponse } from "@/cli/wire.ts";
import { BOLD, DIM, RESET, say, summarize } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { wholeNumber } from "@/cli/usage.ts";

export async function audit(client: Client, args: string[]): Promise<void> {
  const limit = args[0] ? wholeNumber("audit", args[0]) : 25;
  const { entries } = await client.get<AuditResponse>(
    `/audit?limit=${Number.isNaN(limit) ? 25 : limit}`,
  );
  if (entries.length === 0) return say(`${DIM}nothing recorded yet${RESET}`);

  for (const entry of entries) {
    const when = new Date(entry.timestamp).toISOString().slice(11, 19);
    say(
      `${DIM}${when}${RESET} ${BOLD}${entry.action}${RESET} ${DIM}${entry.agentId ?? "-"} · ${entry.actor ?? "-"}${RESET}` +
        (entry.details ? ` ${DIM}${summarize(entry.details)}${RESET}` : ""),
    );
  }
}
