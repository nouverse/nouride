/**
 * What an agent wrote, as the words of one line.
 *
 * A row that has room for a line draws no Markdown, and an agent writes Markdown: a run's result read
 * "**Daily report, 07:00** **Status** `ok`" in the list of an automation's runs. The marks are taken out and the words
 * kept, by the marks themselves and not by a reading of the whole text: a line is all that is shown, and what it is
 * cut from may end in the middle of a mark.
 */
export function plainLine(text: string): string {
  return (
    text
      // A fence's own lines; what is between them is words like any other.
      .replace(/^\s{0,3}(`{3,}|~{3,}).*$/gm, " ")
      // A picture and a link: what they say, not where they lead.
      .replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
      // What opens a heading, a quote and a list's row.
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm, "")
      // Bold and struck, then a star's italic, each only around words: "2 * 3 * 4" has none.
      .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?)(?<=[^\s*])\*(?![\w*])/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      // A mark the cut left open has nothing to close it.
      .replace(/\*\*|~~/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
