/**
 * The Office drawn (0.8.1): the rooms once per layout, theme and time of day, then each frame the cats — at their
 * furniture, between its back and its front, or walking — with a bubble over a cat at work (`…`), one that waits for a
 * person (`?`), one that cannot work (`!`, red) and one asleep (`z`), and the clock's hands at the time it is. A cat
 * whose status changed walks to its new place along `route.ts`, a step at a time, facing the way it goes. With
 * reduced motion, or a hidden tab, nothing moves: a cat is where it is now, still.
 */

import { BED_FRONT, DESK, FURNITURE_PALETTE, LAPTOP, LEAD_DESK_PALETTE, LEAD_DESK_PLATE, SOFA_FRONT } from "../art/furniture";
import type { Look } from "@/commons/cat/look";
import { catSprite } from "@/commons/cat/sprite";
import type { Pose } from "@/commons/cat/compose";
import { FEET, type OfficeLayout, type Point, type Spot, type Status } from "./layout";
import { along, lengthOf, route, straightened } from "./route";
import { isDaytime, paintRooms, wallOf, type Theme } from "./rooms";
import { mapSprite } from "./sprites";

export interface SceneAgent {
  id: string;
  status: Status;
  unavailable: boolean;
  look: Look;
}

const BUBBLE = (fill: string, glyph: string[]) => [".ooooooo.", ...glyph.map((row) => `o${row.replaceAll(".", fill)}o`), ".oooo.oo.", "....oo..."];
const QUESTION = BUBBLE("W", [".......", "..kkk..", ".k...k.", "....k..", "...k...", ".......", "...k...", "......."]);
const ALERT = BUBBLE("R", [".......", "...W...", "...W...", "...W...", "...W...", ".......", "...W...", "......."]);
/** At work: one, two, three dots, over and over. */
const TYPING = [1, 2, 3].map((dots) => BUBBLE("W", [".......", ".......", ["k.....", "k.k...", "k.k.k."][dots - 1]!.padStart(7, ".").slice(0, 7), ".......", "......."]));
const ZED = ["kkkk", "..k.", ".k..", "kkkk"];
const BUBBLE_PALETTE = { o: "#1e1b24", W: "#ffffff", k: "#1e1b24", R: "#e5484d" };

/** A cat walks this many pixels a millisecond — about a room a second and a half — and changes foot every few pixels. */
const WALK_SPEED = 0.06;
const STRIDE = 5;

interface Walk {
  points: Point[];
  start: number;
  length: number;
  to: Spot;
}

/**
 * What is drawn over a cat. In bed, one that cannot work sleeps like the rest; the alert is for
 * one still at work, or waiting, while it cannot.
 */
export function bubbleFor(agent: Pick<SceneAgent, "status" | "unavailable">, walking: boolean): "alert" | "question" | "typing" | "zed" | null {
  if (agent.unavailable && agent.status !== "asleep") return "alert";
  if (walking) return null;
  if (agent.status === "waiting") return "question";
  if (agent.status === "working") return "typing";
  return agent.status === "asleep" ? "zed" : null;
}

export class OfficeScene {
  private layout: OfficeLayout | null = null;
  private agents: SceneAgent[] = [];
  private readonly walks = new Map<string, Walk>();
  private background: HTMLCanvasElement | null = null;
  private backgroundKey = "";

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /**
   * New statuses and places: a cat whose place changed walks there — from where it is, so one sent somewhere else
   * mid-walk turns round where it stands, along the way it was going. Nothing walks with reduced motion.
   */
  update(layout: OfficeLayout, agents: SceneAgent[], now: number, still: boolean): void {
    // The rooms turned (a page made narrow or wide): every cat is where it is in the new office, not walking there.
    const before = this.layout && this.layout.stacked === layout.stacked ? this.layout : null;
    for (const agent of agents) {
      const to = layout.places.get(agent.id);
      const from = before?.places.get(agent.id);
      if (still || !to || !from) {
        this.walks.delete(agent.id);
        continue;
      }
      const walk = this.walks.get(agent.id);
      const done = !walk || now - walk.start >= walk.length / WALK_SPEED;
      if (done && from.key === to.key) {
        this.walks.delete(agent.id);
        continue;
      }
      if (!done && walk.to.key === to.key) continue;
      let points: Point[];
      if (done) {
        points = route(layout, from, to);
      } else {
        const where = along(walk.points, (now - walk.start) * WALK_SPEED);
        points = straightened([where.at, ...where.ahead, ...route(layout, walk.to, to).slice(1)]);
      }
      this.walks.set(agent.id, { points, start: now, length: lengthOf(points), to });
    }
    this.layout = layout;
    this.agents = agents;
  }

