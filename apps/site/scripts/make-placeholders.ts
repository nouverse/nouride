#!/usr/bin/env bun
/**
 * Generate the labelled placeholders the docs reference until real screenshots exist.
 *
 * A page that links a screenshot nobody has taken yet either ships a broken image or ships without
 * the slot, and the second is worse — the slot is the specification. Each file below says, on the
 * image itself, what belongs there and at what size, so replacing one is a matter of dropping a PNG
 * or MP4 over it and deleting the `.svg`.
 *
 *     bun run apps/site/scripts/make-placeholders.ts
 *
 * Committed output, run by hand. Replaced files are not regenerated: the script skips any slot that
 * already has a non-placeholder sibling (`.png`, `.jpg`, `.webp`, `.mp4`).
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MEDIA = join(dirname(new URL(import.meta.url).pathname), "../public/media");

/** One entry per slot the documentation points at. Keep the list and the pages in step. */
const SLOTS: { name: string; label: string; hint: string; w: number; h: number }[] = [
  { name: "dashboard-overview", label: "Dashboard — Overview", hint: "health, today's spend, the stats and the Office, small", w: 1600, h: 900 },
  { name: "dashboard-office", label: "Dashboard — Office", hint: "every status at once: working, waiting, idle, asleep, cannot work", w: 1600, h: 1000 },
  { name: "dashboard-chat", label: "Dashboard — Chat", hint: "a turn with its live tool steps expanded", w: 1600, h: 900 },
  { name: "dashboard-agents", label: "Dashboard — Agents", hint: "the agent list, with the pairing switch above it", w: 1600, h: 900 },
  { name: "dashboard-agent-files", label: "Agent — Files", hint: "IDENTITY.md / SOUL.md with the markdown preview", w: 1600, h: 900 },
  { name: "dashboard-agent-model", label: "Agent — Model", hint: "provider profile and model for one agent", w: 1600, h: 900 },
  { name: "dashboard-agent-connections", label: "Agent — Connections", hint: "the bots and numbers this agent answers on", w: 1600, h: 900 },
  { name: "dashboard-skills", label: "Skills Workshop", hint: "the pool, drafts pinned above it, per-agent badges", w: 1600, h: 900 },
  { name: "dashboard-schedule", label: "Schedule", hint: "cron jobs, next run, active / paused / failing", w: 1600, h: 900 },
  { name: "dashboard-approvals", label: "Approval card", hint: "one blocked tool call, allow once / always / deny", w: 1200, h: 700 },
  { name: "dashboard-update", label: "Update", hint: "running version, newest for this edition, download then install", w: 1600, h: 900 },
  { name: "dashboard-update-container", label: "Update — a container", hint: "the refusal, with the pull command it hands back", w: 1600, h: 900 },
  { name: "pairing-chat", label: "Pairing — the sender's side", hint: "the code, and where to approve it", w: 1000, h: 1000 },
  { name: "dashboard-access-pending", label: "Access — Pending", hint: "waiting requests, their codes, approve / deny / block, the count in the sidebar", w: 1600, h: 900 },
  { name: "dashboard-access-denied", label: "Access — Denied", hint: "denials counting down to when they may ask again, with Reset and Block", w: 1600, h: 1000 },
  { name: "setup-password", label: "First-run password", hint: "the log line the daemon prints once", w: 1200, h: 500 },
  { name: "setup-wizard-provider", label: "Wizard — model endpoint", hint: "wire format, base URL, key, tested before saving", w: 1200, h: 800 },
  { name: "setup-wizard-agent", label: "Wizard — first agent", hint: "id, display name, one-line persona", w: 1200, h: 800 },
  { name: "setup-wizard-memory", label: "Wizard — memory", hint: "the three switches and the nightly hour", w: 1200, h: 800 },
  { name: "gateway-telegram", label: "Telegram", hint: "an agent answering in a Telegram chat", w: 900, h: 1200 },
  { name: "gateway-whatsapp-qr", label: "WhatsApp — link a device", hint: "the QR the dashboard shows for pairing", w: 1000, h: 800 },
  { name: "gateway-restart", label: "Connections — restart needed", hint: "a saved connection, not started, and the Restart Runtime banner", w: 1600, h: 1000 },
  { name: "dashboard-agents-settings", label: "Agents — Settings", hint: "accept new senders, group context", w: 1600, h: 600 },
  { name: "dashboard-agent-access", label: "Agent — Access", hint: "accept new senders, its senders at a glance", w: 1600, h: 1000 },
  { name: "dashboard-agent-approvals", label: "Agent — Access, Approvals", hint: "the approval level on an agent's Access tab", w: 1600, h: 1000 },
  { name: "dashboard-people", label: "People", hint: "one entry per person and the ids they are reachable at", w: 1600, h: 1000 },
  { name: "dashboard-webhooks", label: "Webhooks", hint: "one hook: URL, how to call it, what it runs, where the reply goes", w: 1600, h: 1000 },
  { name: "dashboard-models", label: "Models", hint: "provider profiles, credential names, used by", w: 1600, h: 1000 },
  { name: "dashboard-integrations", label: "Integrations", hint: "the MCP server address and its tokens", w: 1600, h: 1000 },
  { name: "skills-learning", label: "Skills — Self-Improving Skill", hint: "the panel open: the mode, the model, the weekly review", w: 1600, h: 1000 },
  { name: "cli-chat", label: "nouride chat", hint: "terminal session, a turn with its tool steps", w: 1400, h: 800 },
  { name: "memory-page", label: "Memory", hint: "the tabs, one agent's notes open", w: 1600, h: 1000 },
  { name: "memory-graph", label: "Memory — graph", hint: "conversations, people, tags and agents, legend and filters", w: 1600, h: 1000 },
  { name: "memory-graph-tag", label: "Memory — a tag selected", hint: "the side panel: its conversations, Only this, Merge into…", w: 1600, h: 1000 },
  { name: "demo-poster", label: "Demo video — poster frame", hint: "drop demo.mp4 beside this file", w: 1600, h: 900 },
];

/** A slot is done when a real asset with the same stem exists. */
const REAL = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm"];

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const svg = ({ label, hint, w, h }: (typeof SLOTS)[number]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escape(label)} — placeholder">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b111e"/>
      <stop offset="100%" stop-color="#111b2e"/>
    </linearGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="rgba(0,210,255,.07)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect width="${w}" height="${h}" fill="url(#grid)"/>
  <rect x="8" y="8" width="${w - 16}" height="${h - 16}" fill="none" stroke="rgba(0,210,255,.35)" stroke-width="2" stroke-dasharray="12 10" rx="14"/>
  <text x="50%" y="${h / 2 - 26}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${Math.round(w / 28)}" fill="#7ee8fa">${escape(label)}</text>
  <text x="50%" y="${h / 2 + 22}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${Math.round(w / 52)}" fill="#94a3b8">${escape(hint)}</text>
  <text x="50%" y="${h - 34}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${Math.round(w / 64)}" fill="#475569">placeholder · ${w}×${h} · replace this file</text>
</svg>
`;

await mkdir(MEDIA, { recursive: true });
const existing = new Set(await readdir(MEDIA).catch(() => []));

let written = 0;
let skipped = 0;
for (const slot of SLOTS) {
  if (REAL.some((ext) => existing.has(`${slot.name}${ext}`))) {
    skipped += 1;
    continue;
  }
  await writeFile(join(MEDIA, `${slot.name}.svg`), svg(slot));
  written += 1;
}

console.log(`✓ ${written} placeholder(s) written to public/media${skipped ? `, ${skipped} slot(s) already have a real asset` : ""}`);
