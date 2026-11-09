/**
 * Every key a pack's `config.toml` reads, by table — and the ones a pack writes that nothing reads.
 *
 * The daemon's config has always warned about a key it does not know (`config/global/merge.ts`); a pack did not, so a
 * typo — `[llm] modle` — or a key a release deleted was silent: the agent loaded and the line did nothing. Warned about
 * now, by file, table and key, and still loaded: a word nothing reads changes nothing, so refusing the agent over it
 * would cost more than the line does. A key a release *renamed*, whose loss would change what the agent does, is
 * refused by `parseAgentConfig` instead, naming the new one.
 *
 * Kept beside the parser, and a key it reads goes here too: one missing would be warned about on every load of a pack
 * that writes it. The example pack every operator copies (`content/agents/example`) loads without a word
 * (`agent-example.test.ts`), which holds the two together for what it shows.
 */

/** A table's keys, or `"open"` for one whose keys are the operator's — `[channels]`, by gateway id. */
const PACK_KEYS: Readonly<Record<string, readonly string[] | "open">> = {
  agent: ["display_name", "emoji", "enabled", "approvals", "access"],
  llm: [
    "provider", "model", "small_model", "high_model", "max_tokens", "temperature", "effort", "context_window", "fallbacks",
    "compact_at_tokens", "max_tool_iterations", "max_turn_seconds",
    // Refused by the parser, naming `fallbacks` — listed so it is refused once rather than also warned about.
    "fallback_model",
  ],
  channels: "open",
  tools: ["enabled", "approval_required", "blocked"],
  security: ["sender_allowlist", "exec_secrets", "ssh_agent", "credentials", "shared_tools", "model_guard"],
  workspace: ["roots", "skill_roots"],
  // Refused by the parser, naming the install's library — listed so it is refused once rather than also warned about.
  mcp_servers: "open",
  external: ["cli", "profile", "model", "permissions"],
  look: ["fur", "pattern", "outfit", "outfit_color", "hat", "accessory", "eyes"],
  jobs: ["quiet_after_minutes"],
  delegate: ["max_background"],
  missions: ["per_agent"],
};

/** Each key `raw` holds that no table reads, as the file writes it: `[llm] modle`, or `[rsi]` for a whole table. */
export function unknownPackKeys(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const unknown: string[] = [];
  for (const [table, value] of Object.entries(raw)) {
    const known = PACK_KEYS[table];
    if (known === undefined) {
      unknown.push(`[${table}]`);
      continue;
    }
    if (known === "open" || typeof value !== "object" || value === null || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) if (!known.includes(key)) unknown.push(`[${table}] ${key}`);
  }
  return unknown;
}