  /** Whether a cat is on its way somewhere. */
  walking(id: string, now: number): boolean {
    const walk = this.walks.get(id);
    return !!walk && now - walk.start < walk.length / WALK_SPEED;
  }

  /** Where a cat's frame is now: its place, or along its way there. */
  positionOf(id: string, now: number): Point | null {
    const spot = this.layout?.places.get(id);
    if (!spot) return null;
    const walk = this.walks.get(id);
    if (!walk || !this.walking(id, now)) return { x: spot.x, y: spot.y };
    return along(walk.points, (now - walk.start) * WALK_SPEED).at;
  }

  draw(now: number, theme: Theme, animate: boolean, hour = new Date().getHours(), minute = new Date().getMinutes()): void {
    const layout = this.layout;
    const context = this.canvas.getContext("2d");
    if (!layout || !context) return;
    if (this.canvas.width !== layout.width || this.canvas.height !== layout.height) {
      this.canvas.width = layout.width;
      this.canvas.height = layout.height;
    }
    context.imageSmoothingEnabled = false;
    context.drawImage(this.backgroundOf(layout, theme, isDaytime(hour)), 0, 0);
    this.clockHands(context, layout, hour, minute);

    // Everything in front of the floor, back to front by where it stands, so a lower thing is drawn over a higher one.
    const items: { y: number; draw: () => void }[] = [];
    for (const desk of layout.desks) {
      items.push({ y: desk.y + 38, draw: () => this.piece(context, "laptop", LAPTOP, desk.x + 12, desk.y + 17) });
      if (desk === layout.lead) {
        // The orchestrator's: the same desk in dark wood, a brass plate on its front.
        items.push({
          y: desk.y + 38,
          draw: () => {
            context.drawImage(mapSprite("lead-desk", DESK, { ...FURNITURE_PALETTE, ...LEAD_DESK_PALETTE }), desk.x, desk.y + 27);
            context.drawImage(mapSprite("lead-plate", LEAD_DESK_PLATE.rows, { ...FURNITURE_PALETTE, ...LEAD_DESK_PALETTE }), desk.x + LEAD_DESK_PLATE.x, desk.y + 27 + LEAD_DESK_PLATE.y);
          },
        });
      } else {
        items.push({ y: desk.y + 38, draw: () => this.piece(context, "desk", DESK, desk.x, desk.y + 27) });
      }
    }
    for (const bed of layout.beds) items.push({ y: bed.y + 21, draw: () => this.piece(context, "bed-front", BED_FRONT, bed.x, bed.y + 10) });
    for (const sofa of layout.sofas) items.push({ y: sofa.y + 15, draw: () => this.piece(context, "sofa-front", SOFA_FRONT, sofa.x, sofa.y + 6) });
    for (const agent of this.agents) {
      const spot = layout.places.get(agent.id);
      if (!spot) continue;
      if (this.walking(agent.id, now)) {
        const walk = this.walks.get(agent.id)!;
        const where = along(walk.points, (now - walk.start) * WALK_SPEED);
        const pose: Pose = Math.floor(((now - walk.start) * WALK_SPEED) / STRIDE) % 2 === 0 ? "stand" : "step";
        items.push({ y: where.at.y + FEET, draw: () => this.walker(context, agent, pose, where.at, where.facing === "left") });
      } else {
        // At a desk or on a sofa, its feet are behind the front; in bed, its head is on the pillow, the blanket over it.
        const depth = spot.furniture === "bed" ? 14 : spot.furniture === "sofa" ? 22 : FEET;
        items.push({ y: spot.y + depth, draw: () => this.seated(context, agent, spot, now, animate) });
      }
    }
    for (const item of items.sort((a, b) => a.y - b.y)) item.draw();
    for (const agent of this.agents) {
      const at = this.positionOf(agent.id, now);
      if (at) this.bubble(context, agent, at, this.walking(agent.id, now), now, animate);
    }
  }

