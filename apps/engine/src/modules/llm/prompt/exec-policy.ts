/**
 * The exec policy paragraph: what this agent may run, and what it will be asked about.
 */

/**
 * What every level asks, `trusted` too, as the model reads it. Work nobody watches sending somewhere its job did not
 * name is left out: such a turn is told the one chat it sends to, and no other turn can do it.
 */
export const EVERY_LEVEL_ASKS =
  "installing a program for every agent, changing your own persona, and changing who People says a person is";

/**
 * What `balanced` still asks a human (`BALANCED_ASKS` in `@nouride/policy`), as the model reads it. The daemon's own
 * state is left out: on an install where it is asked, it is a path the agent has no business in either way.
 */
export const BALANCED_LIST =
  "changing a config.toml, giving someone access, stopping this daemon, replacing or deleting a stored secret, a credential" +
  ` leaving this machine, changing this machine's system packages, ${EVERY_LEVEL_ASKS}`;

import { isRoot } from "@nouride/runtime";
import type { ApprovalLevel } from "@nouride/shared";
import type { HarnessFacts } from "./types.ts";

/**
 * What the agent needs to know about running commands.
 *
 * Deliberately concrete about the *mechanism* — that a yes can be remembered, and that some
 * classes never are — because the useful behaviour it unlocks is the model saying "this will ask
 * you once" instead of silently stalling, and not re-proposing `sudo` after a refusal.
 */
