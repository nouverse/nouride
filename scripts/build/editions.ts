/**
 * The edition this build script can produce: the one that is published.
 *
 * `pro` is not here and that is deliberate — its recipe lives in `internals/pro/packages/build-pro`, in a
 * private submodule, because which plugins it links and which markers prove it is commercial information
 * about a product that is not published. Run it with `bun run build:pro --pro`; the entry point there
 * imports the same core.
 *
 * One since Router became part of the free build: Community carries the LLM gateway, off until
 * `[nougate] in_process = true`, as Pro does — about half a megabyte of binary, and nothing running until it is
 * switched on. Its source is a private submodule, so a public clone builds Community without it, and says so;
 * `--require-gateway` is how a release refuses to. `--router` is refused by name (`scripts/build/core.ts`).
 *
 * Adding a public edition is one record. Nothing else in the build has to change.
 */

import { NOUGATE, type EditionSpec } from "./edition.ts";

export const PUBLIC_EDITIONS: EditionSpec[] = [
  {
    id: "basic",
    flag: "",
    bundles: [],
    ifCheckedOut: [
      {
        plugin: NOUGATE,
        require: "--require-gateway",
        carried: "LLM gateway bundled in — set `[nougate] in_process = true` to use it",
        missing: "no LLM gateway — internals/nougate is not checked out; point a provider at one on the network",
      },
    ],
    banner: [
      "single account only — the multi-user rules are not in this build",
      "no external sign-in — [dashboard.oauth] is refused by this build",
    ],
    public: true,
  },
];
