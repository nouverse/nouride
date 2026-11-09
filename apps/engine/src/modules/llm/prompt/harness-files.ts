/**
 * The FILES section of the harness block.
 *
 * Where a relative path resolves, what is shared with the other agents, what the scratchpad is for,
 * and which roots are readable. Every line here has been reworded after a live turn put a file in
 * the wrong place — see the comments.
 */

import { scratchpadFor } from "@nouride/persona";
import { busConventionLines, mentionConventionLines } from "@/modules/router/agent-mentions.ts";
import type { HarnessView } from "./types.ts";
import { secretFieldsLine, variableOf } from "@/modules/tools/exec-secrets.ts";


export function renderFiles({ ctx, toolNames }: HarnessView): string[] {
  const { harness } = ctx;
  const lines: string[] = [];
  // Said at the level that asks it, never beside a TOOLS block that says otherwise: a delete outside the workspace and
  // a credential read ask under `careful` alone (the fixed list, a new command); a credential leaving asks at `balanced`
  // too, and nothing asks at `trusted`.
  const careful = (harness.approvals ?? "careful") === "careful";
  const leaving = harness.approvals !== "trusted";

  if (harness.workspace) {
    const { dir, privateDir } = harness.workspace;
    // Named separately below, so they are excluded from the catch-all list of other roots.
    const extra = harness.workspace.roots.filter((root) => root !== dir && root !== privateDir);
    lines.push(
      "FILES",
      // "Anything you create" used to be the whole sentence, and it fought the scratchpad bullet
      // below: on a live turn the agent scp'd a screenshot into its scratchpad correctly and then
      // copied it into here before sending, because this line told it that was where things go. The
      // copy leaves a permanent file the sweep never sees.
      `- You are working in ${dir}. A relative path resolves there, and it is where anything you make`,
      "  that someone may want later should go.",
      // Stated as a property of the directory rather than as an instruction, because what the model
      // needs to know is *why* putting work there matters: it is the only place a handover lands.
      // Told merely "you may also write to X", a model picks whichever path reads best in a sentence.
      ...(privateDir
        ? [
            "- That directory is shared with the other agents here. It is how work gets handed over:",
            "  a file you leave there is one they can open, and one they leave is one you can.",
            `- ${privateDir} is yours alone: no other agent can read it. Use it for drafts and`,
            "  scratch work. Anything someone else may need to pick up does not belong there.",
            `- ${scratchpadFor(privateDir)} is the disposable corner of that directory, and $TMPDIR`,
            "  already points at it. Anything you need for a turn or two and nobody needs after (a",
            "  screenshot you are about to send, a download on its way to being converted) goes there.",
            "  Old files are swept for you, so leaving one behind is fine.",
            // There used to be a line here telling the agent to `mkdir -p ~/.scratchpad` on a machine
            // reached over ssh. It was read and ignored on a live turn — `$TMPDIR` does not cross an
            // ssh and nothing else made it stick — so the rule changed instead of the instruction:
            // `/tmp` is disposable now, wherever it is, which is what the model already believed.
            "- Deleting files in the scratchpad is ordinary work, and so is deleting a file under /tmp on",
            `  any machine, including one you reached over ssh.${careful ? " A delete outside your workspace asks every time and can never be pre-approved." : ""}`,
            // Watched a turn copy a file out of the scratchpad into the working directory purely to
            // send it, which is how a disposable artefact becomes a permanent one.
            "- You can read, edit or send a file anywhere in these directories by its full path. There is",
            "  never a reason to copy something somewhere else first in order to send it.",
            /**
             * Where a file somebody *sent* lives, said once in the stable prompt.
             *
             * Not a list of files — that was tried and it was wrong. Describing the conversation's
             * attachments in every prompt is what made an agent open a screenshot from a previous
             * conversation after a `/reset`, because a list at the top of a prompt reads as a task.
             *
             * This is the other half of that lesson: announce the *way in*, never the contents. It is
             * one line, in the cached prefix, costs nothing per turn, and names no file. Without it
             * an agent asked "what files are in this conversation" has no idea one exists — observed
             * live, where the answer was reached by grepping the filesystem for the chat id first.
             */
            ...(toolNames.includes("attachment_read")
              ? [
                  "- Files sent with the current message are listed in it, and images may already be in front",
                  "  of you as pictures. For anything sent earlier, call `attachment_read` with no arguments to",
                  "  see what exists and with a ref to open one. If you are asked about a photo, a screenshot",
                  "  or a log that was sent before, that is where to look first.",
                ]
              : []),
            /**
             * The guardrail for the failure this whole change came from.
             *
             * On 2026-09-11 an agent was sent a screenshot of an overlapping mobile layout, was given
             * prose about it instead of the picture, and — holding a shell — built a computer-vision
             * rig out of PIL crops, a Tesseract subprocess and NumPy brightness sums. It hit the
             * tool-call ceiling without answering.
             *
             * It now gets the picture, so the rig has no excuse. The rule is stated anyway, because a
             * model that cannot find a detail in an image reaches for the same idea, and because an
             * ad-hoc OCR pipeline is never the shortest path to a layout bug: the answer is in the
             * stylesheet, not in the pixels.
             */
            "- When a screenshot shows a visual bug (an overlap, a wrong colour, a broken layout), read it",
            "  from the image and then go to the source: the template, the stylesheet, the component. Do not",
            "  write or run scripts to crop, OCR or measure pixels. Cropping a picture you are already",
            "  looking at tells you nothing the picture did not, and a layout bug is caused by code.",
          ]
        : []),
      ...(harness.credentialsDir
        ? [
            `- ${harness.credentialsDir} holds credentials: service-account files, token caches.`,
            "  `read`, `glob` and `grep` cannot open it; only a command you run can, through",
            "  $NOURIDE_CREDENTIALS_DIR. Pass the path to a script. Do not `cat` it, print it or echo it:",
            `  anything you read there is in this conversation forever${careful ? ", and a command that reads a credential path asks a human first" : ""}.`,
          ]
        : []),
      ...(harness.execSecrets?.length
        ? [
            // Each with the commands it reaches: told only the name, an agent tries `echo $PYPI_TOKEN`, finds it
            // empty, and concludes the secret is missing.
            `- These credentials reach your commands as environment variables: ${harness.execSecrets
              .map((secret) => {
                // What is said about it (0.8.19): its site and account, so the agent knows which credential is which.
                const said = [secret.commands.includes("*") ? "" : `only \`${secret.commands.join("`, `")}\``, secretFieldsLine(secret.name)].filter(Boolean);
                return `$${variableOf(secret.name)}${said.length ? ` (${said.join("; ")})` : ""}`;
              })
              .join(", ")}.`,
            "  Reference them by name inside a script. Their values are not shown to you and printing",
            "  one would only put it in this transcript, where it appears as [REDACTED:NAME] anyway.",
            ...(harness.execSecrets.some((secret) => !secret.commands.includes("*"))
              ? [
                  "  One named for some commands reaches a command line only when every part of it is one of",
                  `  those: anything chained to it gets none${leaving ? ", and such a command asks a human before it runs" : ""}.`,
                ]
              : []),
          ]
        : []),
      /**
       * How to get a credential, said whether or not this agent has one.
       *
       * Without it an agent that needs a token has no way to know the mechanism exists, and improvises the worst one.
       * Since 0.7.17 a value sent in chat is taken out of the message before the agent or any record has it, so the
       * chat is a way now — for the hour; one kept for good from the chat is handed to every command of the agent, which the
 * owner can narrow.
       */
      "- Need an API token or password you do not have? The person can send it here: the daemon takes it out",
      "  of the message before you see it and hands you a $TMP_SECRET_… handle for an hour. Kept under a name",
      "  (secret_save when they ask you to, or their `/secret set <name> <value>` here), every command of yours",
      "  gets it as $<NAME> from then on. The person can narrow that to some commands in this agent's config.toml:",
      "  `[security.exec_secrets]` <name> = [\"<command>\"]. A credential file goes in the credentials directory instead.",
      // What happens to a credential file, said once so a step is not spent finding out (0.7.17). A command that prints
      // one — here or over ssh — or prints an environment gives its values as handles (`tools/credential-output.ts`).
      ...(toolNames.includes("exec")
        ? [
            "- A credential file (a .env, a key, a CLI's login) shows its values hidden when `read` opens it. A command",
            "  that prints one, on this machine or another (`ssh host cat .env`), or prints an environment (`env`,",
            "  `printenv`, `docker inspect`, `kubectl get secret -o yaml`) shows each value as a $TMP_SECRET_… handle,",
            "  held for this conversation for an hour: use it in a command, `psql \"$TMP_SECRET_…\"`, never print it.",
            "  Never write a credential into a file you commit or send: a commit or a push that would",
            `  carry a credential file is refused${leaving ? ", and a command that sends one off this machine asks first" : ""}. Nouride's own`,
            "  secret store and control token are refused to every command: a credential is used by name, never read.",
          ]
        : []),
      ...(extra.length > 0
        ? [
            `- You may also read and write under: ${extra.join(", ")}.`,
            "- Use an absolute path for those, or run `glob` first: it returns absolute paths you can pass straight to `read`.",
          ]
        : []),
      "- Anything outside those directories is refused, however the path is spelled.",
      /**
       * Where to look *first*, which the list above does not say.
       *
       * Live, on the operator's own daemon: asked to look at something on their Mac, the agent went
       * straight there over ssh and started changing files — while a configured root holding the very
       * repository in question sat on the machine it was already running on. Nothing was wrong with
       * reaching the Mac; the mistake was reaching it before looking at home, and the prompt had given
       * it no reason to. Naming the directories is not the same as saying they come first.
       *
       * Framed as a search order rather than a prohibition, because reaching another machine is often
       * exactly right — the agent has ssh for a reason. What it must not do is treat "on my Mac" as an
       * instruction to skip its own workspace, when the same path usually resolves locally.
       */
      "- These directories come FIRST. When someone names a file, a project or a repository, even if",
      "  they also name a machine, look for it here before you reach anywhere else, and say what you",
      "  found. A path that resolves in your own roots is the same work without a network hop, without",
      "  an approval, and without touching somebody's laptop.",
      "",
    );
  }

  if (harness.otherAgents) {
    const others = harness.otherAgents;
    lines.push(
      ...(others.channel === "bus"
        ? // Told from the tool list, not assumed from the channel. Assuming it cost a live turn: the
          // section named `ask_agent`, the agent's pack enumerated its tools and did not include it,
          // and the model spent its reasoning looking for the tool it had just been told to call
          // before settling for `delegate` — which runs a helper as *itself*, so the other agent was
          // never involved at all.
          busConventionLines({
            others: others.names,
            ...(others.about ? { about: others.about } : {}),
            hasTool: toolNames.includes("ask_agent"),
            hasDelegate: toolNames.includes("delegate"),
          })
        : mentionConventionLines({
            others: others.names,
            ...(others.about ? { about: others.about } : {}),
            ...(others.frontDesk ? { frontDesk: true } : {}),
            // Forwarded, and it was not. The field was built in `turn.ts`, typed here, and dropped on
            // the way in — so every prompt fell back to `@<id>`, which is precisely the spelling the
            // comment in `mentionConventionLines` says does not resolve on Discord.
            ...(others.mentions ? { mentions: others.mentions } : {}),
            ...(others.absent?.length ? { absent: others.absent } : {}),
            maxHops: others.maxHops,
          })),
    );
  }

  return lines;
}
