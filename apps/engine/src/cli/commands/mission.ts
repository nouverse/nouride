import { clip, plural } from "@nouride/shared";
import type { MissionDeletedResponse, MissionDetailResponse, MissionListResponse, MissionResponse } from "@/cli/wire.ts";
import { BOLD, DIM, GREEN, RED, RESET, say, usageError, YELLOW, emit } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { hasFlag } from "@/cli/args.ts";
import { knownAction } from "@/cli/usage.ts";
import { hoursLimit, turnsSaid } from "@/modules/missions/page.ts";

/**
 * `nouride mission` — long work an agent finishes alone (0.8.0): what runs and what needs you, one mission in full, and
 * what a person says to one — stop it, let it go on, answer it, accept it, tell it something while it works (0.8.10) —
 * and an ended one deleted (0.8.13).
 * Starting one is a chat's or the dashboard's: a mission reports to a chat, and a terminal is not one.
 */
export async function mission(client: Client, args: string[]): Promise<void> {
  const [action, id, ...rest] = args;
  knownAction("mission", action, ["list", "show", "stop", "continue", "accept", "answer", "tell", "delete"]);

  if (action === "show") {
    if (!id) usageError("usage: nouride mission show <id>");
    const detail = await client.get<MissionDetailResponse>(`/missions/${encodeURIComponent(id)}`);
    emit(detail);
    const m = detail.mission;
    say(`${BOLD}${m.id}${RESET} · ${m.agentId} · ${statusOf(m)}`);
    say(`  Goal: ${m.goal}`);
    if (m.checks.length > 0) say(`  Checks: ${m.checks.join("; ")}`);
    say(`  ${DIM}${turnsSaid(m)} · ${hours(m.workedMs)} of ${hoursLimit(m.limits.hours)} · ${millions(m.tokensUsed)} of ${millions(m.limits.tokens)} tokens${RESET}`);
    // Minutes a pass: "checking" alone read as stuck (0.8.10).
    if (detail.reviewing) say(`  ${YELLOW}●${RESET} ${reviewingLine(detail.reviewing, Date.now())}`);
    if (detail.plan) {
      say();
      for (const [index, step] of detail.plan.steps.entries()) {
        const mark = step.state === "done" ? `${GREEN}✓${RESET}` : step.state === "active" ? `${YELLOW}●${RESET}` : step.state === "skipped" ? `${DIM}–${RESET}` : `${DIM}○${RESET}`;
        say(`  ${mark} ${index + 1}. ${step.text}${step.note ? ` ${DIM}(${step.note})${RESET}` : ""}`);
      }
    }
    if (detail.parked.length > 0) say(`\n  Parked approvals: ${detail.parked.map((request) => request.id).join(", ")} (nouride approvals)`);
    if (m.reason) say(`\n  ${m.status === "waiting" ? "Waiting for" : "Why"}: ${m.reason}`);
    if (m.report) say(`\n  Report: ${m.report}`);
    if (m.files.length > 0) say(`  Files: ${m.files.join(", ")}`);
    // None from a daemon before 0.8.10: this binary's CLI talks to the old one until it restarts.
    const told = m.told ?? [];
    if (told.length > 0) {
      say(`\n  Told while it worked: ${told.length}`);
      for (const one of told.slice(-5)) say(`  ${one.read === undefined ? `${YELLOW}not read yet${RESET}` : `${DIM}read in turn ${one.read}${RESET}`} · ${one.via ? `${one.by} via ${one.via}` : one.by}: ${one.text}`);
    }
    return say(`\n  ${DIM}Folder: ${m.workdir}${RESET}`);
  }

  // An ended mission gone (0.8.13): refused while it is open, or over work nobody committed in its folder without --force.
  if (action === "delete") {
    if (!id) usageError("usage: nouride mission delete <id> [--force]");
    const force = hasFlag(args, "--force");
    const deleted = await client.del<MissionDeletedResponse>(`/missions/${encodeURIComponent(id)}${force ? "?force=1" : ""}`);
    emit(deleted);
    return say(`${GREEN}✓${RESET} ${deleted.mission} deleted: its conversation (${deleted.turns} turn ${plural(deleted.turns, "record")}), checklist and own folder`);
  }

  // Words for it while it works (0.8.10): said back with where they went.
  if (action === "tell") {
    const words = rest.join(" ").trim();
    if (!id || !words) usageError("usage: nouride mission tell <id> <words>");
    const { mission: m, said } = await client.post<MissionResponse>(`/missions/${encodeURIComponent(id)}/tell`, { text: words });
    return say(`${GREEN}✓${RESET} ${m.id} · ${statusOf(m)}: ${said ?? "told"}`);
  }

  if (action === "stop" || action === "continue" || action === "accept" || action === "answer") {
    if (!id) usageError(`usage: nouride mission ${action} <id>${action === "answer" ? " <answer>" : ""}`);
    if (action === "accept" && hasFlag(rest, "--outside")) {
      // Done outside its checks (0.8.7): the work landed another way; the note says where. Its checks are not run.
      const note = rest.filter((word) => word !== "--outside").join(" ").trim();
      if (!note) usageError('usage: nouride mission accept <id> --outside "<where it was done>"');
      const { mission: m } = await client.post<MissionResponse>(`/missions/${encodeURIComponent(id)}/accept`, { outside: note });
      return say(`${GREEN}✓${RESET} ${m.id} · ${statusOf(m)}: done outside its checks`);
    }
    const text = rest.join(" ").trim();
    if (action === "answer" && !text) usageError("usage: nouride mission answer <id> <answer>");
    const { mission: m } = await client.post<MissionResponse>(`/missions/${encodeURIComponent(id)}/${action}`, text ? { text } : {});
    return say(`${GREEN}✓${RESET} ${m.id} · ${statusOf(m)}`);
  }

  const all = hasFlag(args, "--all");
  const { missions } = await client.get<MissionListResponse>(all ? "/missions?limit=500&all=1" : "/missions");
  if (missions.length === 0) return say(`${DIM}no missions yet: an agent starts one when work needs it, or /mission <goal> in a chat${RESET}`);
  const open = missions.filter((m) => m.seen === "needs_you" || m.seen === "working");
  const ended = missions.filter((m) => m.seen === "done" || m.seen === "ended");
  const shown = all ? ended : ended.slice(0, RECENT_ENDED);
  if (open.length === 0) say(`${DIM}nothing running${RESET}`);
  for (const m of [...open, ...shown]) {
    const mark = m.seen === "needs_you" ? `${YELLOW}✋${RESET}` : m.seen === "working" ? `${YELLOW}●${RESET}` : m.seen === "done" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    say(`${mark} ${BOLD}${clip(m.goal, 90)}${RESET}`);
    say(`    ${DIM}${m.id} · ${m.agentId} · ${statusOf(m)} · turn ${m.turnsUsed}/${m.limits.turns}${RESET}`);
  }
  const hidden = ended.length - shown.length;
  say();
  if (hidden > 0) say(`${DIM}${hidden} older not shown · nouride mission --all${RESET}`);
  say(`${DIM}nouride mission show <id> · stop|continue|accept <id> · answer <id> <answer> · tell <id> <words> · delete <id>${RESET}`);
}

const RECENT_ENDED = 5;

/** The reviewer at work, in a line: which pass, and how long it has looked. */
function reviewingLine(reviewing: { pass: number; of: number; since: number }, now: number): string {
  const minutes = Math.max(0, Math.round((now - reviewing.since) / 60_000));
  return `The reviewer is looking: pass ${reviewing.pass} of ${reviewing.of}, ${minutes}m so far`;
}

function statusOf(m: { status: string; waitKind: string | null }): string {
  return m.status === "waiting" ? `needs you (${m.waitKind ?? "?"})` : m.status;
}

function hours(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

function millions(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}
