/**
 * What the Automations page's mount tests share: an automation of four steps as the daemon answers one, two agents to
 * hand a step to, and the page's own controls found the way a person finds them (a step's card, its menu, the "+"
 * between two cards, the bar that saves).
 */

import type { AutomationStep, AutomationSummary, JobRunSummary } from "@nouride/wire";
import { WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

export const ok = (body: unknown) => ({ status: 200, body });

export const STEPS: AutomationStep[] = [
  { id: "check", kind: "command", argv: ["sh", "-lc", "curl -sf https://shop.example.com/health"] },
  { id: "find", kind: "agentTurn", message: "Find out why the shop is down." },
  { id: "ok", kind: "approval", ask: "Send it to the group?" },
  { id: "tell", kind: "systemEvent", name: "Tell the group", text: "The shop was down." },
];

export function automation(over: Partial<AutomationSummary> = {}): AutomationSummary {
  return {
    id: "cron_e", agentId: "nouva", name: "Shop check", enabled: true, trigger: { kind: "cron", expr: "0 7 * * *" }, payload: { kind: "steps", steps: STEPS }, delivery: { mode: "announce" },
    target: { gatewayId: "telegram:nouva", chatId: "-100200" }, session: "fresh", createdBy: "tester", createdAt: 0, runCount: 0, failCount: 0, failStreak: 0, describes: "cron `0 7 * * *` (UTC)", start: "scheduled",
    ...over,
  };
}

export const detail = (one: AutomationSummary, runs: JobRunSummary[] = [], suggested?: AutomationSummary) => ok({ automation: one, runs, ...(suggested ? { suggested } : {}), timezone: "UTC" });

const status = WIRE["/status"] as { agents: Record<string, unknown>[] };
/** Two agents, the first the orchestrator: a step can be another agent's only where there is another. */
export const TWO_AGENTS = { "/status": ok({ ...status, orchestrator: "nouva", agents: [status.agents[0]!, { ...status.agents[0]!, id: "nix", displayName: "Nix" }] }) };

const me = WIRE["/auth/me"] as { user: Record<string, unknown> };
export const AS_VIEWER = { "/auth/me": ok({ ...me, role: "viewer", user: { ...me.user, role: "viewer" } }) };

/** The steps drawn, in order, by their ids. */
export const drawn = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-flow-anchor^="step:"]')].map((card) => card.dataset.flowAnchor!.slice(5));
export const stepCard = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-flow-anchor="step:${id}"]`)!;
export const labelled = (host: HTMLElement, label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
export const flowDrawn = (host: HTMLElement, steps = 4) => eventually(() => drawn(host).length === steps, 3_000, "the steps");

/** A press on one item of the menu a step's "⋯" opens: Move up, Move down, Duplicate, Delete. */
export async function stepMenu(host: HTMLElement, step: number, item: string): Promise<void> {
  labelled(host, `More for step ${step}`).click();
  const items = () => [...host.ownerDocument.body.querySelectorAll<HTMLElement>('[role="menu"] button')];
  await eventually(() => items().some((button) => button.textContent?.trim() === item), 2_000, `the menu's ${item}`);
  items().find((button) => button.textContent?.trim() === item)!.click();
}

/** A step added through a "+": the picker opened under it, and a kind picked by what the picker calls it. */
export async function addStep(host: HTMLElement, plus: string, kind: string): Promise<void> {
  labelled(host, plus).click();
  const kinds = () => [...host.ownerDocument.body.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Add a step"] button')];
  await eventually(() => kinds().length > 0, 2_000, "the picker");
  kinds().find((button) => button.querySelector("span span")?.textContent === kind)!.click();
}

/** The bar that saves, and its buttons. */
export const saveBar = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="region"][aria-label="Unsaved changes"]');
export const barButton = (host: HTMLElement, label: string) => [...(saveBar(host)?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;

/** A field of the open step's editor, by its label. */
export function field(host: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = [...host.querySelectorAll("label")].find((one) => one.querySelector(":scope > span")?.textContent === label);
  return found!.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement;
}
