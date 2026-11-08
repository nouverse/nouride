/**
 * Nouride Office (0.8.1): the agents' statuses as a small office — working at a desk, waiting for you with
 * a hand up, idle on the sofa, asleep in bed — each agent a cat in its own look. For watching, not for settings.
 *
 * Costs the daemon nothing: it reads `/status` every few seconds while the page is open and the tab is seen, draws
 * nothing while it is hidden, and moves nothing for reduced motion. The cats are drawn on a canvas; over each is a
 * button, with its name and status in words, so a status never depends on colour and every cat can be reached from a
 * keyboard.
 */

import { useQuery } from "@tanstack/react-query";
import { Crown } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@/commons/lib/api";
import { ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { looksOf } from "@/commons/cat/look";
import { layoutOffice, scaleFor, STACK_BELOW, type Status } from "@/commons/office/lib/layout";
import { OfficeScene } from "@/commons/office/lib/scene";
import { roster } from "@/commons/office/lib/roster";
import { statusOf } from "@/commons/office/lib/status";
import { AgentCard } from "./components/AgentCard";
import { useOfficeTheme, useReducedMotion, useVisible } from "@/commons/office/lib/hooks";

/** How often the page reads the statuses while it is seen: a few hundred bytes. */
const POLL_MS = 5_000;
/** A dozen frames a second is pixel art's pace, and a small box's browser's. */
const FRAME_MS = 80;


const WORDS: Record<Status, string> = { working: "working", waiting: "waiting for you", idle: "idle", asleep: "asleep" };

export default function OfficePage() {
  const visible = useVisible();
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: visible ? POLL_MS : false });
  const everyone = useMemo(() => status.data?.agents ?? [], [status.data]);
  const orchestrator = status.data?.orchestrator ?? null;
  // At most `IN_OFFICE` here, the orchestrator always among them; the rest counted, in another office.
  const { here: agents, away } = useMemo(() => roster(everyone, orchestrator), [everyone, orchestrator]);
  const theme = useOfficeTheme();
  const still = useReducedMotion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const homes = useRef<Map<string, number>>(new Map());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const box = useRef<HTMLDivElement>(null);
  // The page column's width: the rooms side by side where it holds them, one above another on a phone.
  const [boxWidth, setBoxWidth] = useState(1_088);
  const stacked = boxWidth < STACK_BELOW;
  const [selected, setSelected] = useState<string | null>(null);

  // From every agent, not only those here: an agent's look must not change with who else is in this office, nor
  // differ from its Look tab, which reads them all.
  const looks = useMemo(() => looksOf(everyone), [everyone]);
  const layout = useMemo(
    () => layoutOffice(agents.map((agent) => ({ id: agent.id, status: statusOf(agent), lead: agent.id === orchestrator })), homes.current, away.length, stacked),
    [agents, orchestrator, away.length, stacked],
  );
  const scale = scaleFor(boxWidth, layout.width, stacked);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  /** Each cat's button where its cat is now — walking with it, so a name never arrives before its cat. */
  const placeButtons = (now: number) => {
    for (const [id, button] of buttons.current) {
      const at = scene.current?.positionOf(id, now);
      if (!at) continue;
      button.style.left = `${(at.x + 4) * scaleRef.current}px`;
      button.style.top = `${at.y * scaleRef.current}px`;
    }
  };

  // As large as the page's width holds (`scaleFor`), and laid out for it.
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setBoxWidth(entry?.contentRect.width ?? 1_088));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Before the page is painted, so a new button is never seen where it is not.
  useLayoutEffect(() => {
    if (!canvas.current) return;
    scene.current ??= new OfficeScene(canvas.current);
    const now = performance.now();
    scene.current.update(
      layout,
      agents.map((agent) => ({ id: agent.id, status: statusOf(agent), unavailable: !!agent.activity?.unavailable, look: looks.get(agent.id)! })),
      now,
      still,
    );
    homes.current = layout.homes;
    scene.current.draw(now, theme, !still && visible);
    placeButtons(now);
  }, [layout, agents, looks, theme, still, visible, scale]);

  // Frames while the tab is seen — a dozen a second, a few dozen small images each — and none while it is hidden. With
  // reduced motion, only the drawing above, once per change.
  useEffect(() => {
    if (still || !visible) return;
    let handle = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= FRAME_MS) {
        scene.current?.draw(now, theme, true);
        placeButtons(now);
        last = now;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [still, visible, theme]);

  const chosen = agents.find((agent) => agent.id === selected) ?? null;
  // Who in the other office is waiting for you: a status nobody can see there must still be said.
  const awayWaiting = away.filter((agent) => statusOf(agent) === "waiting").length;

  // What the bubbles over the cats mean, said once under the office, in the order a person would look for them.
  const legend: [symbol: string, words: string][] = [["…", "working"], ["?", "waiting for you"], ["", "idle, on the sofa"], ["z", "asleep, or cannot work"]];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Office"
        description="Your agents at work: at a desk when working, a hand up when waiting for you, on the sofa when idle, in bed when asleep or when it cannot work."
        actions={
          status.data ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5" data-office-count>
              <span className="badge badge-sm badge-ghost font-mono">
                {everyone.length} {everyone.length === 1 ? "agent" : "agents"}
              </span>
              {away.length > 0 ? (
                <>
                  <span className="badge badge-sm badge-ghost font-mono">{agents.length} here</span>
                  <span className="badge badge-sm badge-ghost font-mono">{away.length} in another office</span>
                  {awayWaiting > 0 ? <span className="badge badge-sm badge-warning font-mono">{awayWaiting} of them waiting for you</span> : null}
                </>
              ) : null}
            </div>
          ) : null
        }
      />
      {status.error && !status.data ? <ErrorNote error={status.error} /> : null}
      {/* The office as wide as the page's column holds it, from the same left edge as the heading over it. */}
      <div ref={box} className="min-w-0">
        <div className="relative" style={{ width: layout.width * scale, height: layout.height * scale }}>
          <canvas
            ref={canvas}
            width={layout.width}
            height={layout.height}
            className="block rounded-2xl border border-base-content/10"
            style={{ width: layout.width * scale, height: layout.height * scale, imageRendering: "pixelated" }}
            aria-hidden="true"
          />
          {agents.map((agent) => {
            const spot = layout.places.get(agent.id);
            if (!spot) return null;
            const label = `${agent.displayName}, ${WORDS[statusOf(agent)]}${agent.activity?.unavailable ? `, cannot work: ${agent.activity.unavailable}` : ""}`;
            return (
              <button
                key={agent.id}
                ref={(element) => {
                  if (element) buttons.current.set(agent.id, element);
                  else buttons.current.delete(agent.id);
                }}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={selected === agent.id}
                onClick={() => setSelected(selected === agent.id ? null : agent.id)}
                className="absolute flex flex-col items-center justify-end rounded-lg focus-visible:outline-2 focus-visible:outline-primary"
                // Where it is, `placeButtons` says — here and every frame — so React never puts it back where its cat was.
                style={{ width: 24 * scale, height: 32 * scale }}
              >
                {/*
                  No wider than the room its place leaves: a seat on a sofa is a cat's width from the next, a desk or a
                  bed nearly twice that — so two names side by side never run over each other, and a long one ends in …
                */}
                <span
                  // Smaller on a phone's office, so a short name still fits a seat's width there.
                  className={`pointer-events-none translate-y-full truncate rounded bg-base-100/90 py-0.5 font-mono leading-none text-base-content shadow-xs ${scale < 2 ? "px-0.5 text-[9px]" : "px-1 text-[10px]"}`}
                  style={{ maxWidth: (spot.furniture === "sofa" ? 24 : 44) * scale }}
                  data-name
                >
                  {/* The same crown the other pages give the orchestrator. */}
                  {agent.id === orchestrator ? <Crown size={scale < 2 ? 8 : 9} className="mr-0.5 inline-block align-[-1px]" aria-label="orchestrator" /> : null}
                  {agent.displayName}
                </span>
              </button>
            );
          })}
        </div>
        {agents.length === 0 && status.data ? <p className="text-base-content/70 mt-4 text-sm">No agents yet: the office is empty.</p> : null}
      </div>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-2">
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-base-content/70" aria-label="What the office shows">
            {legend.map(([symbol, words]) => (
              <li key={words} className="flex items-center gap-1.5">
                {symbol ? <span className="badge badge-xs badge-ghost font-mono">{symbol}</span> : null}
                {words}
              </li>
            ))}
          </ul>
          <p className="text-base-content/65 text-sm">Pick a cat to see what it is doing, put it to sleep or wake it, open its chat, or change its look.</p>
        </div>
        <aside className="min-w-0">{chosen ? <AgentCard agent={chosen} status={statusOf(chosen)} onClose={() => setSelected(null)} /> : null}</aside>
      </div>
    </div>
  );
}
