/**
 * What a new chat connection is called before anybody types anything.
 *
 * Its own file rather than a few lines inside `GatewayList.tsx`, which is already over the size cap
 * and may shrink but not grow.
 */

/**
 * The agent's own id.
 *
 * It was `"main"`, for every agent and every platform, and that is not merely a vague name — the
 * save is an upsert keyed on `<platform>:<name>`. Two agents accepting the default meant the second
 * one silently took the first one's connection over: the id matched an existing row, and the
 * incoming `agent` won. Nothing refused it and nothing said it had happened.
 *
 * Naming it after the agent makes the id unique by construction, and reads as what it is everywhere
 * the id is printed — `whatsapp:ren`, not `whatsapp:main`.
 *
 * Lowercased and trimmed because `saveGateway` does both before building the id, and a default that
 * did not would show `whatsapp:Ren` in the hint while saving `whatsapp:ren`.
 *
 * A second connection on the same platform for the same agent still needs a hand-typed name. That is
 * the case worth making somebody think about, and it is rare.
 */
export function defaultConnectionName(agentId: string): string {
  return agentId.trim().toLowerCase() || "main";
}
