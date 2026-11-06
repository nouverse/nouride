/**
 * The `edits` argument of `multi_edit`, checked before anything touches the file.
 *
 * Pure, and apart from the tool for that reason: every refusal here is a sentence the model reads and
 * corrects from, and it can be tested without a workspace on disk.
 */

interface ParsedEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** Beyond this it is a rewrite, and `write` describes a rewrite better than a list of replacements. */
const MAX_EDITS = 50;

export function parseEdits(raw: unknown): { list: ParsedEdit[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "`edits` must be a non-empty array." };
  }
  if (raw.length > MAX_EDITS) {
    return { error: `At most ${MAX_EDITS} edits at once. Past that, write the file.` };
  }

  const list: ParsedEdit[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { error: `Edit ${index + 1} must be an object.` };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.old_string !== "string" || typeof record.new_string !== "string") {
      return { error: `Edit ${index + 1}: \`old_string\` and \`new_string\` must both be strings.` };
    }
    if (record.old_string === record.new_string) {
      return { error: `Edit ${index + 1}: the two strings are identical, so there is nothing to do.` };
    }
    list.push({
      oldString: record.old_string,
      newString: record.new_string,
      replaceAll: record.replace_all === true,
    });
  }
  return { list };
}
