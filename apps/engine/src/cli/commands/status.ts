import { BOLD, DIM, RED, RESET, YELLOW, say } from "@nouride/cli-kit";
import type { Client, StatusResponse } from "@nouride/cli-kit";

export async function status(client: Client): Promise<void> {
  const s = await client.get<StatusResponse>("/status");
  say(`${BOLD}nouride${RESET} ${DIM}${s.status} · up ${s.uptime}s${RESET}`);
  say(`  ${DIM}config${RESET}   ${s.configSource ?? "built-in defaults"}`);
  say(`  ${DIM}agents${RESET}   ${s.agents.filter((a) => a.state === "running" && a.enabled).length} running / ${s.agents.length} loaded`);
  say(`  ${DIM}gateways${RESET} ${s.gateways.map((g) => `${g.id}:${g.status}`).join(", ") || "none"}`);
  say(`  ${DIM}queue${RESET}    ${s.queue.running} running, ${s.queue.waiting} waiting`);
  if (s.pendingApprovals > 0) say(`  ${YELLOW}approvals${RESET} ${s.pendingApprovals} waiting`);
  if (s.failures.length > 0) say(`  ${RED}failed${RESET}   ${s.failures.map((f) => f.id).join(", ")}`);
}
