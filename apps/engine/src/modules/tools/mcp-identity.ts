/**
 * Who an MCP call is made for, in the one header a server's `identity` names (`McpServerConfig.identity`): a server
 * that scopes each request by its end user, reached with one credential nobody owns, is told whose request it is.
 *
 * The value is the daemon's: the turn's sender as it arrived, the other ids the platform knows them by, and their key
 * in People. Never a tool's argument or anything a model wrote — identity in a prompt is identity a prompt injection
 * can rewrite. A turn with no sender (a schedule, a webhook, a mission), or one the format cannot be filled for, sends
 * no header (`omit`) or is refused the call (`fail`): never an empty header, and never the agent's own id in its place.
 */

import type { McpIdentityHeader, Person, ToolContext } from "@nouride/shared";
import { canonicalPersonId, idsOf } from "@/modules/people/match.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";

export type IdentityOutcome = { headers: Record<string, string> } | { refused: string };

export function identityHeaders(
  identity: McpIdentityHeader | undefined,
  ctx: Pick<ToolContext, "gatewayId" | "senderId" | "senderAlso">,
  people: readonly Person[],
  server: string,
): IdentityOutcome {
  if (!identity) return { headers: {} };
  const value = filled(identity.format, ctx, people);
  if (value !== null) return { headers: { [identity.header]: value } };
  if (identity.onUnknown === "omit") return { headers: {} };
  return {
    refused:
      `The MCP server "${server}" is told who each call is made for, and this turn has no sender it can name (a schedule, ` +
      `a webhook or a mission has none, and {person_key} needs someone People knows), so the call was not sent.`,
  };
}

/** The format with the sender written in, or null where it cannot be: no sender, or a person People does not know. */
function filled(format: string, ctx: Pick<ToolContext, "gatewayId" | "senderId" | "senderAlso">, people: readonly Person[]): string | null {
  const sender = ctx.senderId.trim();
  if (!sender || sender === SYSTEM_SENDER) return null;
  const platform = ctx.gatewayId.split(":")[0] ?? ctx.gatewayId;
  // The one it arrived under first, then the others the platform named, each once.
  const accounts = [...new Set([sender, ...(ctx.senderAlso ?? []).map((id) => id.trim())].filter(Boolean))].map((id) => `${platform}:${id}`);
  let unknown = false;
  const value = format.replace(/\{(account|accounts|person_key)\}/g, (_match, field: string) => {
    if (field === "account") return accounts[0]!;
    if (field === "accounts") return accounts.join(", ");
    const person = people.find((candidate) => candidate.key && idsOf(candidate).some((id) => accounts.includes(canonicalPersonId(id))));
    if (!person) unknown = true;
    return person?.key ?? "";
  });
  // A header's value is one line: an id holding a line break would end this header and begin another.
  if (unknown || /[\r\n\0]/.test(value) || !value.trim()) return null;
  return value;
}
