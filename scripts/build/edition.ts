/**
 * An edition, as a value.
 *
 * ## Why this shape
 *
 * Edition knowledge used to be spread across five places in one build script: a flag→name map, four
 * `BUNDLE_*` booleans, four functions returning one banner line each, and a marker table. Every one
 * of them had to be edited together to add an edition, and nothing made them agree.
 *
 * Worse, for a repository about to go public: those five places named the private editions — which
 * plugins each links, which markers prove it, what each one is called. That is the build *recipe* for
 * editions that are not published, and it has no business in a public tree.
 *
 * So an edition is one record. The build core takes it as an argument and names none of them; the
 * public list is `editions.ts` beside this file, and the private list lives in `internals/pro/packages/build-pro`, in a
 * submodule.
 *
 * ## What cannot move with it
 *
 * The edition *names*. A `pro` binary is the public engine compiled with a different recipe,
 * and that engine has to know which edition it is or it cannot report its version, choose an update
 * channel, or refuse a config it has no code for. `apps/engine/src/commons/build.ts`,
 * `packages/update/src/edition.ts` and `scripts/targets.ts` all name all three, and all of them stay.
 * The recipe is the secret; the name is not.
 */

/** A plugin the build links into `node_modules`, or externalises out. */
export interface PluginSpec {
  /**
   * The package name the engine imports.
   *
   * A name rather than a path, because `--external` matches the import specifier and a relative
   * path cannot be matched — that was tried, along with a `--define` guard, and neither prunes one.
   */
  pkg: string;
  /**
   * Path from the repository root to the **submodule**, not necessarily to the package — or, for a plugin in this
   * repository, its own directory.
   *
   * Named in the "not checked out" error and in the `git submodule update --init` line it prints, so
   * it has to be the path git knows. The Pro plugins said `internals/pro/packages/oauth` and the like after `internals/pro`
   * became one submodule (2026-09-30), and the line printed failed with "did not match any file(s) known to git".
   * `build-flags.test.ts` holds each one to `.gitmodules`.
   */
  dir: string;
  /**
   * Where the package actually lives, when that is not `dir`.
   *
   * `internals/nougate` is a whole repository and the package is `internals/nougate/apps/backend`. Linking

   * `dir` there produced a symlink to a directory with no `package.json` for the bundler to read,
   * and the failure surfaced two minutes later as "the plugin did not resolve".
   */
  pkgDir?: string;
  /**
   * A literal from the plugin's own source that survives bundling.
   *
   * Not the package name: specifiers are rewritten by the bundler, and the first version of this
   * check passed a build that had bundled nothing. It must appear in the plugin and nowhere else in
   * the tree, so its presence proves the link and its absence proves the exclusion.
   */
  marker: string;
}

export interface EditionSpec {
  /** `pro`. What `/health` reports and what `artifactName` uses. */
  id: string;
  /** The argv flag that selects it — `""` for the default, which has none. */
  flag: string;
  /**
   * The optional plugins this edition carries.
   *
   * One field, and it decides four things: what gets linked into `node_modules`, what is verified
   * **present** in the artefact, what is `--external`, and what is verified **absent**. There was a
   * second field for the last two, and it went wrong immediately — the private editions left it
   * empty, so `nouride-oauth` was neither externalised nor checked in a `--pro` build. Two lists
   * that must agree are two lists that will not.
   */
  bundles: PluginSpec[];
  /** The lines printed under the artefact size, in order. */
  banner: string[];
  /** Whether this artefact may be published. The release workflow keys its uploads on the same fact. */
  public: boolean;
}

/**
 * The plugins every edition carries, whatever it is.
 *
 * `wa-bridge` since 2026-09-16 — WhatsApp stopped being an edition switch and there is no second
 * executable any more. `system-packages` because whether agents may install packages is decided when
 * a box is installed, not when it is built. `update` because an install that cannot tell you it is out of date is worst
 * in the free edition, the one running on somebody's own hardware with nobody watching it.
 */
export const ALWAYS: PluginSpec[] = [
  {
    pkg: "nouride-wa-bridge",
    dir: "packages/wa-bridge",
    // A WhatsApp protocol constant. `@whiskeysockets/baileys` does not survive bundling, and the
    // first version of this check failed a build that had bundled Baileys perfectly well.
    marker: "md-app-state",
  },
  {
    pkg: "nouride-update",
    dir: "packages/update",
    // There is no build where this one's absence is correct, which is the point of listing it: a
    // dropped symlink would otherwise produce a binary that compiles, runs, and answers "checking
    // for updates is not available in this build" on every edition.
    marker: "update provider active in this daemon process",
  },
  {
    // Every edition, because the choice is the operator's at install time (`--allow-packages`), not
    // the build's. Its root half ships beside the binary as `pkg/`; this is the client half.
    pkg: "nouride-system-packages",
    dir: "packages/system-packages",
    marker: "system packages provider active in this daemon process",
  },
];