  private piece(context: CanvasRenderingContext2D, name: string, rows: readonly string[], x: number, y: number): void {
    context.drawImage(mapSprite(name, rows, FURNITURE_PALETTE), x, y);
  }

  private walker(context: CanvasRenderingContext2D, agent: SceneAgent, pose: Pose, at: Point, left: boolean): void {
    const sprite = catSprite(agent.look, pose);
    if (!left) {
      context.drawImage(sprite, at.x, at.y);
      return;
    }
    // The sprites face right; a cat going left is the same cat, mirrored.
    context.save();
    context.translate(at.x + 32, at.y);
    context.scale(-1, 1);
    context.drawImage(sprite, 0, 0);
    context.restore();
  }

  private seated(context: CanvasRenderingContext2D, agent: SceneAgent, spot: Spot, now: number, animate: boolean): void {
    const pose: Pose = spot.furniture === "bed" ? "sleep" : agent.status === "waiting" ? "wave" : "sit";
    // A blink now and then, each cat at its own moment; a breath on the sofa.
    const phase = [...agent.id].reduce((sum, c) => sum + c.charCodeAt(0), 0) * 97;
    const blink = animate && (now + phase) % 4_200 < 140;
    const breath = animate && spot.furniture === "sofa" && Math.floor((now + phase) / 900) % 2 === 0 ? 1 : 0;
    context.drawImage(catSprite(agent.look, pose, blink), spot.x, spot.y + breath);
  }

  private bubble(context: CanvasRenderingContext2D, agent: SceneAgent, at: Point, walking: boolean, now: number, animate: boolean): void {
    const bob = animate && Math.floor(now / 500) % 2 === 0 ? 1 : 0;
    const shown = bubbleFor(agent, walking);
    if (shown === "alert") {
      context.drawImage(mapSprite("alert", ALERT, BUBBLE_PALETTE), at.x + 20, at.y - 9 + bob);
    } else if (shown === "question") {
      context.drawImage(mapSprite("question", QUESTION, BUBBLE_PALETTE), at.x + 20, at.y - 9 + bob);
    } else if (shown === "typing") {
      const dots = animate ? Math.floor(now / 400) % 3 : 2;
      context.drawImage(mapSprite(`typing-${dots}`, TYPING[dots]!, BUBBLE_PALETTE), at.x + 20, at.y - 5);
    } else if (shown === "zed") {
      const drift = animate ? Math.floor(now / 400) % 6 : 0;
      context.drawImage(mapSprite("zed", ZED, { k: "#79b6ff" }), at.x + 24, at.y + 2 - drift);
    }
  }

  /** The lobby clock's hands, at the time it is where the page is looked at. */
  private clockHands(context: CanvasRenderingContext2D, layout: OfficeLayout, hour: number, minute: number): void {
    const { clock } = wallOf(layout);
    const centre = { x: clock.x + 4, y: clock.y + 4 };
    const hand = (turns: number, length: number) => {
      const angle = turns * 2 * Math.PI - Math.PI / 2;
      for (let step = 1; step <= length; step += 1) context.fillRect(Math.round(centre.x + Math.cos(angle) * step), Math.round(centre.y + Math.sin(angle) * step), 1, 1);
    };
    context.fillStyle = "#1e1b24";
    context.fillRect(centre.x, centre.y, 1, 1);
    hand(((hour % 12) + minute / 60) / 12, 2);
    context.fillStyle = "#e5484d";
    hand(minute / 60, 3);
  }

  private backgroundOf(layout: OfficeLayout, theme: Theme, daytime: boolean): HTMLCanvasElement {
    const key = `${theme}:${daytime}:${layout.width}x${layout.height}:${layout.lead ? "lead" : ""}:${layout.away}`;
    if (this.background && this.backgroundKey === key) return this.background;
    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext("2d");
    if (context) paintRooms(context, layout, theme, daytime);
    this.background = canvas;
    this.backgroundKey = key;
    return canvas;
  }
}