export function renderExecPolicy(
  policy: NonNullable<HarnessFacts["execPolicy"]>,
  /**
   * A property of the host, not of this agent, which is why it is read here rather than threaded
   * through the five places that build `execPolicy`. A parameter with a default so a test can state
   * both cases without a root process.
   */
  privileged = isRoot(),
  /**
   * This conversation's approval level — what decides what asks. A prompt that said both "nothing
   * asks" and "this always asks" once left the model to pick one.
   */
  approvals: ApprovalLevel = "careful",
): string[] {
  const lines: string[] = [];

  if (approvals === "trusted") {
    lines.push(
      `- You may run any command on this host, and it runs without asking, except ${EVERY_LEVEL_ASKS}, which a human` +
        " answers at every level. Be correspondingly careful.",
    );
  } else if (approvals === "balanced") {
    lines.push(
      "- You may run any command on this host, and at this conversation's approval level it runs without asking, except" +
        ` ${BALANCED_LIST}, which a human answers every time.`,
    );
  } else {
    lines.push(
      "- You may run any command on this host. The first time you run a particular command a human is asked; if they answer" +
        " \"always\", that exact command stops asking. Say so rather than appearing to stall.",
    );
    /**
     * Whether any grant is held, never how many.
     *
     * `grantsHeld` is `grants.liveKeys(id).size` — a live count with a TTL, so it moves when a grant
     * is issued *and* when one expires with nobody doing anything. This block is cached
     * (`Stability = "capability"`), and a bare number in it invalidated the capability breakpoint,
     * plus the whole conversation behind it, every time grants churned.
     *
     * Dropping the number costs nothing the model could act on: "some commands run immediately" and
     * "three commands run immediately" lead to exactly the same behaviour, because it is not told
     * *which* three and cannot look them up. Whether the set is empty does change what it should say,
     * so that distinction stays.
     */
    if (policy.grantsHeld > 0) {
      lines.push("- Some commands already have standing permission, so they run immediately.");
    }
  }

  lines.push(
    "- Anything that could take more than a couple of minutes (a test suite, a build, a" +
      " deploy) must use `background: true`. You get a job id immediately and are told when it" +
      " finishes; a foreground command is killed at the turn deadline and its work is lost. If you" +
      " forget on an obviously long-running command, Nouride may move it to the background for you.",
    /**
     * A server is not that. It never finishes, so as a background job it ends the turn and never wakes
     * it: found live, an agent asked for a preview link started the server with `background: true`
     * three times over and each turn ended on "the server is running" with no link.
     */
    "- A server you start so it can be used or shown (a dev server, a preview, a tunnel) never" +
      " finishes, so it is not a background job: start it with `service: true`. Your turn goes on, so" +
      " check it answers and use it in the same turn; it is listed in the jobs, and you stop it with" +
      " `nouride jobs kill <id>`. Tell the person it is running and that you can stop it.",
    // The executor ends the turn the moment a job starts (`background_started`), so "unless one
    // follow-up read is required" described a call that could never happen.
    "- Starting a background job ends this turn: after it you get one short reply and no further" +
      " tool calls, so make any other call you need before it or in the same message. The daemon" +
      " wakes you when the job finishes.",
    /**
     * Multi-line content inside double quotes is where commands broke: a file written over ssh as
     * `ssh host "cat << 'EOF' > f ..."`, a `python3 -c "..."` script — the local shell ran the backticks
     * and `$(...)` inside before anything else saw them, and the command died on a syntax error at line 91.
     */
    "- Multi-line content (a file, a script) goes in through a quoted heredoc: `cat > path <<'EOF'`," +
      " `python3 - <<'EOF'`, and to another machine `ssh host 'cat > path' <<'EOF'`. Never inside a" +
      " double-quoted argument, where your shell runs its backticks and `$(...)` first.",
    /**
     * Unless there is other work, and only then. An agent that started a build and had an unrelated
     * fix to make had to end its turn and sit idle until the build woke it.
     */
    "- If you have other work that does not need the job's result, pass `keep_working: true` and do it" +
      " while the job runs; its result comes to you after your turn. If what comes next needs the" +
      " result (reading its output, deploying what it builds), leave it off and wait to be woken.",
    /**
     * The shape the rule above does not cover, and the one that actually burned a turn.
     *
     * "Anything that could take more than a couple of minutes" is about a single slow *command*, and
     * a poll is not one: each check returns in a second and the model judges it quick, correctly.
     * What is slow is the waiting between checks, and nothing here said anything about that. Live,
     * a turn watched a remote build with nine rounds of `sleep`-then-check, spent the whole turn
     * deadline and reported none of what it had already found.
     *
     * Written as one instruction with a mechanism, not as a prohibition: "do not poll" leaves the
     * model no way to wait at all, which is the mistake the UNAVAILABLE wording made.
     */
    "- Waiting is background work too. When you are watching something you cannot speed up (a build," +
      " a deployment, a job on another machine), do not sit in a loop of sleep-then-check. Put the" +
      " wait itself in a background job: the sleep and the check as one command with" +
      " `background: true` and an `on_complete` saying what to do with the result. Then reply saying" +
      " what you are waiting on, and answer properly when you are woken. Each poll costs a round" +
      " trip, and what you run out of is the turn, not their patience.",
  );
  // At `trusted` and `balanced` the first line above already names what asks. Here the whole fixed list, `balanced`'s
  // in its words, so the levels never name one entry two ways.
  if (approvals === "careful") {
    lines.push(
      "- Some commands always ask and can never get standing permission: deleting outside your workspace, tearing" +
        " infrastructure down, force-pushing, replacing this daemon, reading this daemon's database, scheduling a job" +
        ` that runs unasked, starting an interactive session, ${BALANCED_LIST}.` +
        " Putting `sudo` in front changes nothing: what it elevates is classified on" +
        " its own merits, so `sudo rm -rf /srv` is still a delete. If one is refused, do not retry it or look for a way" +
        " around it. Propose something narrower.",
    );
  }

  /**
   * Told, because the cost of not telling it is specific: where the daemon runs as root, `sudo` is unnecessary, and an
   * agent that does not know it is root writes it anyway and starts looking for ways to install things without a
   * package manager. Keyed on the process, not on an edition or an appliance identity: what makes `sudo` the wrong
   * thing to write is being root, and nothing else.
   */
  if (privileged) {
    lines.push(
      "- You are running as root on this host, and it is a machine dedicated to this daemon: it is" +
        " yours to manage. Install packages, manage services and read system logs directly. Do NOT" +
        " prefix anything with `sudo`: it is unnecessary here.",
    );
  }

  return lines;
}
