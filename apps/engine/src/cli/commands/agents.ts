import { describeStatus } from "@/modules/pipeline/agent-status.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, say, usageError } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import type { StatusResponse } from "@/cli/wire.ts";
import { loginCli, scanClis } from "@/cli/commands/external-clis.ts";
import { knownAction } from "@/cli/usage.ts";
import { saidSaved } from "@/cli/saved.ts";
import { answeredBy } from "@/cli/commands/agent-cli.ts";
import { updateCli } from "@/cli/commands/agents-update.ts";
import { skillRootCommand } from "@/cli/commands/agent-skill-root.ts";

/** `nouride agents [scan|login <id>|update <cli>]`: the list, the coding CLIs this box has, a sign-in, an update. */
export async function agentsCommand(client: Client, args: string[]): Promise<void> {
  const [action, id] = args;
  if (!action) return agents(client);
  knownAction("agents", action, ["scan", "login", "update"]);
  if (action === "scan") return scanClis(client);
  if (action === "update") return updateCli(client, args.slice(1));
  if (!id) usageError("Which agent?", "Usage: nouride agents login <id>");
  return loginCli(client, id);
}

/** An external agent's CLI and its model: the pack's, else the CLI's default by name, as the dashboard lists it. */
function externalModel(external: NonNullable<StatusResponse["agents"][number]["external"]>): string {
  return `${external.name ?? external.cli} · ${external.model || (external.cliDefault ? `${external.cliDefault} (default)` : "its default model")}`;
}

async function agents(client: Client): Promise<void> {
  const status = await client.get<StatusResponse>("/status");
  if (status.agents.length === 0) return say(`${DIM}no agents loaded${RESET}`);

  for (const agent of status.agents) {
    const state = agent.enabled ? agent.state : "disabled";
    const colour = state === "running" && !agent.activity?.unavailable ? GREEN : state === "error" || agent.activity?.unavailable ? RED : YELLOW;
    say(`${colour}●${RESET} ${BOLD}${agent.id}${RESET} ${DIM}${agent.displayName}${RESET}`);
    // What it is doing, where the daemon says: "running" read the same mid-answer and idle (0.7.18).
    // An external agent is answered by its CLI, on its profile: that, where another shows its model — and the CLI's
    // model, not its `[llm]`, which answers none of its turns.
    const answeredBy = agent.external ? `${externalModel(agent.external)} · profile ${agent.external.profile}` : `${agent.provider}/${agent.model}`;
    say(`    ${DIM}${agent.activity ? describeStatus(agent.activity) : `state ${state}`} · ${answeredBy}${RESET}`);
    say(`    ${DIM}tools ${agent.tools.join(", ") || "none"}${RESET}`);
    if (agent.skills.length > 0) say(`    ${DIM}skills ${agent.skills.join(", ")}${RESET}`);
  }
  for (const failure of status.failures) {
    say(`${RED}●${RESET} ${BOLD}${failure.id}${RESET} ${RED}failed to load${RESET}`);
    say(`    ${DIM}${failure.error}${RESET}`);
  }
}

export async function agentAction(client: Client, args: string[]): Promise<void> {
  const [action, id] = args;
  knownAction("agent", action, ["sleep", "wake", "pause", "resume", "reload", "enable", "disable", "external", "internal", "skill-root"]);
  if (action === "skill-root") return skillRootCommand(client, args.slice(1));
  if (!action || !id) usageError(`Which agent?`, "Usage: nouride agent <sleep|wake|reload|enable|disable|internal> <id>, or nouride agent external <id> <cli>");
  if (action === "external" || action === "internal") return answeredBy(client, action, id, args.slice(2));
  const answer = await client.post<{ restartRequired?: boolean }>(`/agents/${id}/${action}`);
  // `enable` and `disable` write the pack's config.toml — a save, said as one. The others act on the running agent.
  if (action === "enable" || action === "disable") saidSaved(`${action} ${id}`, answer);
  else say(`${GREEN}✓${RESET} ${action} ${id}`);
  // Said because the two look alike and are not: asleep is a mark the daemon keeps (a restart keeps it too),
  // `disable` is written into the pack's config.toml.
  if (action === "sleep" || action === "pause") {
    say(`${DIM}  asleep until wake, through a restart too (disable writes it to config.toml instead)${RESET}`);
  }
}
