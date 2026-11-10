/**
 * The shell every signed-in page renders inside: the sidebar from a laptop's width up, and on a phone a tab bar at the
 * foot with More for the rest (0.8.24). The menu itself, and why it is in that order, is `nav.tsx`.
 */

import { Link, Outlet, useMatches, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { api } from "@/commons/lib/api";
import { HOME_APP_BACK, inHomeApp } from "@/commons/lib/home-app";
import { ReconnectingBanner, ReconnectingScreen, RestartedToast, RestartPendingBar } from "./Reconnecting";
import { UpdatedBanner } from "./UpdatedBanner";
import { ImageMovedBanner } from "./ImageMovedBanner";
import { bundleVersion, staleBundle } from "@/commons/lib/bundle";
import { isAdmin, MCP_LOGIN_CALLBACK, useGate } from "@/commons/lib/session";
import { useTheme } from "@/commons/lib/theme";
import { useSignOut } from "@/commons/components/layout/sign-out";
import { gatewayPage } from "@/commons/lib/bundled-gateway";
import { isPairedBox } from "@/commons/lib/api.appliance";
import { HELD_BOTTOM, PAGE_BOTTOM } from "@/commons/components/ui/ScrollCard";
import { DRAWER_MOTION, DRAWER_SHADE, SHADE_PLACE, SHEET_BOX, SHEET_PLACE } from "@/commons/components/ui/Drawer";
import { Sidebar } from "@/commons/components/layout/Sidebar";
import { PHONE_CHAT_SPACE, TAB_BAR_SPACE, TabBar } from "@/commons/components/layout/TabBar";
import { CompactSidebar } from "@/commons/components/layout/CompactSidebar";
import { isBoolean, useKept } from "@/commons/hooks/use-kept";
import { chatOpen, onChats } from "@/commons/lib/chat-place";
import { SectionTabs } from "@/commons/components/layout/SectionTabs";
import { SettingsBack } from "@/commons/components/layout/SettingsBack";
import { Mascot } from "@/commons/components/brand/Mascot";
import { useNeedsYou } from "@/commons/hooks/use-needs-you";
import { cn } from "@/commons/lib/utils";

/** Where this browser keeps whether the menu is expanded beside Chats. */
const CHAT_MENU_KEY = "nouride-chat-menu-open";

/** The browser tab says how many things wait for you, so a tab in the background still tells you. */
function useTitle(total: number) {
  useEffect(() => {
    document.title = total > 0 ? `(${total}) Nouride` : "Nouride";
  }, [total]);
}

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.searchStr });
  // The page actually drawn: the location moves at once on a navigation, the matched page only once its route is in.
  const drawnPath = useRouterState({ select: (s) => s.resolvedLocation?.pathname ?? s.location.pathname });
  /** Where a gate redirect went, until that page is the one drawn (see the spinner below). */
  const redirectedTo = useRef<string | null>(null);
  /**
   * Pages that own the viewport rather than growing past it.
   *
   * Everything else scrolls as a document, which is right for a page you read top to bottom. It is
   * wrong for a page whose whole content is a long list: the header, the tabs and the filters scroll
   * away with it, so filtering means scrolling back up to reach the control. Chat, Logs and
   * Secrets keep their chrome fixed and scroll inside their own panels, and the LLM Gateway's frame
   * scrolls itself.
   *
   * Each route says so itself (`staticData`), rather than this matching the address: `includes("/chat")`
   * was also true of `/agents/chatbot/settings`, so every page of an agent called `chatbot`, `logs-bot`
   * or `secrets` lost its scrolling and its padding, with its Save buttons below the fold out of reach.
   */
  const ownsViewport = useMatches({ select: (matches) => matches.some((match) => match.staticData.ownsViewport === true) });
  /**
   * A page whose list scrolls inside its own card (`fillsViewport`): padded and centred like any page, but held to the
   * window's height, so the header and the tabs stay put and only the list moves. The page's root is
   * `FILL_PAGE` and its list a `ScrollCard fill`; the area still scrolls past the card's minimum height, so a short
   * screen, or a form open above the list, loses nothing. From a laptop's width up: on a phone such a page scrolls as a
   * document, as every other does.
   */
  const fillsViewport = useMatches({ select: (matches) => matches.some((match) => match.staticData.fillsViewport === true) });
  const gate = useGate(pathname, search);
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();
  /** More, on a phone: the menu's other pages, as a sheet that slides up over the page. */
  const [moreOpen, setMoreOpen] = useState(false);
  /** The menu expanded beside Chats, where it is folded to icons unless this browser chose otherwise (`CompactSidebar`). */
  const [menuOpen, setMenuOpen] = useKept(CHAT_MENU_KEY, false, isBoolean);
  const { total } = useNeedsYou();
  useTitle(total);
  // Whether this is a paired Box decides whether My Box exists (see `NavItem.boxOnly`). Stale for a
  // minute is fine: it changes only with the binary or a flash.
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000 });
  const onBox = isPairedBox(health.data);

  useEffect(() => {
    // `href`, not `to`: the login form's address carries the page it goes on to (`?next=`).
    if (!gate.redirectTo) return;
    redirectedTo.current = new URL(gate.redirectTo, "http://dashboard.invalid").pathname;
    void navigate({ href: gate.redirectTo });
  }, [gate.redirectTo, navigate]);

  useEffect(() => {
    if (redirectedTo.current !== null && drawnPath === redirectedTo.current) redirectedTo.current = null;
  }, [drawnPath]);

  useEffect(() => setMoreOpen(false), [pathname]);

  const { signOut, dialog: signOutDialog } = useSignOut();

  // Also while a redirect is on its way, until the page it goes to is the one drawn: the page asked for was drawn first,
  // and then again while the next page's route came in, so an unfinished install opened at Overview showed Overview,
  // then the setup wizard (Nouride Home, 2026-11-07).
  const arriving = redirectedTo.current !== null && drawnPath !== redirectedTo.current;
  if (gate.loading || gate.redirectTo || arriving) {
    return (
      // The cat on its way, where a spinner stood alone: which page comes next (the dashboard, the sign-in, the
      // setup) is not known yet, so no page's shape can be drawn. Its box is sized, and nothing moves when it arrives.
      <div className="bg-base-200/60 flex min-h-screen flex-col items-center justify-center gap-2" aria-busy="true" aria-label="loading">
        <Mascot pose="speeding" decorative className="w-32" />
        <span className="loading loading-dots loading-md text-primary opacity-60" />
      </div>
    );
  }

  // Nobody known yet and the daemon not answering — a first load during a boot. Not the login form: nobody signed out.
  if (gate.offline && !gate.principal) return <ReconnectingScreen />;

  const chromeless =
    pathname.startsWith("/login") ||
    pathname.startsWith("/setup") ||
    pathname.startsWith("/welcome") ||
    pathname.startsWith(MCP_LOGIN_CALLBACK);

  if (chromeless) {
    return (
      <div className="bg-base-200/50 min-h-screen text-base-content selection:bg-primary/20 *:animate-fade">
        <ReconnectingBanner offline={gate.offline} />
        <Outlet />
      </div>
    );
  }

  const where = { admin: isAdmin(gate.principal), onBox, hostsGateway: gatewayPage(gate.setup) };
  // On Chats the menu folds to its icons from a laptop up, unless it was expanded there; on a phone a conversation is
  // the whole screen (`chat-place.ts`).
  const chats = onChats(pathname);
  const compact = chats && !menuOpen;
  const phoneChat = chatOpen(pathname, search);

  const sidebar = (
    <Sidebar
      pathname={pathname}
      where={where}
      principal={gate.principal}
      theme={theme}
      toggleTheme={toggleTheme}
      signOut={signOut}
      onClose={() => setMoreOpen(false)}
      {...(chats ? { onFold: () => setMenuOpen(false) } : {})}
    />
  );

  return (
    /* The page's edges kept clear of a phone's notch, side and top, with `viewport-fit=cover` in index.html: on a
       desktop each inset is 0. The bottom is each page's own (`PAGE_BOTTOM`), past the tab bar that floats there. */
    <div className="bg-app flex h-screen h-[100dvh] flex-col overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-base-content selection:bg-secondary/20">
      {/* Beside the menu, not in it: folded on Chats, the menu that holds Sign out on a phone is not drawn on a laptop. */}
      {signOutDialog}
      {/* The sidebar, drawn once: fixed beside the page from a laptop's width up, and on a phone More, a sheet that slides
          up over a shade that fades, and slides back down. It stays drawn so it can be seen to go: drawn only while
          open, it came and went at once. Hidden once down (`invisible`), it and the shade take no click and no focus.
          Only their place and opacity move. */}
      <button
        type="button"
        className={cn("fixed inset-0 z-40 lg:hidden", DRAWER_SHADE, moreOpen ? SHADE_PLACE.open : SHADE_PLACE.closed)}
        onClick={() => setMoreOpen(false)}
        aria-label="Close menu"
      />
      <div
        className={cn(
          // A phone's More is a sheet as every drawer is (`Drawer`): the same corners, ground and motion.
          "fixed inset-x-0 bottom-0 z-50 flex flex-col",
          SHEET_BOX,
          // Room at its foot for the tab bar, which stays over it while it is open (`TabBar`).
          TAB_BAR_SPACE,
          DRAWER_MOTION,
          "lg:pointer-events-auto lg:visible lg:inset-y-0 lg:right-auto lg:left-0 lg:z-30 lg:max-h-none lg:translate-y-0 lg:rounded-none lg:border-r lg:border-base-content/[0.06] lg:p-0 lg:shadow-none",
          moreOpen ? SHEET_PLACE.open : SHEET_PLACE.closed,
        )}
      >
        {compact ? (
          <>
            <div className="hidden h-full lg:flex">
              <CompactSidebar pathname={pathname} where={where} onExpand={() => setMenuOpen(true)} theme={theme} toggleTheme={toggleTheme} signOut={signOut} />
            </div>
            <div className="contents lg:hidden">{sidebar}</div>
          </>
        ) : (
          sidebar
        )}
      </div>

      <div className={cn("flex h-full min-h-0 flex-1 flex-col overflow-hidden", compact ? "lg:pl-[5.5rem]" : "lg:pl-64")}>
        {/* A phone's header: the name, and the way back to Nouride Home inside its app. The rest is the tab bar's. */}
        <header className={cn("z-20 flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top)] lg:hidden", phoneChat && "max-md:hidden")}>
          {inHomeApp() && (
            <a href={HOME_APP_BACK} className="btn btn-ghost btn-square -mr-1 size-11 text-secondary active:scale-90 transition-transform" aria-label="Back to Nouride Home">
              <ChevronLeft size={22} />
            </a>
          )}
          <Link to="/" className="flex items-center gap-2">
            <Mascot pose="head" decorative className="w-7" />
            <span className="font-display text-base font-medium tracking-tight">Nouride</span>
          </Link>
        </header>

        <ReconnectingBanner offline={gate.offline} />
        <RestartPendingBar />
        <RestartedToast />
        {!gate.offline && health.data && staleBundle(bundleVersion(), health.data.version) && <UpdatedBanner running={health.data.version} />}
        {/* For whoever can change how the server runs: the image's new name is theirs to switch to. */}
        {where.admin && health.data?.imageMovedTo && <ImageMovedBanner to={health.data.imageMovedTo} />}

        {/* A page fades in as it is drawn (`*:animate-fade`): its root is a new element when the page changes, and the
            same one, not moved, while it stays. */}
        {ownsViewport ? (
          /* Above the tab bar on a phone: a chat's composer sits on the page's foot. */
          <main className={cn("flex min-h-0 flex-1 flex-col overflow-hidden *:animate-fade", phoneChat ? PHONE_CHAT_SPACE : TAB_BAR_SPACE)}>
            <SettingsBack pathname={pathname} className="mx-4 mt-2 sm:mx-6 lg:mx-8 lg:mt-4" />
            <Outlet />
          </main>
        ) : fillsViewport ? (
          /* Never sideways: a tooltip waiting unseen at the edge of a phone's screen made the page pan by a few pixels under
             a finger (a mission's turn chips). What is wider than the page is that element's to wrap or scroll. */
          <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            {/* Held to the window from a laptop's width up; on a phone it scrolls as a document, as the page beside it
                does — a list scrolling inside a card inside a scrolling page, under a header, is a sliver there. */}
            <div className={`mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-2 sm:px-6 sm:pt-4 lg:h-full lg:p-8 ${HELD_BOTTOM} *:animate-fade`}>
              <SectionTabs pathname={pathname} />
              <SettingsBack pathname={pathname} />
              <Outlet />
            </div>
          </main>
        ) : (
          <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <div className={`mx-auto w-full max-w-6xl space-y-6 px-4 pt-2 sm:px-6 sm:pt-4 lg:p-8 ${PAGE_BOTTOM} *:animate-fade`}>
              <SectionTabs pathname={pathname} />
              <SettingsBack pathname={pathname} />
              <Outlet />
            </div>
          </main>
        )}
      </div>

      <TabBar pathname={pathname} more={moreOpen} onMore={() => setMoreOpen((open) => !open)} onTab={() => setMoreOpen(false)} phoneChat={phoneChat} />
    </div>
  );
}
