import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { NotFound, RouteError } from "@/commons/components/layout/RouteError";
import { routeTree } from "./routeTree.gen";

/** The app's router — the one `main.tsx` mounts and the mount test drives, so both have its error and 404 pages. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    // Matches vite's `base` — the engine serves this app under /dashboard/.
    basepath: "/dashboard",
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
    ...(history ? { history } : {}),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }

  /** What a route says about itself to the layout around it, set as `staticData` in its route file. */
  interface StaticDataRouteOption {
    /** The page fills the viewport and scrolls inside its own panels, rather than scrolling as a document. */
    ownsViewport?: boolean;
    /** Padded like any page, but held to the window's height: its list scrolls in its own card, the tabs stay put. */
    fillsViewport?: boolean;
  }
}
