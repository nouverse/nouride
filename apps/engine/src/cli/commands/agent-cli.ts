import { DIM, RESET, say, usageError } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { saidSaved } from "@/cli/saved.ts";
import { flagValue } from "@/cli/args.ts";

/**
 * `nouride agent external <id> <cli> [--profile <p>]` — a coding CLI answers an agent that exists — and `nouride agent
 * internal <id>`, a model again (0.8.1). The way to turn an agent into an external one, so nobody reaches its pack
 * through `nouride tools run` instead (the live box, the same day).
 */
export async function answeredBy(client: Client, action: "external" | "internal", id: string, args: string[]): Promise<void> {
  const profile = flagValue(args, "--profile");
  const cli = action === "external" ? (args.filter((word, i) => !word.startsWith("--") && args[i - 1] !== "--profile")[0] ?? null) : null;
  if (action === "external" && !cli) usageError("Which CLI?", "Usage: nouride agent external <id> <cli> [--profile <name>] (`nouride agents scan` lists them)");
  const answer = await client.post<{ restartRequired?: boolean }>(`/agents/${id}/answered-by`, { cli, ...(profile ? { profile } : {}) });
  saidSaved(action === "external" ? `${id} answered by ${cli}${profile ? ` on profile ${profile}` : ""}` : `${id} answered by its model again`, answer);
  if (action === "external") {
    say(`${DIM}  sign it in before it can answer: nouride agents login ${id}, or its Brain tab on the dashboard${RESET}`);
  }
}

