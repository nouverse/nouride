/**
 * Which edition this binary is, stamped at build time.
 *
 * The three editions differ in what was compiled in, and until now nothing in a running
 * daemon could say which one it was. That is fine while the only consumer is a person
 * reading a build log, and not fine the moment the daemon has to answer "can I replace
 * myself, and with which artifact" — `nouride-linux-x64.tar.gz` and
 * `nouride-pro-linux-x64.tar.gz` are different files and installing the wrong one
 * silently removes WhatsApp from a box that was using it.
 *
 * ## Why a stamp rather than an inference
 *
 * The obvious alternative is to read the capabilities that resolved at boot: sign-in
 * present means Pro, and so on. It could not separate `basic` from `router`, because what the
 * gateway adds is imported on demand and a
 * daemon that has never used one has not loaded it — so the inference is wrong for
 * exactly the edition whose artifact name differs.
 *
 * ## Why `--define` is safe here when it was not safe for the plugins
 *
 * `scripts/build/core.ts` records that `--define` does **not** remove a branch, which is why
 * every edition boundary is `--external` plus a dynamic import. That is a statement about
 * dead-code elimination, not about substitution: replacing an identifier with a string
 * literal is exactly what the flag does, and it is all this needs. Verified by compiling
 * a binary with and without the define and running both.
 *
 * An unstamped build — a source checkout, `bun run apps/engine/src/index.ts` — reports
 * `unknown` rather than guessing. A daemon that does not know which edition it is must
 * not download one.
 */

declare const NOURIDE_BUILD_EDITION: string;

export type BuildEdition = "basic" | "router" | "pro" | "unknown";

const EDITIONS: readonly BuildEdition[] = ["basic", "router", "pro"];

function readStamp(): BuildEdition {
  /**
   * `typeof` rather than a bare reference: without the define the identifier does not
   * exist at all, and reading it is a `ReferenceError` rather than `undefined`. With the
   * define this whole expression becomes `typeof "pro"`, which is what makes the guard
   * free rather than a branch.
   */
  if (typeof NOURIDE_BUILD_EDITION !== "string") return "unknown";
  const stamped = NOURIDE_BUILD_EDITION;
  return (EDITIONS as readonly string[]).includes(stamped) ? (stamped as BuildEdition) : "unknown";
}

/** The edition this binary was built as, or `unknown` when it was not built at all. */
export const EDITION: BuildEdition = readStamp();

/**
 * What this edition is called when a person reads it.
 *
 * The ids are build flags — `basic`, `router` — and they are the wrong words to print. `basic`
 * in particular reads as "cut down" when the edition it names is the one nearly everybody runs; it
 * is called **Community** everywhere the product speaks, and a status line that said `basic` next to
 * a version would be the one place it did not.
 *
 * The dashboard keeps its own copy of this mapping, deliberately: it is a separate build with no
 * workspace dependency on the engine, and it labels whatever daemon it is talking to — during an
 * update, the build before this one. Both know the same three editions. This one labels the binary it is compiled
 * into.
 */
const LABELS: Record<BuildEdition, string> = {
  basic: "Community",
  router: "Router",
  pro: "Pro",
  // Never printed as a name — `editionLabel` returns null for it, so the caller can say something
  // truthful instead of labelling a build that does not know what it is.
  unknown: "",
};

/** The display name for this build's edition, or null for a source checkout. */
export function editionLabel(edition: BuildEdition = EDITION): string | null {
  return LABELS[edition] || null;
}

/**
 * Whether this process is a compiled binary rather than a source checkout.
 *
 * Read from the stamp rather than from `process.execPath`, which is `bun` in both cases
 * on a machine where the daemon is run with `bun run`. The stamp exists only in something
 * `build:binary` produced, so its presence is the answer.
 */
export const COMPILED: boolean = EDITION !== "unknown";

declare const NOURIDE_BUILD_GATEWAY: string;

/** The package a build bundles the LLM gateway from, and the one `nougate-inproc.ts` imports. */
const GATEWAY_PACKAGE = "@nouverse/nougate-backend";

/**
 * Whether a build carries the LLM gateway, from its stamp, and for a source checkout from whether the package resolves.
 *
 * Its own stamp, not the edition's: since Router folded into Community the edition no longer says it. Every official
 * build carries the gateway, switched off until asked, and a build from a public clone, which has no gateway to bundle,
 * is stamped `basic` all the same. The build stamps `"bundled"` where it bundled the package and nothing where it did
 * not, so a build with the edition's stamp and not this one does not carry it.
 *
 * A source checkout has neither stamp, and carries the gateway when the package resolves there: the dev loop links
 * it into `node_modules` (`scripts/dev-router.sh`), a plain checkout does not. Resolved, never imported: loading the
 * gateway costs its whole module graph in memory, and this is asked at every start.
 */
export function gatewayCarried(build: { stamp: string | undefined; compiled: boolean; resolves: () => boolean }): boolean {
  if (build.stamp !== undefined) return build.stamp === "bundled";
  if (build.compiled) return false;
  return build.resolves();
}

function gatewayResolves(): boolean {
  try {
    import.meta.resolve(GATEWAY_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/** Whether this build carries the LLM gateway, on or off — see `gatewayCarried`. */
export const GATEWAY_CARRIED: boolean = gatewayCarried({
  // `typeof`, as `readStamp` reads the edition: without the define the identifier does not exist.
  stamp: typeof NOURIDE_BUILD_GATEWAY === "string" ? NOURIDE_BUILD_GATEWAY : undefined,
  compiled: COMPILED,
  resolves: gatewayResolves,
});
