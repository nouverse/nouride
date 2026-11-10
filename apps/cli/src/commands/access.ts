import type { AckResponse, SenderRow, Client } from "@nouride/cli-kit";
import { BOLD, DIM, GREEN, RED, RESET, say, usageError, usageLines, YELLOW, flagValue, hasFlag, knownAction } from "@nouride/cli-kit";
import { saidSaved } from "../saved.ts";

/**
 * `nouride access` — who may talk to the agents.
 *
 * The list shows the platform *and* the reported name, because approving a pairing code is a decision
 * about a person and the code alone says nothing about who sent it.
 */
export async function access(client: Client, args: string[]): Promise<void> {
  const [action, target] = args;
  knownAction("access", action, ["approve", "mode", "allow", ...Object.keys(ANSWERED), "pending", "approved", "denied", "blocked", "list"]);

  if (action === "approve") {
    if (!target) usageError(`usage: nouride access approve <code> [--me | --as <person key> | --new "<name>"]`);
    // Who they are, so an agent knows them by name everywhere — yourself, somebody known, or new.
    const as = hasFlag(args, "--me") ? "me" : flagValue(args, "--as") ? `person:${flagValue(args, "--as")}` : flagValue(args, "--new") ? "new" : "";
    const query = new URLSearchParams({ code: target, ...(as ? { as } : {}), ...(as === "new" ? { name: flagValue(args, "--new")! } : {}) });
    const result = await client.post<AckResponse & { person?: { name: string } | null; warning?: string }>(`/access/approve?${query}`);
    const sender = result.sender;
    say(
      `${GREEN}✓${RESET} approved ${BOLD}${sender?.senderName ?? sender?.senderId}${RESET} ` +
        `${DIM}on ${sender?.gatewayId}${RESET}` +
        (result.person ? `, linked to ${BOLD}${result.person.name}${RESET}` : ""),
    );
    if (result.warning) say(`${YELLOW}!${RESET} ${result.warning}`);
    return;
  }

  /**
   * `nouride access mode [open|allowlist|pair]` — the same switch the dashboard has.
   *
   * With no argument it says what is in force rather than changing anything: the destructive reading
   * of a bare `nouride access mode` would be "set it to nothing", and there is no such mode.
   */
  if (action === "mode") {
    if (!target) {
      const { mode } = await client.get<{ mode: string }>("/access");
      say(`${BOLD}${mode}${RESET} ${DIM}· nouride access mode <open|allowlist|pair>${RESET}`);
      return;
    }
    const result = await client.post<AckResponse>("/access/mode", { mode: target });
    return saidSaved(`access mode is now ${BOLD}${result.mode}${RESET}`, result);
  }

  /**
   * `nouride access allow <gateway:sender> [--name "<name>"]` — let somebody in before they have asked.
   * The pairing-era answer to an id written in config.toml: it lands under Approved, where Revoke and
   * Block reach it.
   */
  if (action === "allow") {
    if (!target || !target.includes(":")) {
      usageLines(`nouride access allow <gateway:sender> [--name "<name>"]\ne.g. telegram:nouva:123456789`);
    }
    const at = target.lastIndexOf(":");
    const name = flagValue(args, "--name");
    const query = new URLSearchParams({ gateway: target.slice(0, at), sender: target.slice(at + 1), ...(name ? { name } : {}) });
    await client.post(`/access/allow?${query}`);
    return say(`${GREEN}✓${RESET} allowed ${target} ${DIM}(approved without a code; revoke or block it like any other)${RESET}`);
  }

  const done = action ? ANSWERED[action] : undefined;
  if (done) {
    // `gateway:sender` as one argument: that pair is the identity, and splitting it across two
    // positional arguments invites getting them the wrong way round.
    if (!target || !target.includes(":")) {
      usageError(`usage: nouride access ${action} <gateway:sender>`, "e.g. telegram:nouva:123456789");
    }
    const at = target.lastIndexOf(":");
    const query = `gateway=${encodeURIComponent(target.slice(0, at))}&sender=${encodeURIComponent(target.slice(at + 1))}`;
    await client.post(`/access/${action}?${query}`);
    return say(`${GREEN}✓${RESET} ${done} ${target}`);
  }

  const status = action && ["pending", "approved", "denied", "blocked"].includes(action) ? action : "";
  const { senders } = await client.get<{ senders: SenderRow[] }>(`/access${status ? `?status=${status}` : ""}`);
  if (!senders || senders.length === 0) return say(`${DIM}nobody has asked, and nobody is paired${RESET}`);

  for (const sender of senders) {
    const mark = MARK[sender.status];
    const who = sender.senderName ? `${sender.senderName} ${DIM}(${sender.senderId})${RESET}` : sender.senderId;
    say(`${mark} ${who} ${DIM}· ${sender.gatewayId}${sender.status === "blocked" ? " · blocked" : ""}${RESET}`);
    const left = sender.expiresAt ? Math.max(0, sender.expiresAt - Date.now()) : 0;
    if (sender.status === "pending" && sender.code) {
      say(`    ${BOLD}${sender.code}${RESET} ${DIM}· expires in ${Math.round(left / 60000)}m · nouride access approve ${sender.code}${RESET}`);
    }
    if (sender.status === "denied") {
      say(`    ${DIM}denied · may ask again in ${Math.ceil(left / 3_600_000)}h · nouride access reset ${sender.gatewayId}:${sender.senderId}${RESET}`);
    }
  }
  say();
  say(`${DIM}nouride access approve <code> [--me | --as <key> | --new "<name>"]${RESET}`);
  say(`${DIM}nouride access allow <gateway:sender> [--name "<name>"]${RESET}`);
  say(`${DIM}nouride access deny|block|revoke|reset|unblock <gateway:sender>${RESET}`);
  say(`${DIM}nouride access mode [open|allowlist|pair]${RESET}`);
}

const MARK: Record<SenderRow["status"], string> = {
  approved: `${GREEN}✓${RESET}`,
  pending: `${YELLOW}●${RESET}`,
  denied: `${RED}✗${RESET}`,
  blocked: `${RED}⊘${RESET}`,
};

/**
 * The answers about one sender, and how each reads once done. Deny is "no, this time" — they may ask
 * again after a while, or at once after a reset; block lasts until an unblock.
 */
const ANSWERED: Record<string, string> = {
  deny: "denied",
  block: "blocked",
  revoke: "revoked",
  reset: "reset, so they may ask again:",
  unblock: "unblocked, so they may ask again:",
};

/**
 * Every verb that changes somebody's standing, `mode <x>` aside. Each must reach a person when an agent runs it —
 * `@nouride/policy`'s `own-cli.ts` copies this list.
 */
export const ACCESS_CHANGES = ["approve", "allow", ...Object.keys(ANSWERED)];
