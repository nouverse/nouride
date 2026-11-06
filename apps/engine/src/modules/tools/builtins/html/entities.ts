/**
 * The entity names worth knowing, and every numeric one.
 *
 * Not the full HTML5 table — that is two thousand names, nearly all of which never appear in prose a
 * model is asked to read. What is here is the set that shows up in real documents: the five that are
 * mandatory, the punctuation a CMS inserts, and the symbols a docs page uses in a table.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  middot: "·", bull: "•", copy: "©", reg: "®", trade: "™",
  deg: "°", plusmn: "±", times: "×", divide: "÷", euro: "€", pound: "£", yen: "¥",
  larr: "←", rarr: "→", harr: "↔", check: "✓", cross: "✗",
};

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;

  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Anything outside the Unicode range, and the surrogate block, comes back as written rather
      // than as a replacement character — an unreadable source is more useful than a lie.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
