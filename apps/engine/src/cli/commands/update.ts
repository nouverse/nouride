/**
 * `nouride update` — is this daemon out of date, and take it if so.
 *
 * ## Bare `nouride update` reports; `--start` acts
 *
 * The reverse of what this used to be, and the reverse of the argument written here before —
 * which said the dangerous reading was the safe default because a short command typed by
 * mistake would then be the harmless one. That reasoning had the risk backwards. `update` is
 * the verb everybody types to *find out*, so the one keystroke somebody reaches for by reflex
 * was the one that replaced the binary and ended the process. `--then` caught it, but a
 * required flag is a seatbelt, not a reason to point the car at the wall.
 *
 * So the default is the answer to "am I behind?" and taking it is a separate word. `--check`
 * stays as an explicit spelling of the same thing, because it is in scripts and in prompts.
 *
 * ## Why `--then` is required
 *
 * The same rule `nouride restart` keeps, and for the same measured reason: this command
 * ends the conversation it was run from, so the turn that reports whether it worked has to
 * exist *before* the daemon goes away. `--no-then` is the escape hatch for a person at a
 * terminal watching it themselves, which is the only case where somebody is already
 * looking.
 *
 * ## What the fixed list does with this
 *
 * `nouride update --start` is on it (`replace`); the bare command and `--check` are not. So an agent
 * reaching this through `exec` is asked every time under `careful` and can never hold a standing grant
 * for it — while still being free to answer "are we current?" unprompted.
 */

import { BOLD, CYAN, DIM, GREEN, RESET, YELLOW, fail, say, usageError, usageLines } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { lookAtHealth, waitBack } from "@/cli/wait-back.ts";
import { flagValue, hasFlag } from "@/cli/args.ts";

interface InstallView {
  version: string;
  edition: string;
  installDir: string;
  supervisor: string;
  compiled: boolean;
  platform: string;
  arch: string;
  musl: boolean;
}

interface PlanView {
  can: boolean;
  from: string;
  to: string;
  artifact?: string;
  tarballUrl?: string;
  reason?: string;
  instead?: string[];
}

interface CheckView {
  current: string;
  /** The newest release carrying a build for *this* edition — not simply the newest tag. */
  latest: string;
  newer: boolean;
  publishedAt: string | null;
  notesUrl: string | null;
  latestElsewhere?: string;
  blockedReason?: string;
  plan?: PlanView;
  /** A newer release needs a newer version first; `latest` is then the stepping stone. */
  floor?: { release: string; needs: string; message: string };
  /** What the channel says about this install that is not an outage: a licence whose updates ended. */
  notice?: string;
  /** The track this check followed, `[update] track` (0.8.18); absent from a daemon before it. */
  track?: "latest" | "lts";
  /** The other track's newest release, when it is newer than this version and is not `latest`. */
  otherTrack?: { track: "latest" | "lts"; tag: string };
}

/** What the other track would offer, said once: "0.10.0, new, is on the latest track; this install follows lts". */
function otherTrackLine(check: CheckView): string | null {
  if (!check.otherTrack) return null;
  const { track, tag } = check.otherTrack;
  return track === "latest"
    ? `${tag}, new, is on the latest track; this install follows lts and stays on its line (\`nouride update --track latest\` moves it on)`
    : `${tag} is the long-term line's newest (\`nouride update --track lts\` stays on that line)`;
}

interface UpdateResponse {
  supported: boolean;
  install: InstallView;
  check?: CheckView;
  error?: string;
}

