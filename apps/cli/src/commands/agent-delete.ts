import { openLinePrompt, type LinePrompt } from "@nouride/runtime";
import { formatBytes, plural } from "@nouride/shared";
import type { AgentDeletedResponse, AgentDeletionResponse, Client } from "@nouride/cli-kit";
import { BOLD, DIM, GREEN, RESET, YELLOW, emit, fail, say } from "@nouride/cli-kit";

/** What goes with the agent, a line each, only what there is of it. */
function goes(found: AgentDeletionResponse): string[] {
  const size = found.folder.bytes === null ? "" : `, ${formatBytes(found.folder.bytes)}`;
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${plural(n, one, many)}`;
  return [
    `its own files: its pack and its private folder, where a coding CLI's sign-ins are (${found.folder.more ? "over " : ""}${count(found.folder.files, "file")}${size})`,
    ...(found.missions > 0 ? [`${count(found.missions, "mission")} still open: stopped first`] : []),
    ...(found.jobs > 0 ? [`${count(found.jobs, "background job")} running now: ended first`] : []),
    ...(found.automations > 0 ? [`${count(found.automations, "automation")} of its own`] : []),
    ...(found.handed > 0 ? [`${count(found.handed, "automation")} of other agents with a step given to it: turned off, each saying why`] : []),
    ...(found.connections.length > 0 ? [`the ${plural(found.connections.length, "connection")} only it answers: ${found.connections.join(", ")} (the token stays in Secrets)`] : []),
    ...(found.rooms > 0 ? [`its seat in ${count(found.rooms, "room")}`] : []),
    ...(found.grants > 0 ? [`${count(found.grants, "standing permission")}`] : []),
    ...(found.signIns > 0 ? [`${count(found.signIns, "stored sign-in")} to connectors`] : []),
    ...(found.account ? [`its user on this machine, nr-${found.agent}`] : []),
  ];
}

/**
 * `nouride agent delete <id>`: an agent deleted for good. Says what goes and what is kept, then asks for the agent's
 * id to be typed: the one confirmation a terminal has, where the dashboard's dialog also counts ten seconds down. A
 * script answers it on stdin. The orchestrator is refused by the daemon, in its own words.
 */
export async function deleteAgent(client: Client, id: string, prompt: Pick<LinePrompt, "ask" | "close"> = openLinePrompt()): Promise<void> {
  try {
    const found = await client.get<AgentDeletionResponse>(`/agents/${encodeURIComponent(id)}/delete`);
    say(`${BOLD}Delete ${found.displayName} (${found.agent})?${RESET} This cannot be undone. With it go:`);
    for (const line of goes(found)) say(`  - ${line}`);
    say(`${DIM}Kept: its chats, what it remembered, the records of its missions, the audit log and usage. An agent made later with the id ${found.agent} is joined to them.${RESET}`);
    // Input that ends with nothing typed (a script with no stdin) is a no, said as one: not a stack trace.
    const typed = (await prompt.ask(`Type the agent's id to delete it (${found.agent}): `).catch(() => "")).trim();
    if (typed !== found.agent) fail(typed ? `not deleted: "${typed}" is not the agent's id` : "not deleted: the agent's id was not typed");
    const done = await client.post<AgentDeletedResponse>(`/agents/${encodeURIComponent(id)}/delete`, { confirm: typed });
    emit(done);
    say(`${GREEN}✓${RESET} ${done.deleted} deleted`);
    for (const note of done.notes) say(`  ${YELLOW}!${RESET} ${note}`);
  } finally {
    prompt.close();
  }
}
