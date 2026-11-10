/**
 * Past this, one server's tool schemas are said at warn when it connects, and by `nouride doctor`.
 *
 * Half of what every built-in tool together comes to — `tool-schema-budget.test.ts` holds them under 33,900
 * characters — so a server past it costs the agent holding it more of the window than most of its built-ins, on every
 * request of every tool iteration. The built-ins' budget is a test; a server's schemas are somebody else's, arrive at
 * runtime, and can only be said.
 */
export const MCP_SCHEMA_WARN_BYTES = 16_000;
