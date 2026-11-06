/**
 * Reading a JSON answer out of a model's reply.
 *
 * Shared by every unattended pass that asks a model for an object — the reflection loop's skill
 * drafts, memory's nightly pass — so the lessons below are learned once.
 */

/**
 * The JSON object in the model's answer, whatever it wrapped it in.
 *
 * Three attempts, and the **order is the fix for a bug the live box found**. The first version pulled
 * the fenced block out with `/```(?:json)?([\s\S]*?)```/` and looked inside it. That works for every
 * answer except the one this pass actually produces: a skill body is markdown, markdown is full of
 * ```bash fences, and the non-greedy match therefore stopped at the *first fence inside the JSON
 * string* — leaving a fragment with no closing brace. On 2026-09-01 the daemon logged "did not answer
 * with JSON" about a perfectly well-formed reply and dropped a real draft on the floor.
 *
 * Brace-matching over the whole text has no such failure: the outermost `{` and the last `}` are the
 * object's own, and the fences inside it are inert. The fenced extraction stays, last, for the one
 * case brace-matching cannot do — prose *after* the block that happens to contain a brace.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const attempt = (candidate: string | undefined): Record<string, unknown> | null => {
    if (!candidate) return null;
    try {
      const value: unknown = JSON.parse(candidate);
      return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const braced = (source: string): string | undefined => {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    return start >= 0 && end > start ? source.slice(start, end + 1) : undefined;
  };

  return (
    attempt(text.trim()) ??
    attempt(braced(text)) ??
    attempt(braced(/```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? ""))
  );
}
