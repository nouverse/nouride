/**
 * A path under the data folder, as the Files page walks it: `/` between its parts, nothing before the first.
 */

/** Each folder on the way to `path`, nearest last, with the path that opens it. */
export function crumbsOf(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/** The folder `path` is in; the data folder itself for an entry of its own. */
export function parentOf(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

/** The language a file's words are coloured as, by its name's ending; nothing for one the highlighter does not know. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonl: "json", py: "python", sh: "bash", bash: "bash", zsh: "bash", toml: "ini", ini: "ini", conf: "ini", env: "ini",
  yml: "yaml", yaml: "yaml", css: "css", html: "xml", xml: "xml", svg: "xml", sql: "sql", go: "go", rs: "rust", diff: "diff", patch: "diff",
};

export function languageOf(name: string): string | undefined {
  if (/^dockerfile$/i.test(name)) return "dockerfile";
  return LANGUAGES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""];
}

/** A file written to be read as a page: drawn as one, with its source a press away. */
export function isMarkdown(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}
