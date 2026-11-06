/**
 * Is this file a document rather than text, and what should the agent do about it?
 *
 * `read` decodes UTF-8. Handed a PDF it used to return the bytes as text — mojibake, or a decode
 * error, with nothing in either saying *what kind of thing* the agent was holding. What happened next
 * was watched on a live box: the agent guessed `pdftotext`, got `Executable not found in $PATH`, then
 * wrote a `python3 -c` script against `pypdf` from memory and got there on the second try. It
 * recovered, which is why this was easy to miss — the cost was a failed call and a script nobody
 * reviewed, on every document.
 *
 * So the harness answers the question it can answer: *this is a PDF, here is the first command, and
 * the `document-reading` skill has the rest.* Turning a dead end into a pointer is the same job the
 * spilled-output header and the job-log root already do.
 *
 * ## What this deliberately does not do
 *
 * Convert anything. An RFC proposed exactly that — a `DocumentAdapter` inside `read` with bundled
 * `mammoth` and SheetJS parsers, tiered fallbacks and per-format `page`/`sheet` parameters. It buys
 * one saved tool call for a permanent dependency in every install, and it puts the whole conversion
 * into a tool result, which is the wrong place for a 200-page report: `read` and `grep` already page
 * and spill, and a conversion on disk can be searched instead of scrolled. The knowledge belongs in a
 * skill; the pointer belongs here.
 */

/**
 * A conversion, spelled as the `exec` call that runs it. `exec` has no implicit shell, so `$TMPDIR`
 * and `>` only work inside an explicit `bash -lc`; a hint written as a bare shell line was passed to
 * the program literally.
 */
function viaShell(script: string, output: string): string {
  return `To read what is inside, convert it with \`exec\`: \`${JSON.stringify(["bash", "-lc", script])}\`, then read ${output} in your scratchpad directory, which is where $TMPDIR points.`;
}

/** Extensions whose bytes are a container, with the tool that opens each one. */
const DOCUMENTS: { kind: string; extensions: string[]; hint: string }[] = [
  {
    kind: "PDF",
    extensions: [".pdf"],
    hint: viaShell(`pdftotext -layout '<path>' "$TMPDIR/out.txt"`, "out.txt"),
  },
  {
    kind: "Word document",
    extensions: [".docx", ".doc", ".odt", ".rtf"],
    hint: viaShell(`pandoc '<path>' -t markdown -o "$TMPDIR/out.md"`, "out.md"),
  },
  {
    kind: "spreadsheet",
    extensions: [".xlsx", ".xls", ".ods"],
    // CSV per sheet, because a workbook is usually better queried than read.
    hint: viaShell(`libreoffice --headless --convert-to csv --outdir "$TMPDIR" '<path>'`, "the .csv file it writes"),
  },
  {
    kind: "presentation",
    extensions: [".pptx", ".ppt", ".odp"],
    hint: viaShell(`markitdown '<path>' > "$TMPDIR/out.md"`, "out.md"),
  },
  {
    kind: "e-book",
    extensions: [".epub", ".mobi"],
    hint: viaShell(`pandoc '<path>' -t markdown -o "$TMPDIR/out.md"`, "out.md"),
  },
  {
    kind: "archive",
    extensions: [".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar"],
    // No skill for this one: unpacking is ordinary shell work the agent already knows.
    hint:
      "To read what is inside, unpack it first, e.g. with `exec`: " +
      `\`${JSON.stringify(["bash", "-lc", `mkdir -p "$TMPDIR/unpacked" && tar -xf '<path>' -C "$TMPDIR/unpacked"`])}\`` +
      ", then read the files in unpacked/ in your scratchpad directory, which is where $TMPDIR points.",
  },
  {
    kind: "image",
    extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".heic", ".svgz"],
    // Reached by a format a model cannot take (`read` shows PNG, JPEG, GIF and WebP — `read-image.ts`),
    // or by a daemon that does not read images at all.
    hint:
      "`read` shows a PNG, JPEG, GIF or WebP image as a picture; convert this one first (`sips -s format png` " +
      "on macOS, ImageMagick's `convert`) and read the copy. If it was sent in this conversation, `attachment_read` " +
      "opens it. If you need the text in it, OCR it with `tesseract` through `exec`.",
  },
];

export interface DocumentKind {
  /** What it is, in words an agent can repeat to a person. */
  kind: string;
  /** The first thing to try. */
  hint: string;
  /** Whether `document-reading` covers this format. */
  skill: boolean;
}

/**
 * Classify by extension, which is free and right for every file that arrived with a name.
 *
 * Extension and not content, for the common case: an attachment keeps the name it was sent with, and a
 * header sniff costs a read on every single `read` call to catch a file somebody stripped the suffix
 * off. `looksBinary` covers that case afterwards, on bytes already in hand.
 */
export function documentKindFor(path: string): DocumentKind | null {
  const lower = path.toLowerCase();
  for (const entry of DOCUMENTS) {
    if (!entry.extensions.some((ext) => lower.endsWith(ext))) continue;
    return {
      kind: entry.kind,
      hint: entry.hint,
      // Archives and images are shell work and vision respectively; the skill is about documents.
      skill: entry.kind !== "archive" && entry.kind !== "image",
    };
  }
  return null;
}

/**
 * Does this head look like binary rather than text?
 *
 * A NUL byte, which no valid UTF-8 text file contains. Deliberately the only test: heuristics that
 * count "unusual" byte ratios reject minified JavaScript, base64 blobs and anything non-Latin, and a
 * `read` that refuses a legitimate file is worse than one that returns something ugly.
 */
export function looksBinary(head: Uint8Array): boolean {
  return head.includes(0);
}

/** What `read` says instead of returning bytes it cannot decode. */
export function documentReadMessage(displayPath: string, found: DocumentKind): string {
  return [
    `${displayPath} is ${/^[aeiou]/i.test(found.kind) ? "an" : "a"} ${found.kind}, not text: its bytes will not decode into anything you can use.`,
    found.hint.replace("<path>", displayPath),
    ...(found.skill
      ? [
          "The `document-reading` skill has the ladder for every format, what to do when the tool is " +
            "missing, and why a long document is worth grepping rather than reading straight through.",
        ]
      : []),
  ].join("\n");
}

/** What `read` says for a binary file it cannot name. */
export function binaryReadMessage(displayPath: string): string {
  return (
    `${displayPath} is binary: it contains NUL bytes, so it is not a text file whatever its name says. ` +
    "If it is a document, convert it to text first (see the `document-reading` skill); if you only need " +
    `to know what it is, run \`exec\` with \`${JSON.stringify(["file", displayPath])}\`.`
  );
}
