/**
 * What System's Overview says in words, beside each bar: a figure is read by a person who runs a box, not by someone
 * who knows what a cgroup is. A figure the machine does not give is said as not known, never drawn as an empty bar.
 */

import type { SystemFileWeight, SystemOverview } from "@nouride/wire";
import { formatBytes } from "@/commons/lib/format";

/** How full something is, as the bar's colour and its words say it: from three quarters it is worth a look. */
export type Fullness = "fine" | "high" | "full";

/** The part in use, 0 to 1, or null where either figure is missing. */
export function shareOf(used: number | null, total: number | null): number | null {
  return used === null || total === null || total <= 0 ? null : Math.min(1, Math.max(0, used / total));
}

export function fullnessOf(share: number): Fullness {
  return share >= 0.9 ? "full" : share >= 0.75 ? "high" : "fine";
}

/** `2.1 GB of 5.9 GB in use`, or what is known when part of it is not. */
export function inUseWords(used: number | null, total: number | null): string {
  if (used !== null && total !== null) return `${formatBytes(used)} of ${formatBytes(total)} in use`;
  if (total !== null) return `${formatBytes(total)} in all. How much of it is in use is not something Nouride can tell here.`;
  return "Nouride cannot tell how much RAM there is here.";
}

/** Where the ceiling comes from: the machine itself, or a limit set for Nouride below it (a container's, a service's). */
export function ceilingWords(memory: SystemOverview["memory"]): string | null {
  if (memory.totalBytes === null) return null;
  if (!memory.limited) return "That is this machine's own RAM.";
  return memory.machineBytes !== null && memory.machineBytes > memory.totalBytes
    ? `The ceiling is a limit set for Nouride here. The machine it runs on has ${formatBytes(memory.machineBytes)}.`
    : "The ceiling is a limit set for Nouride here.";
}

/** What the agents' commands hold, or why there is no figure of their own. */
export function commandsWords(commands: SystemOverview["memory"]["commands"]): string {
  if (!commands) return "Counted together with Nouride here.";
  return commands.maxBytes === null ? formatBytes(commands.usedBytes) : `${formatBytes(commands.usedBytes)}, and may hold up to ${formatBytes(commands.maxBytes)}`;
}

/** `3 days`, `5 h`, `12 min`: how long the daemon has been up. */
export function upFor(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  const days = Math.round(seconds / 86_400);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * What the question before a delete says it would take: a file's size, a folder's files and what they take on disk.
 * A count that stopped at its ceiling is "more than", and a size that could not be measured is left unsaid. A link
 * is listed as the folder or file it leads to, so its question says that only the link goes.
 */
export function deleteWords(weight: SystemFileWeight): string {
  if (weight.link) return "It is a link: the link will be gone from this machine, and what it leads to stays.";
  if (weight.entry.kind === "file") return weight.bytes === null ? "It will be gone from this machine." : `It is ${formatBytes(weight.bytes)}, and will be gone from this machine.`;
  if (weight.files === 0 && !weight.more) return "The folder is empty, and will be gone from this machine.";
  const files = `${weight.more ? "more than " : ""}${weight.files.toLocaleString("en")} ${weight.files === 1 && !weight.more ? "file" : "files"}`;
  return `The folder and everything in it will be gone from this machine: ${files}${weight.bytes === null ? "" : `, ${formatBytes(weight.bytes)}`}.`;
}
