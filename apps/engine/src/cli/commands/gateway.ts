import { readStdin } from "@nouride/runtime";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, fail, say, usageError, usageLines } from "@/cli/ui.ts";
import { parseWakeUp, scheduleWakeUp, wakeUpUsage } from "@/cli/wake-up.ts";
import type { Client } from "@/cli/client.ts";
import type { StatusResponse , AckResponse} from "@/cli/wire.ts";
import { flagValue, hasFlag } from "@/cli/args.ts";
import { saidSaved } from "@/cli/saved.ts";

export async function gateway(client: Client, args: string[]): Promise<void> {
  const [action, id] = args;
  const status = await client.get<StatusResponse>("/status");

  if (!action || action === "list" || action === "status") {
    if (status.gateways.length === 0) return say(`${DIM}no gateways configured${RESET}`);
    for (const g of status.gateways) {
      const colour = g.status === "connected" ? GREEN : g.status === "dead" ? RED : YELLOW;
      say(`${colour}●${RESET} ${BOLD}${g.id}${RESET} ${DIM}${g.platform} · ${g.status}${RESET}`);
    }
    return;
  }

  if (action === "restart") {
    if (!id) usageError("Which gateway?", `Try one of: ${status.gateways.map((g) => g.id).join(", ")}`);
    /**
     * Same rule as `nouride restart`, for the same reason.
     *
     * Restarting the gateway this conversation arrived on ends the conversation — the socket the
     * reply would have gone out on is the one being torn down. So the follow-up turn is created
     * first, and it is created for *every* gateway rather than only the current one: an agent
     * restarting somebody else's Discord connection still needs to say whether it came back.
     */
    const wake = parseWakeUp(args, `restarting ${id}`);
    if (!wake && !hasFlag(args, "--no-then")) {
      usageLines(
        wakeUpUsage(
          `nouride gateway restart ${id}`,
          `nouride gateway restart ${id} --then "confirm ${id} reconnected"`,
        ),
      );
    }
    if (wake) await scheduleWakeUp(client, wake);
    const result = await client.post<AckResponse>(`/gateways/${id}/restart`);
    return say(`${GREEN}✓${RESET} restarted ${id}, now ${result.status}`);
  }

  if (action === "add" || action === "set") {
    const flag = (key: string): string | undefined => flagValue(args, `--${key}`);
    const has = (key: string): boolean => hasFlag(args, `--${key}`);

    const platform = flag("platform");
    const instance = flag("name") ?? id;
    if (!platform || !instance) {
      usageLines(
        `${DIM}nouride gateway add --platform <discord|telegram|whatsapp> --name <instance>\n` +
          `  --agent <id>              which agent answers on it\n` +
          `  --stdin                   read the bot token from stdin (preferred)\n` +
          `  --token <value>           inline, kept forever in the grant and the audit log\n` +
          `  --token-secret <name>     use a secret already in the store\n` +
          `  --session-dir <path>      WhatsApp only: where the pairing lives\n` +
          `  --disabled                write it but do not connect yet\n\n` +
          `The id becomes <platform>:<name>. That is what sessions, people ids and the access\n` +
          `allowlist are keyed by, so pick it deliberately. \`nouride gateway rename\` exists but\n` +
          `it is a database migration, not a label change.\n\n` +
          `WhatsApp pairs by QR after it starts: \`nouride gateway\` shows the state.${RESET}`,
      );
    }

    // Read before the request, so a missing token is not a half-created connection.
    let token = flag("token");
    if (hasFlag(args, "--stdin")) {
      token = (await readStdin()).trim();
      if (!token) return fail("--stdin was given but nothing arrived on stdin");
    }
    const tokenSecret = flag("token-secret");
    if (tokenSecret && !token) {
      /**
       * A stored secret is referenced by writing the config without a token.
       *
       * `saveGateway` derives the secret name from the instance, so the honest way to reuse an
       * existing one is to store it under that name first. Said rather than silently ignored.
       */
      say(`${DIM}  using the stored secret: make sure it is named for this instance${RESET}`);
    }

    const result = await client.post<AckResponse>("/gateways", {
      platform,
      name: instance,
      enabled: !has("disabled"),
      ...(token ? { token } : {}),
      ...(flag("agent") ? { agent: flag("agent") } : {}),
      ...(flag("session-dir") ? { sessionDir: flag("session-dir") } : {}),
    });
    // A gateway is a socket opened at boot: the config is written, and nothing listens on it until the restart.
    return saidSaved(`${BOLD}${platform}:${instance}${RESET}`, result, `nouride restart --then "confirm ${platform}:${instance} connected"`);
  }

  if (action === "rm" || action === "delete") {
    if (!id) usageError("Which gateway?", "nouride gateway rm <platform:instance>");
    // Applied when the daemon could take the connection down itself; a restart otherwise (`removeGateway`).
    const removed = await client.del<AckResponse>(`/gateways/${encodeURIComponent(id)}`);
    return saidSaved(`removed ${BOLD}${id}${RESET} ${DIM}(its sessions and history stay)${RESET}`, removed);
  }

  usageError(
    `Unknown gateway action "${action}".`,
    "Use: list, add, set, rm <id>, restart <id>, rename <old> <new>",
  );
}
