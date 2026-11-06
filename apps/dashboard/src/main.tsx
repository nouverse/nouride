import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/commons/components/ui/toast";
import { reloadForNewBuild, tabStorage } from "@/commons/lib/new-build";
import { connectRestart } from "@/commons/lib/restart";
import { createAppRouter } from "./router";
import "./styles/main.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Agent status and gateway health go stale in seconds; refetching on focus is
      // the cheapest way to keep an open dashboard honest.
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  },
});

// A restart is followed back by one follower, which refetches this client and holds it while the daemon is away.
connectRestart(queryClient);

const router = createAppRouter();

// A chunk of the build this tab started with, gone since an upgrade, failing as Vite preloads it: reload into the new
// build, once (`new-build.ts`). Not reloading leaves the error to the route's error page, which says so.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewBuild(tabStorage(), () => window.location.reload())) event.preventDefault();
});

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root not found");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/*
        Above the router, not inside `RootLayout`: a toast has to survive the navigation that often
        follows the action that raised it, and `RootLayout` returns a different tree for the login
        and setup screens — which is where "wrong password" and "provider saved" belong too.
      */}
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
