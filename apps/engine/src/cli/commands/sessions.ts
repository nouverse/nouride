import type { SessionListResponse, Client } from "@nouride/cli-kit";
import { BOLD, DIM, RESET, say, wholeNumber } from "@nouride/cli-kit";

/** `nouride sessions` — what conversations exist, newest first. */
export async function sessions(client: Client, args: string[]): Promise<void> {
  const limit = args[0] ? wholeNumber("sessions", args[0]) : 25;
  const { sessions: rows } = await client.get<SessionListResponse>(
    `/sessions?limit=${Number.isNaN(limit) ? 25 : limit}`,
  );
  if (rows.length === 0) return say(`${DIM}no stored conversations${RESET}`);

  for (const row of rows) {
    const when = new Date(row.updatedAt).toISOString().slice(0, 16).replace("T", " ");
    say(
      `${DIM}${when}${RESET} ${BOLD}${row.agentId}${RESET} ${DIM}${row.gatewayId} · ${row.chatId}${RESET}` +
        ` ${DIM}· ~${row.contextTokenCount} tokens${RESET}`,
    );
  }
  // Retention deletes these on a timer, so knowing the window matters as much as the list.
  say(`${DIM}kept for [retention] session_days; 0 disables the sweep${RESET}`);
}
