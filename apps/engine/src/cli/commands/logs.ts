import type { LogsResponse } from "@/cli/wire.ts";
import { flagValue, hasFlag } from "@/cli/args.ts";
import { DIM, fail, RED, RESET, YELLOW, say, summarize } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { wholeNumber } from "@/cli/usage.ts";

/**
 * `nouride logs` — the recent log, from the daemon rather than the platform.
 *
 * The journal is still the full history. This exists because the journal is not everywhere: Docker,
 * macOS launchd and an LXC without systemd each have something else or nothing, and none of them can
 * be read from another machine. Every debugging session on this project so far has gone through
 * `journalctl -u nouride`, which quietly assumes one deployment shape out of four.
 */
export async function logs(client: Client, args: string[]): Promise<void> {
  const follow = hasFlag(args, "-f", "--follow");
  const lines = flagValue(args, "-n", "--lines");
  const limit = lines === undefined ? 50 : wholeNumber("logs", lines);
  const level = flagValue(args, "--level");
  const component = flagValue(args, "--component");

  const query = (since?: number): string => {
    const params = new URLSearchParams({ limit: String(Number.isNaN(limit) ? 50 : limit) });
    if (level) params.set("level", level);
    if (component) params.set("component", component);
    if (since !== undefined) params.set("since", String(since));
    return `/logs?${params.toString()}`;
  };

  const first = await client.get<LogsResponse>(query());
  if (first.entries.length === 0 && !follow) return say(`${DIM}nothing in the buffer yet${RESET}`);

  // Said once, and only when it is true: a caller that has fallen behind the ring would otherwise
  // read a gap as a quiet period.
  if (first.oldest > 1) {
    say(`${DIM}buffer holds from #${first.oldest}; older lines are in the platform log${RESET}`);
  }
  for (const entry of first.entries) say(formatLogLine(entry));

  if (!follow) return;

  let since = first.latest;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    let step: FollowStep | null;
    try {
      step = await followStep(client, query(since), since);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), (err as { hint?: string }).hint);
    }
    if (!step) continue;
    // The new process's lines from its first, boot included — what somebody following a restart came to see.
    if (step.restarted) say(`${DIM}(the daemon restarted)${RESET}`);
    for (const entry of step.lines) say(formatLogLine(entry));
    since = step.since;
  }
}

interface FollowStep {
  lines: LogsResponse["entries"];
  since: number;
  restarted: boolean;
}

/**
 * One poll of a follow, or null when the daemon could not be reached — it may be restarting, which is often exactly
 * what is being watched, so the follower asks again. The poll used `get`, which exits on an unreachable daemon: the
 * `catch` meant for a restart never ran, and `logs -f` ended at every restart it was there to follow. A refusal is
 * not a restart — a status under 500 does not come back by asking — and is thrown.
 */
async function followStep(client: Pick<Client, "softGet">, path: string, since: number): Promise<FollowStep | null> {
  try {
    const page = await client.softGet<LogsResponse>(path);
    const cursor = followFrom(since, page);
    // Asked past a restarted daemon's newest line, the page is empty: the next poll asks from its first.
    return { lines: cursor.restarted ? [] : page.entries, since: cursor.since, restarted: cursor.restarted };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== undefined && status < 500) throw err;
    return null;
  }
}

/**
 * Where a follower asks from next: past the newest line it was given — or from the start, when the daemon's sequence
 * went back. The ring is in memory, so a restarted daemon numbers from 1 again, and a follower still asking for lines
 * after the old one's 5000 was answered with nothing until the new one passed 5000: every boot line skipped, the ones
 * a restart is watched for. `nouride chat`'s old poll of `/activity` learned this first. Pure.
 */
export function followFrom(since: number, page: { latest: number }): { since: number; restarted: boolean } {
  return page.latest < since ? { since: 0, restarted: true } : { since: page.latest, restarted: false };
}

const LEVEL_COLOR: Record<string, string> = { debug: DIM, info: "", warn: YELLOW, error: RED };

function formatLogLine(entry: {
  timestamp: string;
  level: string;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}): string {
  const when = entry.timestamp.slice(11, 19);
  const colour = LEVEL_COLOR[entry.level] ?? "";
  const detail = entry.data && Object.keys(entry.data).length > 0 ? ` ${DIM}${summarize(entry.data)}${RESET}` : "";
  return `${DIM}${when}${RESET} ${colour}${entry.level.padEnd(5)}${RESET} ${DIM}${entry.component}${RESET} ${entry.message}${detail}`;
}