export async function update(client: Client, args: string[]): Promise<void> {
  const flag = (key: string): string | undefined => flagValue(args, `--${key}`);

  /** `--track latest|lts` (0.8.18): set which releases this install follows, then check on it. */
  const track = flag("track");
  if (track !== undefined) {
    const saved = await client.post<{ ok: boolean; track: string; error?: string }>("/update/track", { track });
    if (!saved.ok) fail(saved.error ?? "the track was not saved");
    say(`${GREEN}✓${RESET} this install follows the ${saved.track} track`);
    say();
  }

  const response = await client.get<UpdateResponse>("/update");
  const { install } = response;

  say(`${BOLD}This install${RESET}`);
  say(`  version      ${install.version}`);
  // The edition decides which tarball an update would fetch, so it is the line somebody
  // checks when an update goes to the wrong build.
  say(`  edition      ${install.edition}${install.compiled ? "" : `  ${DIM}(source checkout)${RESET}`}`);
  say(`  platform     ${install.platform}/${install.arch}${install.musl ? " (musl)" : ""}`);
  say(`  directory    ${install.installDir}`);
  say(`  supervisor   ${install.supervisor}`);
  // Which releases it is offered (0.8.18); a daemon before it sends none.
  if (response.check?.track) say(`  track        ${response.check.track}`);
  say();

  if (!response.supported) {
    fail("this build has no update provider, so it cannot check");
  }
  if (response.error) {
    fail(`could not reach the release channel: ${response.error}`);
  }

  const check = response.check;
  if (!check) fail("the daemon returned no result");
  const other = otherTrackLine(check);

  if (!check.newer && check.floor) {
    // Not "up to date": a newer release exists, and nothing on the channel this install can take reaches its floor.
    say(`${YELLOW}!${RESET} ${check.floor.message}`);
    return;
  }

  if (!check.newer && check.notice) {
    // Not "up to date" either: newer releases exist, past the year of updates this licence was sold with.
    say(`${YELLOW}!${RESET} ${check.notice}.`);
    return;
  }

  if (!check.newer) {
    say(`${GREEN}✓${RESET} up to date: ${check.current} is the newest release built for this edition.`);
    /**
     * Said out loud rather than left as silence.
     *
     * Editions are built and published separately, so a version can exist without existing for
     * this build. "Up to date" with a newer tag sitting on the channel looks like the check is
     * broken; naming it and saying why is the honest answer, and it is the one that stops
     * somebody going to look for an update they can never have.
     */
    if (check.latestElsewhere) {
      say(
        `${DIM}  ${check.latestElsewhere} exists and is not an update here: ` +
          `${check.blockedReason ?? "it carries no build for this edition"}.${RESET}`,
      );
    }
    if (other) say(`${DIM}  ${other}${RESET}`);
    return;
  }

  say(`${CYAN}↑${RESET} ${BOLD}${check.current} → ${check.latest}${RESET}`);
  if (other) say(`  ${DIM}${other}${RESET}`);
  // The stepping stone: `--start` takes `latest`, never the release that needs it first.
  if (check.floor) say(`  ${YELLOW}${check.floor.message}${RESET}`);
  if (check.publishedAt) say(`  published    ${check.publishedAt}`);
  if (check.notesUrl) say(`  notes        ${check.notesUrl}`);

  const plan = check.plan;
  if (plan && !plan.can) {
    say();
    say(`${YELLOW}!${RESET} this install cannot update itself: ${plan.reason}`);
    for (const line of plan.instead ?? []) say(`  ${DIM}${line}${RESET}`);
    return;
  }
  say(`  artifact     ${plan?.artifact}`);

  /**
   * Reporting is the default; `--check` is the same thing said out loud, and both land here, so there
   * is exactly one way to leave this function without acting.
   *
   * `--check` is named as well as implied. Reporting is what happens without `--start`, so this flag
   * changes nothing — and that is exactly
   * why it has to appear here. It is in scripts, in prompts and in this CLI's own help; a documented
   * flag that no code mentions is one a refactor cannot see it is breaking, and the `--start` change
   * left `--check` working only by falling through.
   */
  if (hasFlag(args, "--check") || !hasFlag(args, "--start")) {
    say();
    return say(
      `${DIM}run \`nouride update --start --then "<what to check when you are back>"\` to take it${RESET}`,
    );
  }

  const then = flag("then");
  /**
   * Only an agent has to say what happens after. Its `exec` and its `nouride` tool both carry
   * `NOURIDE_AGENT_ID` (`tools/builtins/nouride-cli.ts`), so a call without one was typed by a person,
   * who is watching — and for them `nouride update --start` is the whole command. Requiring `--no-then`
   * from that person was a seatbelt aimed at the one caller who did not need it.
   */
  const fromAgent = Boolean(process.env.NOURIDE_AGENT_ID);
  if (!then && !hasFlag(args, "--no-then") && fromAgent) {
    usageLines(
      `${DIM}nouride update --start --then "<what to do when you are back>"\n` +
        `  --in <seconds>             when to wake up (default 20, max 600)\n` +
        `  --agent --gateway --chat   where to come back to; defaults to this conversation\n\n` +
        `\`--then\` is required. This command ends the conversation it was run from, and an update\n` +
        `that turns out to be wrong cannot be checked by an agent that is no longer running. The\n` +
        `follow-up is created BEFORE the swap, so it fires even if the daemon takes a while.\n\n` +
        `  e.g. nouride update --start --then "confirm the version changed and every gateway reconnected"${RESET}`,
    );
  }

  /**
   * `--no-then` is a person at this terminal, watching: no follow-up turn, so no conversation to aim
   * one at. It used to pass the check above and then still demand --agent, --gateway and --chat — so
   * from a shell it could never act. The daemon reads "none of the three" as the watched case.
   */
  // `--now` restarts at once; without it the daemon restarts when nothing is running, within ten minutes.
  const now = hasFlag(args, "--now");
  // Looked at before the swap, so the wait knows the process that comes back from the one being replaced.
  const before = hasFlag(args, "--wait") ? await lookAtHealth(client.baseUrl) : null;
  if (!then) {
    const watched = await client.post<{ note: string; to: string }>("/update/apply", now ? { now: true } : {});
    say();
    say(`${GREEN}✓${RESET} ${watched.note}`);
    if (before) return await waitBack(before, client.baseUrl, { version: watched.to });
    say(`${DIM}no follow-up turn, since you are watching. Check with: nouride status${RESET}`);
    return;
  }

  const agentId = flag("agent") ?? process.env.NOURIDE_AGENT_ID ?? "";
  const gatewayId = flag("gateway") ?? process.env.NOURIDE_GATEWAY_ID ?? "";
  const chatId = flag("chat") ?? process.env.NOURIDE_CHAT_ID ?? "";
  if (!agentId || !gatewayId || !chatId) {
    usageError(
      "`--then` needs to know where to come back to.",
      "Pass --agent, --gateway and --chat. Your own values are in your prompt under `Gateway instance`. " +
        "At a terminal yourself? Use --no-then instead.",
    );
  }

  const seconds = Number(flag("in") ?? 20);
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) usageError("`--in` must be between 5 and 600 seconds.");

  const result = await client.post<{ note: string; to: string; wake_in_seconds: number }>("/update/apply", {
    agent_id: agentId,
    gateway_id: gatewayId,
    chat_id: chatId,
    then,
    in_seconds: Math.floor(seconds),
    ...(now ? { now: true } : {}),
  });
  say();
  say(`${GREEN}✓${RESET} ${result.note}`);
  say(`${DIM}a turn is scheduled in ${result.wake_in_seconds}s to pick this up${RESET}`);
  if (before) await waitBack(before, client.baseUrl, { version: result.to });
}
