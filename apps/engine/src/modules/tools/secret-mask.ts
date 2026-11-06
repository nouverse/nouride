/**
 * Every tool's result masked against the credentials its agent's commands were given, and those sent in its
 * conversation — the masker itself is `@nouride/secrets`' (`mask.ts`), which says why exact values and not shapes.
 *
 * And against every credential the daemon holds itself (0.7.17): the store's values, and what the control token and the
 * files in the credentials directory hold. Whole, and only those worth masking in a conversation, as what leaves the
 * daemon is masked of them (`commons/egress.ts`) — a tool's result is stored as it comes back, so this is where a value
 * printed by a path no guard foresaw stops short of the session's history.
 */

import { maskSecrets } from "@nouride/secrets";
import type { Tool, ToolContext } from "@nouride/shared";
import { egressValues } from "@/commons/egress.ts";

/** The same tool, with its result masked against the credentials this call could know of before anything sees it. */
export function withSecretMask(tool: Tool, known: (ctx: ToolContext) => Record<string, string>, own?: () => Record<string, string>): Tool {
  return {
    ...tool,
    async execute(args, ctx) {
      const result = await tool.execute(args, ctx);
      const mine = maskSecrets(result.content, known(ctx));
      const masked = own ? maskSecrets(mine, egressValues(own()), { whole: true }) : mine;
      return masked === result.content ? result : { ...result, content: masked };
    },
  };
}
