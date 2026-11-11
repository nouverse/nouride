/**
 * The router's error and not-found pages (`router.tsx`). Without them a page that threw while drawing replaced the
 * whole app, sidebar included, with an unstyled "Something went wrong!", and a mistyped address with a bare
 * "Not Found" — dead ends with no way back but the address bar.
 */

import { Link, type ErrorComponentProps } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { Mascot, type Pose } from "@/commons/components/brand/Mascot";
import { useEffect } from "react";
import { isChunkLoadError, reloadForNewBuild, tabStorage } from "@/commons/lib/new-build";

export function RouteError({ error }: ErrorComponentProps) {
  // A chunk of the build this tab started with, gone since an upgrade: reloading is the fix, so it is done — once.
  const stale = isChunkLoadError(error);
  useEffect(() => {
    if (stale) reloadForNewBuild(tabStorage(), () => window.location.reload());
  }, [stale]);

  return (
    <Panel
      pose={stale ? "update" : "offline"}
      title={stale ? "The dashboard was updated" : "This page ran into an error"}
      role="alert"
    >
      <p className="text-sm text-base-content/70">
        {stale
          ? "This tab opened on an older version, and part of this page is no longer on the server. Reloading loads the new one."
          : "Something on this page failed while drawing it. Reloading usually clears it; if not, the message below is what to report."}
      </p>
      {!stale && (
        <pre className="text-xs bg-base-200 rounded-lg p-3 whitespace-pre-wrap break-words font-mono">
          {error instanceof Error ? error.message : String(error)}
        </pre>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm gap-1.5" onClick={() => window.location.reload()}>
          <RotateCw size={14} aria-hidden="true" /> Reload
        </button>
        <Link to="/" className="btn btn-ghost btn-sm">
          Home
        </Link>
      </div>
    </Panel>
  );
}

export function NotFound() {
  return (
    <Panel pose="lost" title="No page here">
      <p className="text-sm text-base-content/70">
        This address is not a page of the dashboard: a mistyped link, or one from an older version.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link to="/" className="btn btn-primary btn-sm">
          Go to Home
        </Link>
      </div>
    </Panel>
  );
}

function Panel({ pose, title, role, children }: { pose: Pose; title: string; role?: "alert"; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[50dvh] w-full max-w-xl flex-col items-center justify-center gap-2 p-4">
      <Mascot pose={pose} decorative className="w-36" />
      <div role={role} className="w-full space-y-3 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-5 shadow-soft">
        <h1 className="text-xl text-base-content">{title}</h1>
        {children}
      </div>
    </div>
  );
}
