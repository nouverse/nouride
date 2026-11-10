/**
 * LLM Gateway — the gateway this build carries, as a page of this dashboard.
 *
 * Its own frontend, in a frame of this origin: the daemon serves it under `/llm-gateway/` after
 * checking this session (`engine/src/modules/web/llm-gateway.ts`), and the gateway draws itself
 * without a sidebar or a sign-in of its own when it is shown this way. One login, one menu, and the
 * gateway's code stays the gateway's.
 *
 * Two things cross the frame, both by `postMessage` and both checked for this origin: the theme goes
 * in, so the page matches the switch in the sidebar; the gateway's current page comes out, so the
 * address bar follows it (`search.ts`).
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { NougateGlyph, NougateMark } from "@/commons/components/brand/logos";
import { api } from "@/commons/lib/api";
import { gatewayDashboard, gatewayMount, gatewaySwitch } from "@/commons/lib/bundled-gateway";
import { frameSource, type GatewaySearch } from "./search";
import { GatewayOff } from "./components/GatewayOff";
import { SetByServer } from "./components/SetByServer";
import { StopsAtNextStart, TurnOff } from "./components/TurnOff";
import { DetailLoading } from "@/commons/components/ui/Skeleton";

/** The sidebar's theme, read off the document root it sets — `nouride-light` or `nouride`. */
function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "nouride-light" ? "light" : "dark";
}

export default function LlmGatewayPage({ search, onPage }: { search: GatewaySearch; onPage: (page: string) => void }) {
  const { data: state, isPending } = useQuery({ queryKey: ["setup"], queryFn: api.setupState });
  const mount = gatewayDashboard(state);
  // Null from a daemon older than the switch: the page as it was, with nothing to turn.
  const switched = gatewaySwitch(state);
  const frame = useRef<HTMLIFrameElement>(null);
  // The first address only. Later pages are the gateway's own navigation inside the frame — setting
  // `src` again on every report would reload it under the person's feet.
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (mount && src === null) setSrc(frameSource(mount, search.page, currentTheme()));
  }, [mount, search.page, src]);

  // The theme, every time the sidebar's switch changes it.
  useEffect(() => {
    const send = () =>
      frame.current?.contentWindow?.postMessage({ type: "nouride:theme", theme: currentTheme() }, window.location.origin);
    const observer = new MutationObserver(send);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Where the gateway is now, into the address bar.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type !== "nougate:navigate" || typeof event.data.path !== "string") return;
      onPage(event.data.path);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onPage]);

  if (isPending) {
    return (
      <DetailLoading cards={2} />
    );
  }

  if (switched && !switched.on) return <GatewayOff locked={switched.locked} />;

  if (!mount && gatewayMount(state)) return <OlderBundle baseUrl={state?.bundledGateway?.baseUrl} />;

  if (!mount) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-sm text-center space-y-2">
          <NougateGlyph size={28} className="mx-auto text-base-content/30" />
          <h1 className="text-base font-bold">Nougate is not part of this version</h1>
          <p className="text-sm text-base-content/65">Your agents reach their AI through the services on the Models page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-base-content/[0.08] bg-base-100/70 px-4 backdrop-blur-xl">
        <div className="flex items-center gap-2 min-w-0">
          <NougateMark className="size-5 shrink-0" />
          <h1 className="text-sm font-bold tracking-tight shrink-0">LLM Gateway</h1>
          {/* The one plain line on an admin page (0.8.19): what it is for, on a phone too. */}
          <span className="text-xs text-base-content/65 truncate">The AI accounts and keys your agents use, and what they cost</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {switched && (switched.locked ? <SetByServer on compact /> : switched.stopping ? <StopsAtNextStart /> : <TurnOff />)}
          {/* The same page, full width — the frame is this origin's, so it carries this session. */}
          <a
            href={`${mount}/frontend${search.page ?? "/"}`}
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn-ghost btn-xs rounded-lg gap-1.5 text-base-content/65 hover:text-base-content"
            title="Open in a new tab"
          >
            <ExternalLink size={13} />
            <span className="hidden sm:inline">New tab</span>
          </a>
        </div>
      </div>
      {src && (
        <iframe
          ref={frame}
          src={src}
          title="LLM Gateway"
          className="w-full flex-1 min-h-0 border-0 bg-base-100"
          onLoad={() =>
            frame.current?.contentWindow?.postMessage({ type: "nouride:theme", theme: currentTheme() }, window.location.origin)
          }
        />
      )}
    </div>
  );
}

/**
 * The gateway is here, but the dashboard bundle beside the binary predates being shown in this one.
 *
 * What an update from before 2026-10-15 leaves: it replaced the binary and not that directory. Framed,
 * the old bundle would call this daemon's API instead of the gateway's, so it is not framed — the page
 * says what is going on and where the gateway's own console is meanwhile, on its own port with its own
 * sign-in. The next update replaces the bundle and this page becomes the gateway's dashboard.
 */
function OlderBundle({ baseUrl }: { baseUrl: string | undefined }) {
  let port = "18256";
  try {
    port = baseUrl ? new URL(baseUrl).port || port : port;
  } catch {
    // The default port, then.
  }
  const console_ = `${window.location.protocol}//${window.location.hostname}:${port}/frontend/`;
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center space-y-3">
        <NougateGlyph size={28} className="mx-auto text-base-content/30" />
        <h1 className="text-base font-bold">The LLM Gateway page arrives with the next update</h1>
        <p className="text-sm text-base-content/65">
          The gateway is running, but the dashboard files installed beside it are from an earlier version and cannot be shown
          here yet. The next update replaces them. Until then its own console is on port {port}, with its own sign-in.
        </p>
        <a href={console_} target="_blank" rel="noreferrer noopener" className="btn btn-sm btn-ghost rounded-xl gap-1.5">
          <ExternalLink size={13} /> Open the gateway console
        </a>
      </div>
    </div>
  );
}
