/**
 * Which release this page's code is (`__NOURIDE_VERSION__`, stamped by `vite.config.ts`), against the one the daemon
 * runs (`/health`).
 *
 * The dashboard ships inside the daemon, so the only version skew there is is a tab left open across an update —
 * `nouride update` from the CLI, another tab's Install, an automatic one, a rollback. That tab kept calling the new
 * API with the old code until somebody reloaded, and the failures showed up as odd errors on unrelated pages. Told
 * now, it reloads into the daemon's own.
 */

declare const __NOURIDE_VERSION__: string | undefined;

/** The release this bundle was built for, or null outside a build — a test, the dev server's first load. */
export function bundleVersion(): string | null {
  return typeof __NOURIDE_VERSION__ === "string" && __NOURIDE_VERSION__ ? __NOURIDE_VERSION__ : null;
}

/** Whether the daemon runs another release than this page's code: `v0.7.8` and `0.7.8` are one. Unknown is not stale. */
export function staleBundle(bundle: string | null, running: string | undefined): boolean {
  if (!bundle || !running) return false;
  return bundle.replace(/^v/, "") !== running.replace(/^v/, "");
}
