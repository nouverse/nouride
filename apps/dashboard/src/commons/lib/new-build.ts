/**
 * A tab older than the build the daemon now serves.
 *
 * After an upgrade its chunk names are gone — the engine answers 404 for them (`web/dashboard-files.ts` in the
 * engine) — so the first page that loads one, the memory graph, fails to import it. Reloading fetches the new build.
 * Once: a chunk missing from the new build as well would otherwise reload the tab for ever.
 */

const KEY = "nouride:new-build-reload";
/** One reload per this long: enough to stop a loop, short enough that a later upgrade in the same tab reloads too. */
const ONCE_PER_MS = 60_000;

/** A dynamic import that failed — in each browser's words, and Vite's for a preload. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    message,
  );
}

/** Reload into the new build, unless this tab did a moment ago — then the page says so instead. */
export function reloadForNewBuild(storage: Pick<Storage, "getItem" | "setItem"> | undefined, reload: () => void, now = Date.now()): boolean {
  try {
    if (!storage || now - Number(storage.getItem(KEY) ?? 0) < ONCE_PER_MS) return false;
    storage.setItem(KEY, String(now));
  } catch {
    // Nowhere to remember it (storage blocked): nothing to stop a loop with, so no reload — the button is there.
    return false;
  }
  reload();
  return true;
}

/** `sessionStorage`, or undefined where reading it throws — a sandboxed frame, storage blocked by policy. */
export function tabStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
