import { eventually } from "../../wait.ts";

/**
 * The fake CLI's stderr lines that `keep` picks, once `want` of them have come. What it says on stderr reaches the
 * connection apart from its answer on stdout, so a line can trail the call it was said in: read the moment the call
 * returned, a count came one short on CI (2026-10-28). Past the wait, the lines as they stand, for the test to judge.
 */
export async function stderrSaid(connection: { readonly stderrTail: readonly string[] }, keep: (line: string) => boolean, want: number): Promise<string[]> {
  const kept = () => connection.stderrTail.filter(keep);
  await eventually(() => kept().length >= want, 4_000, `${want} such lines on the CLI's stderr`).catch(() => undefined);
  return kept();
}
