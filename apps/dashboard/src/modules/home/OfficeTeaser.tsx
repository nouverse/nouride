/**
 * The Office, small, on the Overview (the owner, 2026-11-03): where the Agents and Gateways lists were. Who is working,
 * waiting for you, idle or asleep, at a glance, and the whole office a click away. Drawn still, once per status: the
 * Office page is where the cats walk.
 */

import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Bot } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, useEffect } from "react";
import type { AgentSummary } from "@/commons/lib/api";
import { Card, EmptyState } from "@/commons/components/ui/ui";
import { looksOf } from "@/commons/cat/look";
import { layoutOffice, scaleFor, type Status } from "@/commons/office/lib/layout";
import { OfficeScene } from "@/commons/office/lib/scene";
import { roster } from "@/commons/office/lib/roster";
import { statusOf } from "@/commons/office/lib/status";
import { useOfficeTheme } from "@/commons/office/lib/hooks";

const ORDER: [Status, string][] = [
  ["working", "working"],
  ["waiting", "waiting for you"],
  ["idle", "idle"],
  ["asleep", "asleep"],
];

/** "2 working · 1 waiting for you · 3 idle": each status that someone is in, in the legend's order. */
export function officeCounts(statuses: readonly Status[]): string {
  return ORDER.map(([status, words]) => [statuses.filter((s) => s === status).length, words] as const)
    .filter(([count]) => count > 0)
    .map(([count, words]) => `${count} ${words}`)
    .join(" · ");
}

export function OfficeTeaser({ agents: everyone, orchestrator }: { agents: AgentSummary[]; orchestrator: string | null }) {
  const { here: agents } = useMemo(() => roster(everyone, orchestrator), [everyone, orchestrator]);
  const looks = useMemo(() => looksOf(everyone), [everyone]);
  const theme = useOfficeTheme();
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const homes = useRef<Map<string, number>>(new Map());
  // The box only exists once there are agents, which is after the first render while the status loads: a ref read once
  // at mount found nothing, never measured, and drew the office at its 1 000 px guess, twice a phone's width, over the
  // cards below it. Kept in state, so it is measured whenever it appears; 0 until then draws nothing too big.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const layout = useMemo(
    () => layoutOffice(agents.map((agent) => ({ id: agent.id, status: statusOf(agent), lead: agent.id === orchestrator })), homes.current, 0, false),
    [agents, orchestrator],
  );
  const scale = Math.min(scaleFor(boxWidth, layout.width), 2);

  useEffect(() => {
    if (!box) return;
    setBoxWidth(box.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setBoxWidth(entry?.contentRect.width ?? box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  useLayoutEffect(() => {
    if (!canvas.current) return;
    scene.current ??= new OfficeScene(canvas.current);
    const now = performance.now();
    // Still: a cat is simply in its new place, as with reduced motion.
    scene.current.update(
      layout,
      agents.map((agent) => ({ id: agent.id, status: statusOf(agent), unavailable: !!agent.activity?.unavailable, look: looks.get(agent.id)! })),
      now,
      true,
    );
    homes.current = layout.homes;
    scene.current.draw(now, theme, false);
  }, [layout, agents, looks, theme]);

  const counts = officeCounts(everyone.map(statusOf));
  return (
    <Card
      title="Office"
      description={counts || "Your agents at work."}
      actions={
        <Link to="/office" className="btn btn-ghost btn-xs gap-1 font-medium text-primary hover:bg-primary/10 rounded-lg">
          Open <ArrowUpRight size={13} />
        </Link>
      }
    >
      {everyone.length === 0 ? (
        <EmptyState icon={Bot} title="No agents yet" />
      ) : (
        <div ref={setBox} className="min-w-0">
          <Link to="/office" aria-label={`Open the Office: ${counts}`} className="block w-fit">
            <canvas
              ref={canvas}
              width={layout.width}
              height={layout.height}
              className="block rounded-2xl border border-base-content/10"
              style={{ width: layout.width * scale, height: layout.height * scale, imageRendering: "pixelated" }}
              aria-hidden="true"
              data-office-teaser
            />
          </Link>
        </div>
      )}
    </Card>
  );
}
