import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { precompress } from "./scripts/precompress";
import { preloadFont } from "./scripts/preload-font.ts";
import { ROUTE_OPTIONS } from "./scripts/routes.ts";

export default defineConfig(({ mode }) => {
  // Env lives at the repo root — one .env for the engine and the dashboard, so a
  // port change does not have to be made twice.
  const env = loadEnv(mode, "../../", "");
  const backend = env.VITE_BACKEND_URL || `http://localhost:${env.PORT || 18254}`;

  // The release this bundle was built for — read where the daemon reads the version it reports on `/health`
  // (`apps/engine/src/commons/version.ts`). A tab left open across an update compares the two (`commons/lib/bundle.ts`).
  const version = (JSON.parse(readFileSync(new URL("../engine/package.json", import.meta.url), "utf8")) as { version: string }).version;

  return {
    // The engine serves the built assets under /dashboard/, so every emitted URL
    // has to be prefixed at build time.
    base: "/dashboard/",
    define: { __NOURIDE_VERSION__: JSON.stringify(version) },
    envDir: "../../",
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        /**
         * The brand assets, which live once in `packages/shared/assets` and are used by every
         * surface.
         *
         * An alias rather than a `@nouride/shared` dependency, deliberately. These are *files*, not
         * modules — Vite hashes the PNG into this app's own output and nothing of the package's code
         * comes with it. Adding the package to `dependencies` for a logo would also make
         * `import { MessageEnvelope } from "@nouride/shared"` resolve from here, and
         * §3 of docs/ARCHITECTURE.md keeps this app on HTTP and out of engine code on purpose. A door that
         * wide is not worth a favicon.
         */
        "@brand": fileURLToPath(new URL("../../packages/shared/assets", import.meta.url)),
      },
    },
    plugins: [
      /**
       * Before `react()`, which the plugin requires. `autoCodeSplitting` puts each route's component in a
       * chunk of its own, loaded when the route is first opened: the whole dashboard was one 958 KB
       * script, every page parsed on the first load of any of them.
       */
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        ...ROUTE_OPTIONS,
      }),
      react(),
      tailwindcss(),
      // `.br` and `.gz` beside each script and stylesheet, which the daemon serves by Accept-Encoding.
      precompress(),
      preloadFont("manrope-latin.woff2"),
    ],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      /**
       * A font is always a file of its own, never a `data:` URI in the stylesheet. Vite inlines any asset under
       * 4 KB, and the dashboard's CSP has no `font-src`, so fonts fall to `default-src 'self'`, which refuses
       * `data:`: a subset that shrank under the limit would stop rendering, with only a console line to say so.
       */
      assetsInlineLimit: (file: string) => (file.endsWith(".woff2") ? false : undefined),
    },
    server: {
      port: 18255,
      // `vite dev` is only for fast UI iteration; the engine still owns the API.
      proxy: {
        "/api": backend,
        "/health": backend,
        // The bundled gateway's dashboard, served by the engine on a Router build.
        "/llm-gateway": backend,
      },
    },
  };
});
