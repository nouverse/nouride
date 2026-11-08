/**
 * Image imports, typed as their emitted URL.
 *
 * A wildcard module declaration, so **TypeScript cannot check the path**: `@brand/does-not-exist.png`
 * typechecks exactly as well as a real file. The build is the guard — Rollup fails loudly with
 * "failed to resolve import" — so a broken asset path is a red build rather than a missing image at
 * runtime. Adding `@brand/*` to `paths` does not change this: an ambient wildcard wins over path
 * resolution for a non-relative specifier, which was tried.
 */
declare module "*.png" {
  const src: string;
  export default src;
}

/** The mascot's poses (`@brand/mascot/…`), typed as their emitted URL like the PNGs above. */
declare module "*.webp" {
  const src: string;
  export default src;
}

/** A pose built into the bundle as a `data:` URL (Vite's `?inline`): drawn with the daemon unreachable. */
declare module "*.webp?inline" {
  const src: string;
  export default src;
}
