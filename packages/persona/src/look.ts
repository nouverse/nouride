/**
 * `[look]` in a pack (0.8.1): the parts of the agent's cat in Nouride Office a person picked. Every key optional — one
 * left out is the hash of the agent's id — and every value one of its part's words, refused at load naming the key and
 * the words it takes: a typo would otherwise draw a cat nobody chose and say nothing.
 */

import { ConfigError, LOOK_PARTS, type AgentLook } from "@nouride/shared";

export function lookOf(raw: unknown, where: string): { look?: AgentLook } {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError(`${where} [look] must be a table`);
  const table = raw as Record<string, unknown>;
  const look: Record<string, string> = {};
  for (const [part, { key, values }] of Object.entries(LOOK_PARTS)) {
    const value = table[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      throw new ConfigError(`${where} [look] ${key} must be one of ${values.join(", ")}`);
    }
    look[part] = value;
  }
  return Object.keys(look).length > 0 ? { look: look as AgentLook } : {};
}
