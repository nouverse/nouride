import type {
  CronDetailResponse,
  CronJobRow,
  CronListResponse,
  CronRunOutcome,
} from "@/cli/wire.ts";
import { BOLD, DIM, GREEN, RED, RESET, say, usageError, usageLines, YELLOW } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { flagValue, hasFlag, sessionMode } from "@/cli/args.ts";
import { knownAction } from "@/cli/usage.ts";

/**
 * `nouride cron` — the operator's side of the scheduler.
 *
 * Two things here that an agent cannot reach without a human seeing the prompt, both for the same reason:
 * reaching this command means holding the control token or an operator account.
 *
 * - `--command` creates a job that runs argv on the host with no model and no approval gate.
 * - `--gateway`/`--chat` point a job at any conversation, including one the creator is not in.
 *
 * And one thing that matters more than either: `nouride cron run <id>` fires a job immediately.
 * Waiting until 09:00 to discover a daily report is broken is not a development loop.
 */
export async function cron(client: Client, args: string[]): Promise<void> {
  const [action, id] = args;
  knownAction("cron", action, ["add", "update", "rm", "remove", "enable", "disable", "run", "runs", "list"]);
  const flag = (name: string): string | undefined => flagValue(args, `--${name}`);
  const has = (name: string): boolean => hasFlag(args, `--${name}`);

  if (action === "add") {
    const name = flag("name");
    if (!name) {
      usageLines(
        `${DIM}nouride cron add --name <name> (--at <2h|timestamp> | --every <15m> | --cron "0 9 * * *")\n` +
          `  --gateway <id> --chat <id>          where it goes (from an agent: this conversation)\n` +
          `  --agent <id>                        which agent runs it (from an agent: that agent)\n` +
          `  --text <message>                    a plain reminder, no model call\n` +
          `  --message <prompt>                  wake the agent with this instead\n` +
          `  --command <shell>                   run a command, no model call; a run that prints nothing sends nothing\n` +
          `  --then agent                        …and wake the agent with what it printed, when it printed something\n` +
          `  --mission <goal>                    long work: each run a mission, ended at the reviewer\n` +
          `  --check <command>                   …a command whose exit says a run is done\n` +
          `  --no-review                         …and no reviewer: the check is the whole answer\n` +
          `  --session <fresh|isolated|chat>     history: none (default), private, or the chat's\n` +
          `  --tz <zone> --quiet --keep${RESET}`,
      );
    }

    const command = flag("command");
    const message = flag("message");
    const text = flag("text");
    const goal = flag("mission");
    const payload = goal
      ? { kind: "mission", goal, ...(flag("check") ? { checks: [flag("check")] } : {}), ...(has("no-review") ? { review: false } : {}) }
      : command
      ? {
          kind: "command",
          // `sh -lc` because an operator typing `--command` means a shell line, not an argv. The
          // agent reaching this argv meets a hardline gate — see `schedulesAShellCommand` in @nouride/policy.
          argv: ["sh", "-lc", command],
          then: flag("then") === "agent" ? "agentTurn" : "deliver",
          ...(flag("cwd") ? { cwd: flag("cwd") } : {}),
        }
      : message
        ? { kind: "agentTurn", message }
        : { kind: "systemEvent", text: text ?? name };

    const { job } = await client.post<{ job: CronJobRow }>("/cron", {
      // From an agent's own turn the daemon sets these, the way `wake-up` and `update` already read
      // them: an agent scheduling something for itself should not have to name itself to be heard.
      agentId: flag("agent") ?? process.env.NOURIDE_AGENT_ID ?? "",
      name,
      ...(flag("at") ? { at: flag("at") } : {}),
      ...(flag("every") ? { every: flag("every") } : {}),
      ...(flag("cron") ? { cron: flag("cron") } : {}),
      ...(flag("tz") ? { tz: flag("tz") } : {}),
      payload,
      target: {
        gatewayId: flag("gateway") ?? process.env.NOURIDE_GATEWAY_ID ?? "",
        chatId: flag("chat") ?? process.env.NOURIDE_CHAT_ID ?? "",
      },
      session: sessionMode(flag("session")),
      delivery: { mode: has("quiet") ? "none" : "announce" },
      keepAfterRun: has("keep"),
    });

    say(`${GREEN}✓${RESET} scheduled ${BOLD}${job.name}${RESET} ${DIM}${job.id}${RESET}`);
    return say(`${DIM}  next ${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "never"}${RESET}`);
  }

  /**
   * `update` — the last verb the deleted `cron_manage` had that this did not.
   *
   * Over `POST /cron/:id`, which already existed for the dashboard. Only the fields named are sent, so
   * changing a schedule does not silently reset a name and changing a name does not reset a schedule —
   * the tool behaved the same way, and a partial update that quietly blanks the rest is the kind of
   * thing nobody notices until a job fires at the wrong hour.
   */
  if (action === "update") {
    const at = flag("at");
    const every = flag("every");
    const cronExpr = flag("cron");
    const name = flag("name");
    const text = flag("text");
    const message = flag("message");
    const agent = flag("agent");

    if (!id || (!at && !every && !cronExpr && !name && !text && !message && !agent)) {
      usageLines(
        `${DIM}nouride cron update <id> [--name <name>] [--at <2h|timestamp> | --every <15m> | --cron "0 9 * * *"]\n` +
          `  [--tz <zone>] [--text <message> | --message <prompt>] [--agent <id>]${RESET}`,
      );
    }

    const { job } = await client.post<{ job: CronJobRow }>(`/cron/${encodeURIComponent(id)}`, {
      ...(name ? { name } : {}),
      ...(agent ? { agentId: agent } : {}),
      ...(at ? { at } : {}),
      ...(every ? { every } : {}),
      ...(cronExpr ? { cron: cronExpr } : {}),
      ...(flag("tz") ? { tz: flag("tz") } : {}),
      ...(message ? { payload: { kind: "agentTurn", message } } : {}),
      ...(text && !message ? { payload: { kind: "systemEvent", text } } : {}),
    });

    say(`${GREEN}✓${RESET} updated ${BOLD}${job.name}${RESET} ${DIM}${job.id}${RESET}`);
    return say(`${DIM}  next ${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "never"}${RESET}`);
  }

  if (action === "rm" || action === "remove") {
    if (!id) usageError(`usage: nouride cron rm <id>`);
    await client.del(`/cron/${encodeURIComponent(id)}`);
    return say(`${GREEN}✓${RESET} removed ${id}`);
  }

  if (action === "enable" || action === "disable") {
    if (!id) usageError(`usage: nouride cron ${action} <id>`);
    await client.post(`/cron/${encodeURIComponent(id)}/${action}`);
    return say(`${GREEN}✓${RESET} ${action}d ${id}`);
  }

  if (action === "run") {
    if (!id) usageError(`usage: nouride cron run <id>`);
    say(`${DIM}running…${RESET}`);
    const { outcome } = await client.post<{ outcome: CronRunOutcome }>(
      `/cron/${encodeURIComponent(id)}/run`,
    );
    const mark = outcome.status === "success" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    say(`${mark} ${outcome.status}`);
    return outcome.result ? say(`${DIM}${outcome.result}${RESET}`) : undefined;
  }

  if (action === "runs") {
    if (!id) usageError(`usage: nouride cron runs <id>`);
    const { job, runs } = await client.get<CronDetailResponse>(`/cron/${encodeURIComponent(id)}`);
    say(`${BOLD}${job.name}${RESET} ${DIM}${job.id} · ${job.describes}${RESET}`);
    if (!runs || runs.length === 0) return say(`${DIM}no runs yet${RESET}`);
    for (const run of runs) {
      const mark =
        run.status === "success" ? `${GREEN}✓${RESET}` : run.status === "skipped" ? `${DIM}–${RESET}` : run.status === "interrupted" ? `${YELLOW}↻${RESET}` : `${RED}✗${RESET}`;
      const took = run.finishedAt ? `${Math.round((run.finishedAt - run.startedAt) / 1000)}s` : "unfinished";
      say(`${mark} ${new Date(run.startedAt).toISOString()} ${DIM}${took}${RESET}`);
      if (run.result) say(`${DIM}    ${String(run.result).split("\n")[0]?.slice(0, 160) ?? ""}${RESET}`);
    }
    return;
  }

  const { jobs, timezone } = await client.get<CronListResponse>(
    `/cron${has("all") ? "?all=1" : ""}`,
  );
  if (!jobs || jobs.length === 0) {
    return say(`${DIM}nothing scheduled: nouride cron add --name … --every 1h --gateway … --chat …${RESET}`);
  }

  say(`${DIM}times in ${timezone}${RESET}`);
  say();
  for (const job of jobs) {
    const mark = job.enabled ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
    const next = job.nextRunAt
      ? new Date(job.nextRunAt).toLocaleString("sv-SE", { timeZone: timezone })
      : job.disabledReason
        ? // Red for what went wrong; `fired` is a one-shot kept by `--keep` after it ran, which did not.
          `${job.disabledReason === "fired" ? DIM : RED}${job.disabledReason}${RESET}`
        : "paused";
    say(`${mark} ${BOLD}${job.name}${RESET} ${DIM}${job.id}${RESET}`);
    say(`    ${job.describes} ${DIM}·${RESET} next ${next}`);
    say(
      `    ${DIM}${job.agentId} → ${job.target.gatewayId} ${job.target.chatId}` +
        ` · ${job.session}` +
        ` · ${job.runCount} run${job.runCount === 1 ? "" : "s"}` +
        `${job.failCount > 0 ? `, ${job.failCount} failed` : ""}${RESET}`,
    );
  }
  say();
  say(`${DIM}nouride cron run <id>  ·  runs <id>  ·  update <id>  ·  disable <id>  ·  rm <id>  ·  --all${RESET}`);
}