/**
 * The gateway, named here rather than in a list, because two editions share it and one of them is
 * public — `router`, and `pro` since 0.7.20. The marker is its database filename — `provider:model-id` was the first choice and was
 * wrong, since `packages/llm/src/classify.ts` explains that namespacing in an error message, so the
 * marker was present in every build and the check could never fail.
 */
export const NOUGATE: PluginSpec = {
  pkg: "@nouverse/nougate-backend",
  dir: "internals/nougate",
  pkgDir: "internals/nougate/apps/backend",
  marker: "nougate.db",
};

/**
 * The two private plugins, named here and not only in `internals/pro/packages/build-pro`.
 *
 * They have to be: the public editions **exclude** them, and an exclusion has to name what it
 * excludes. That is the check standing between a mistake and a public download carrying code that
 * was never meant to leave, and it cannot live in a submodule a public clone does not have.
 *
 * Nothing leaks by naming them. `apps/engine/src/modules/users/oidc.ts` imports `nouride-oauth` and
 * `multi-user.ts` imports `nouride-multi-user`, both in this repository; the markers are an error
 * sentence and a log line. What stays private is the *recipe* — which editions bundle them.
 */
export const OAUTH: PluginSpec = {
  pkg: "nouride-oauth",
  dir: "internals/pro",
  pkgDir: "internals/pro/packages/oauth",
  // Not `code_challenge_method`, which is short enough to plausibly appear elsewhere one day.
  marker: "the provider did not return an email for this account",
};

export const MULTI_USER: PluginSpec = {
  pkg: "nouride-multi-user",
  dir: "internals/pro",
  pkgDir: "internals/pro/packages/multi-user",
  marker: "multi-user capability provider active in this daemon process",
};

/**
 * Hardware pairing and licensing — the Box's half of `service.nouverse.tech/api/appliances`.
 *
 * Named here for the same reason the two above are: the public editions must be *proven* not to
 * contain it, and an exclusion has to name what it excludes. A Basic download carrying the sync
 * protocol, the fingerprint derivation and the licence verifier is the mistake this check stands in
 * front of.
 *
 * This is pairing and licensing only. Whether the daemon runs as root with its systemd sandbox
 * dropped is `nouride service install --privileged` — an operator's decision about one host, on any
 * edition, and deliberately not gated here. Tying the two together would mean a free install could
 * not be given a machine of its own, and that a box could not be hardened.
 */
export const APPLIANCE: PluginSpec = {
  pkg: "nouride-appliance",
  dir: "internals/pro",
  pkgDir: "internals/pro/packages/appliance",
  marker: "appliance pairing and licensing active in this daemon process",
};

/**
 * Every plugin an edition may or may not carry.
 *
 * The build externalises each of these unless the edition bundles it, which is the only way to get
 * that right: driving it off a per-edition *exclusion* list looked equivalent and was not. The
 * private editions list no exclusions — they are never published, so there is nothing they must be
 * proven not to contain — and that left `nouride-oauth` un-externalised in a `--pro` build. On a
 * tree with a stray `node_modules/nouride-oauth` symlink the bundler followed it and compiled the
 * sign-in flow into a binary whose own banner said "no external sign-in"; on a clean tree the
 * specifier does not resolve and the build fails outright. Caught by reading the artefact, not by a
 * test.
 *
 * `ALWAYS` is deliberately not here. Those are never externalised, by any edition.
 */
export const OPTIONAL: PluginSpec[] = [NOUGATE, OAUTH, MULTI_USER, APPLIANCE];

/** Resolve a flag to an edition, or exit naming the ones this build script knows. */
export function selectEdition(argv: string[], editions: EditionSpec[]): EditionSpec {
  const chosen = editions.filter((e) => e.flag && argv.includes(e.flag));
  if (chosen.length > 1) {
    console.error(
      `pick one edition, not ${chosen.length}: ${chosen.map((e) => e.flag).join(" ")}\n` +
        `  an edition is who a build is for, and a build is for one audience`,
    );
    process.exit(1);
  }
  const fallback = editions.find((e) => e.flag === "");
  const edition = chosen[0] ?? fallback;
  if (!edition) {
    console.error("no default edition in this list — one entry must have an empty flag");
    process.exit(1);
  }
  return edition;
}

/** Every flag these editions answer to, for `assertKnownFlags`. */
export function editionFlags(editions: EditionSpec[]): string[] {
  return editions.filter((e) => e.flag).map((e) => e.flag);
}
