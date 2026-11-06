import type { WebhookRow } from "@/cli/wire.ts";
import { BOLD, DIM, GREEN, RESET, say, usageError, usageLines } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { flagValue, hasFlag, sessionMode } from "@/cli/args.ts";
import { knownAction } from "@/cli/usage.ts";

/**
 * `nouride webhook` — endpoints that run a job when something calls them.
 *
 * A separate verb rather than `cron add --webhook`, for the same reason the dashboard gives them
 * their own page: what you do with a webhook after creating it is copy its URL, and what you do with
 * a cron job is check when it next runs. Underneath they are the same rows, so `rm`, `enable`,
 * `disable`, `run` and `runs` are `nouride cron`'s and are not repeated here.
 *
 * This is also the path an agent takes. There is no webhook tool — minting a
 * public endpoint is an operator's decision, and routing it through `exec` means it meets the exec
 * policy and lands in the audit log as the command it was, rather than as a tool call whose
 * consequences are a schema field away.
 */
export async function webhook(client: Client, args: string[]): Promise<void> {
  const [action, id] = args;
  knownAction("webhook", action, ["add", "rotate", "test", "ls", "list"]);
  const flag = (name: string): string | undefined => flagValue(args, `--${name}`);
  const has = (name: string): boolean => hasFlag(args, `--${name}`);

  /** The URL and the two things a person needs to know before pasting it anywhere. */
  const showUrl = (hook: { url: string; urlGuessed?: boolean }): void => {
    say(`${BOLD}${hook.url}${RESET}`);
    say(`${DIM}  POST to it to run the job. Anyone holding this URL can fire it, so treat it${RESET}`);
    say(`${DIM}  like a password. Add ?wait=1 to get the outcome back instead of a 202.${RESET}`);
    if (hook.urlGuessed) {
      say(
        `${DIM}  That is this daemon's own host and port. Behind a proxy or a container port${RESET}`,
      );
      say(`${DIM}  map, set [dashboard] public_url so this prints a reachable address.${RESET}`);
    }
  };

  /** Whether a call from outside can arrive, and why — the Webhooks page's line (0.8.0). */
  const showReach = (hook: WebhookRow): void => {
    const label = { internet: `${GREEN}reachable from the internet${RESET}`, local: "local network only", unknown: "reach unknown" }[hook.reach.state];
    say(`  ${label}${DIM}: ${hook.reach.why}${RESET}`);
  };

  if (action === "add") {
    const name = flag("name");
    if (!name) {
      usageLines(
        `${DIM}nouride webhook add --name <name> --agent <id> --gateway <id> --chat <id>\n` +
          `  --message <prompt>                  wake the agent with this when it fires\n` +
          `  --text <message>                    deliver plain text instead, no model call\n` +
          `  --session <fresh|isolated|chat>     history: none (default), private, or the chat's\n` +
          `  --quiet                             record the run, deliver nothing\n` +
          `\n` +
          `The URL it prints is the credential: anyone holding it can fire the job. Rotate it\n` +
          `if it leaks. The caller's request body is appended to --message as untrusted data,\n` +
          `so say what to do with it. Add ?wait=1 when testing to get the outcome back.\n` +
          `\n` +
          `Set [dashboard] public_url if this daemon sits behind a proxy, or the URL printed\n` +
          `here is its bind address and reaches nobody from outside.\n` +
          `\n` +
          `To let an AGENT run this itself: put the control token in the secret store and bind\n` +
          `it to the command in the agent's [security.exec_secrets], so $NOURIDE_TOKEN reaches it. Know\n` +
          `what that grants before you do. It is the whole control API, not just webhooks:\n` +
          `users, providers, gateways, config and every agent's jobs.${RESET}`,
      );
    }

    const message = flag("message");
    const text = flag("text");
    // No `--command`: a webhook that runs argv on the host, triggered by an unauthenticated
    // request, is a remote shell with extra steps. `nouride cron add --command` still exists for a
    // job whose trigger is a clock the operator set.
    const payload = message ? { kind: "agentTurn", message } : { kind: "systemEvent", text: text ?? name };

    const { webhook: created } = await client.post<{ webhook: WebhookRow }>("/webhooks", {
      agentId: flag("agent") ?? "",
      name,
      payload,
      target: { gatewayId: flag("gateway") ?? "", chatId: flag("chat") ?? "" },
      session: sessionMode(flag("session")),
      delivery: { mode: has("quiet") ? "none" : "announce" },
    });

    say(`${GREEN}✓${RESET} created ${BOLD}${created.name}${RESET} ${DIM}${created.id}${RESET}`);
    say("");
    return showUrl(created);
  }

  if (action === "rotate") {
    if (!id) usageError(`usage: nouride webhook rotate <id>`);
    const { webhook: rotated } = await client.post<{ webhook: WebhookRow }>(
      `/webhooks/${encodeURIComponent(id)}/rotate`,
    );
    say(`${GREEN}✓${RESET} rotated: the previous URL stops working now`);
    say("");
    return showUrl(rotated);
  }

  // A test through the public address: counted when it arrives, and the job not run.
  if (action === "test") {
    if (!id) usageError(`usage: nouride webhook test <id>`);
    const { webhook: tested } = await client.post<{ webhook: WebhookRow }>(`/webhooks/${encodeURIComponent(id)}/test`);
    say(`${BOLD}${tested.name}${RESET} ${DIM}${tested.url}${RESET}`);
    return showReach(tested);
  }

  const { webhooks } = await client.get<{ webhooks: WebhookRow[] }>("/webhooks");
  if (webhooks.length === 0) return say(`${DIM}no webhooks${RESET}`);

  for (const hook of webhooks) {
    const state = hook.enabled ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
    say(`${state} ${BOLD}${hook.name}${RESET} ${DIM}${hook.id} · ${hook.agentId} · ${hook.runCount} deliveries${RESET}`);
    say(`  ${hook.url}`);
    showReach(hook);
  }
}
