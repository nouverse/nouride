/**
 * The editions this build script can produce: the two that are published.
 *
 * `pro` is not here and that is deliberate — its recipe lives in `internals/pro/packages/build-pro`, in a
 * private submodule, because which plugins it links and which markers prove it is commercial information
 * about a product that is not published. Run it with `bun run build:pro --pro`; the entry point there
 * imports the same core.

 *
 * Adding a public edition is one record. Nothing else in the build has to change.
 */

import { NOUGATE, type EditionSpec } from "./edition.ts";

export const PUBLIC_EDITIONS: EditionSpec[] = [
  {
    id: "basic",
    flag: "",
    bundles: [],
    banner: [
      "no LLM gateway — point a provider at one on the network",
      "single account only — the multi-user rules are not in this build",
      "no external sign-in — [dashboard.oauth] is refused by this build",
    ],
    public: true,
  },
  {
    id: "router",
    flag: "--router",
    bundles: [NOUGATE],
    banner: [
      "LLM gateway bundled in — set `[nougate] in_process = true` to use it",
      "single account only — the multi-user rules are not in this build",
      "no external sign-in — [dashboard.oauth] is refused by this build",
    ],
    public: true,
  },
];
