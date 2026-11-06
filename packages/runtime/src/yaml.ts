/**
 * YAML, for the frontmatter of skills written elsewhere.
 *
 * Nouride's own `SKILL.md` frontmatter is `key: value` lines (TD-014), but skills written to the
 * open format use real YAML — folded descriptions, `allowed-tools` lists, nested `metadata`. The
 * installer reads those with this and writes them back out flat. Throws on what is not YAML.
 */
export function parseYaml(text: string): unknown {
  return Bun.YAML.parse(text);
}
