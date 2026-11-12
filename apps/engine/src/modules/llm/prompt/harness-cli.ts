/**
 * The CLI section: what `nouride` can answer, for an agent that can actually run it.
 *
 * Knowing the CLI exists is what turns "the daemon seems broken" into "let me look" — every command
 * described here answers a question the agent otherwise has to guess at or ask a human for.
 */

import { asCalled } from "@/modules/tools/fold.ts";
import type { HarnessView } from "./types.ts";


export function renderCli({ ctx, toolNames }: HarnessView): string[] {
  const { harness } = ctx;
  const lines: string[] = [];

  /**
   * Gated on the tool, not on `exec` and an install directory as it used to be.
   *
   * The old gate was `installDir && toolNames.includes("exec")`, and it was wrong twice: an agent
   * with `exec` still could not run the CLI (`resolveCwd` refuses the install directory), and an
   * agent without `exec` could not be given the daemon's control surface at all even though it needs
   * no shell to use it. The tool is now the thing that decides.
   */
  if (toolNames.includes("nouride")) {
    // Each dedicated tool named only when held; otherwise the CLI verb is the way, and naming the
    // missing tool would send the model after a tool it does not have.
    const canCreateAgent = toolNames.includes("agent_create");
    const dedicated = [
      ["person_record", "a person"],
      ["agent_configure", "your own provider and model"],
      ["skill_toggle", "a skill"],
    ].filter(([tool]) => toolNames.includes(tool!));
    lines.push("", "YOUR CLI");
    lines.push(
      /**
       * Framed as *what only this can answer*, not as a list of domains.
       *
       * The list used to include `people` and `agents` — both of which have dedicated tools
       * (`person_record`, `agent_create`, `agent_configure`). So the section that exists to teach the
       * CLI was also, quietly, advertising it for two jobs a tool already does better. Nothing
       * anywhere said which to reach for, which made "prefer the command" a reading the prompt
       * permitted rather than one it ruled out.
       */
      "- You run inside a Nouride daemon, and the `nouride` tool is how you ask it the things nothing else can answer: its own logs, audit trail and status; connections and gateways; scheduled jobs and webhooks; grants, access and config.",
      ...(dedicated.length > 0
        ? [
            `- Where you have a dedicated tool for something, that tool is the way and the command is not: ${dedicated.map(([tool, what]) => `${what} goes to \`${asCalled(tool!, toolNames)}\``).join(", ")}. Same work, and the tool hands back a result instead of text to parse.`,
          ]
        : []),
      // The whole command set used to be written out here — ~1,500 tokens on every request, uncached,
      // and a hand-kept copy of what `nouride help` prints. It went stale within a day of a verb being
      // added. Asking the daemon costs one call and is never wrong.
      "- Run `help` first when you need a command you do not already know, and `<command> --help` for one of them. Do not guess a command, and do not read the database or reach for OS-level tools to answer something the CLI answers.",
      /**
       * Said here rather than left to the refusal, which costs a round trip to learn.
       *
       * `exec` refuses this daemon's own CLI now — see `reachesOwnCli`. It is the same binary either
       * way, and the shell route is worse in four measurable ways, so the prompt names the one that
       * works instead of letting the model find the closed door.
       */
      "- Do not reach this CLI through `exec`. Same program, worse in every way that matters: the bare name resolves through $PATH to whichever install owns it, a credential can only go in the argument list where it is recorded permanently, and nothing tells the daemon which agent and chat is asking. `exec` refuses it and says this. A `nouride` binary you built yourself, in your own directories, is not this and runs normally.",
      "- It authenticates by itself. Do not look for a token and do not read `data/.control-token`: a command that names it is refused, at every level, and you do not need it.",
      /**
       * What is left after everything the CLI already prints was removed.
       *
       * `webhook add` says the URL is a credential in its own output; `mcp add` says the tools are
       * not connected until a restart; the fired webhook body is already wrapped in the untrusted
       * marker by the scheduler. All three were written out here as well — the same duplication this
       * whole section was built to remove, one layer down.
       *
       * These four survive because they have to be known *before* a command runs, or instead of one.
       */
      // It invented `/api/v1/webhooks/<token>` when asked to describe a URL before creating one —
      // plausible, wrong, and pasted into GitHub before anyone checks.
      "- Never describe or predict a webhook URL you have not created. Run `webhook add` and quote what it printed: the token is random and the address depends on config you cannot see.",
      /**
       * The `stdin` parameter, named — because the advice that replaced it was unfollowable.
       *
       * This line used to say "pipe the value in", which no agent could do: the sandbox ran every
       * command with `stdin: "ignore"`, so the only path that worked was the inline flag the same
       * sentence warned against. The tool now has a `stdin` field and it is the one argument this
       * daemon never writes down.
       */
      "- A credential goes in the `stdin` field of this tool, never in `args`. `secret set <name> --stdin`, `provider add <name> --stdin`, `gateway add … --stdin` and `mcp add --stdin` all read it from there. Everything in `args` is kept in the exec grant, the audit log and this daemon's log table, permanently. The inline `--token`/`--key`/`--value` forms exist for a human who has accepted that. If you do not have the credential, ask for it; never invent one.",
      `- You can finish a setup you start: \`secret set\` stores a token, \`provider add\` creates a model profile, \`gateway add\` creates a connection${canCreateAgent ? ", `agent_create` makes an agent" : ""}. Ask the person for the credential in chat and store it yourself rather than handing back instructions.`,
      /**
       * The counterweight, added in the same change as the invitation above.
       *
       * Those four verbs were dashboard-only until today, so the prompt had never needed to say when
       * *not* to use them. An invitation with no brake is how an agent ends up provisioning something
       * nobody asked for — and the approval gate is a poor substitute for saying so, because it asks
       * "allow this?" without conveying that the decision was ever the operator's to make.
       */
      `- Those ${canCreateAgent ? "four" : "three"} change what this daemon *is*, not what it is doing: a new connection, a new profile, a stored credential${canCreateAgent ? ", another agent" : ""}. Do them when you are asked to, say what you are about to create before you create it, and do not decide on somebody's behalf that their install needs one.`,
      /**
       * Replaces "never restart". That rule solved the problem by removing the capability, so an
       * agent that needed a gateway restarted could only describe the job and give it back.
       *
       * Stated as the mechanism rather than as a preference, deliberately. This file's neighbour
       * records what happened when a *preference* was tried: "a model told 'batch your calls' has a
       * preference it can weigh against its own habit — and it did." So the CLI refuses without
       * `--then`, and this says why so the refusal is not a surprise.
       */
      "- `restart` (the whole daemon) and `gateway restart` end this conversation. `restart` waits until nothing is running (this turn included, so your reply goes out first); `--now` does not wait. Both REQUIRE `--then \"<what to do when you are back>\"`, which schedules a one-shot job in this chat before the restart happens, so you come back as a fresh turn and can check the outcome. Tell the person you will. They refuse without it. Use it rather than asking the person to restart for you.",
      "- After a `--then` restart, verify rather than assume: the wake-up fires whether the restart worked or not, and reporting success you did not check is the failure it exists to catch.",
    );
  }

  if (harness.commands.length > 0) {
    lines.push("", "COMMANDS THE HUMAN CAN TYPE");
    lines.push(
      `- Handled by the harness before they reach you, so you never see them: ${harness.commands.join(" ")}`,
      "- Do not describe what one does beyond what its name and the line below say; `/help` lists them with descriptions.",
      "- Every one of them acts on YOU in THIS chat: `/stop` and `/start` pause and resume you, not another agent. Do not offer them as a way to control someone else.",
      "- If someone asks how to clear the conversation, pause you, or change your model, tell them these exist.",
    );
  }

  return lines;
}
