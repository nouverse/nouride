import { NourideError } from "@nouride/shared";

/**
 * What a crash leaves in the log, for an error nobody caught.
 *
 * `String(err)` rather than `err.message`, so the line keeps the class name — `ConfigError: …`, not the message alone —
 * and the stack whole: in a release binary the frames are mangled positions (`/$bunfs/root/nouride:41:6983`) that only
 * `bun run symbolize` turns back into source, and it needs them all (`docs/CONTRIBUTING.md`, "A stack trace from a
 * release build").
 */
export function crashDetail(err: unknown): { error: string; stack?: string } {
  return {
    error: String(err),
    ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
  };
}

/**
 * What a command says when a throw reached its top: the error by its class and message, and — unless it is a refusal
 * the code meant (a `NourideError`, written for whoever reads it) — the stack, the frames symbolize needs.
 */
export function crashReport(err: unknown): { message: string; stack: string | null } {
  const { error, stack } = crashDetail(err);
  return { message: error, stack: err instanceof NourideError ? null : (stack ?? null) };
}
