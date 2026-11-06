/**
 * What each conversation's CLI session opened on (0.8.8): the fingerprint of its instructions (`writeInstruction`), by
 * the key its session is kept by. A session opened on other instructions is let go at its conversation's next turn
 * (`runner.ts`). Kept in the database beside the sessions, so a restart that changed them — an upgrade's harness text — lets the
 * session go too, rather than reopening it as it was.
 */

export interface InstructedFile {
  load(): Record<string, string>;
  save(instructed: Record<string, string>): void;
}

export class Instructed {
  private by: Record<string, string>;

  /** Without a file, held for the process alone — a test's service. */
  constructor(private readonly file?: InstructedFile) {
    this.by = file?.load() ?? {};
  }

  of(at: string): string | undefined {
    return this.by[at];
  }

  /** What a session opened on; null where its instructions could not be written, which is none known. */
  keep(at: string, fingerprint: string | null): void {
    if (fingerprint === null) return this.forget((key) => key === at);
    this.by = { ...this.by, [at]: fingerprint };
    this.file?.save(this.by);
  }

  /** What the sessions `gone` names opened on, forgotten: each is let go at its next turn. */
  forget(gone: (at: string) => boolean): void {
    const left = Object.fromEntries(Object.entries(this.by).filter(([at]) => !gone(at)));
    if (Object.keys(left).length === Object.keys(this.by).length) return;
    this.by = left;
    this.file?.save(left);
  }
}
