/**
 * Names joined the way a person writes them, for every sentence the dashboard says about several people or agents: the
 * knowledge base's readers and a room's members alike.
 */

/** "Dina", "Dina and Kak Sam", "Dina, Kak Sam and Raka". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
