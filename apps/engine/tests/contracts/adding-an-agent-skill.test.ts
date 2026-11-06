/**
 * Adding an agent from a chat (0.8.1): the built-in nouride skill is chosen when somebody asks for a new agent, and its
 * guide carries the rules — ask one thing at a time, offer only the CLIs installed here, say it all back before
 * `agent_create`, and never take a CLI's sign-in code in a chat. What is sent to a model is behaviour: these are the
 * words that carry it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_DIR = join(import.meta.dir, "../../../../content/skills/nouride");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
// As one line: where Markdown wraps a sentence is not part of what it says.
const guide = readFileSync(join(SKILL_DIR, "references/adding-an-agent.md"), "utf8").replace(/\s+/g, " ");

describe("adding an agent from a chat", () => {
  test("the nouride skill is chosen for it, and points to its guide", () => {
    const description = skill.match(/^description: (.*)$/m)![1]!;
    expect(description).toContain("a new agent");
    expect(description).toContain("to add or create an agent");
    expect(skill).toContain("`references/adding-an-agent.md`");
  });

  test("asks one thing at a time, with a suggestion, in the person's language", () => {
    expect(guide).toContain("One question a message, each with your suggestion, in their language");
    for (const asked of ["**What is it for?**", "**Internal or external.**", "**Its name**", "**Its persona**, for either kind", "**For an external agent, the account**", "**Its look**"]) {
      expect(guide).toContain(asked);
    }
  });

  test("offers only the coding CLIs installed here, and how to install the rest", () => {
    expect(guide).toContain("run `nouride agents scan`");
    expect(guide).toContain("offer only the CLIs it says are installed");
    // The orchestrator installs the programs every agent runs: it may install the CLI itself, on a yes, through
    // `nouride tools run` — and never with a piped installer script.
    expect(guide).toContain("If you are the orchestrator, you install the programs every agent runs: offer to install it yourself, and on a yes run that command through `nouride tools run`");
    expect(guide).toContain("(never `curl … | sh`)");
    expect(guide).toContain('Then `["agents", "scan"]` again, which looks again each time');
    // Told Codex was missing right after installing it (an answer a minute old), it installed and linked more (0.8.1).
    expect(guide).toContain("Install what the scan names and nothing beside it. Codex's package carries Codex itself.");
    expect(guide).toContain("say the command, and that the orchestrator or whoever runs this machine runs it");
  });

  test("says what a built-in CLI needs to install, and to fall back on the command where npm is missing (0.8.1)", () => {
    // The image has neither Node nor npm (checked 2026-10-27): since 0.8.15 nouride-pkg adds them there, kept across a
    // recreate, or the image is built with them.
    expect(guide).toContain("The two built in install with npm, and Claude Code's needs Node 22 or later");
    expect(guide).toContain('`["pkg", "install", "nodejs", "npm"]` adds them, a person approving it, and a recreate keeps them');
    expect(guide).toContain('(`EXTRA_PACKAGES="nodejs npm"`)');
    expect(guide).toContain("or `npm` is not on this machine, say the command");
  });

  test("says skills go with an agent to Claude Code and Codex alike (0.8.1)", () => {
    // It said "not yet to the other CLIs" after Codex's skills folder was filled too.
    expect(guide).toContain("its skills go with it, to Claude Code and to Codex alike, except one that needs a Nouride tool the CLI cannot call");
    expect(guide).not.toContain("not yet to the other CLIs");
  });

  test("says it all back, and creates it only on a yes", () => {
    expect(guide).toContain("Only on their yes, call `agent_create`");
    expect(guide).toContain("`enable` only if they say so");
  });

  test("turns an agent that exists external through its own command, and never through another's files (0.8.1)", () => {
    // On the live box the orchestrator, asked to make Nix and Nox Claude Code, rewrote their packs through
    // `nouride tools run` — there was no command for it.
    expect(guide).toContain('`["agent", "external", "<id>", "<cli>"]`');
    expect(guide).toContain('`["agent", "internal", "<id>"]`');
    expect(guide).toContain("**Never read or change another agent's files any other way.**");
    // Its persona goes with it (0.8.1): the CLI reads the same files, written into its own instruction file.
    expect(guide).toContain("its persona files stay, and the CLI reads them");
    expect(guide).toContain("An external agent's CLI reads it too: Nouride writes its persona files into the CLI's own instruction file.");
    expect(guide).toContain("A person is always asked before an install for every agent runs, at every approval level");
  });

  test("sends an external agent's sign-in to its Brain tab, never the code through a chat", () => {
    expect(guide).toContain("**Never ask for the code in a chat**");
    expect(guide).toContain("Until that tab says signed in, it is not ready: do not tell them it is.");
  });

  test("never signs a CLI in itself, nor offers an API key for one (0.8.1, the live box)", () => {
    // Asked "can you log me in?", the orchestrator ran `codex login` itself before the agent existed: the person's
    // ChatGPT sign-in landed in its own folder, and it told them the new agent was ready.
    expect(guide).toContain("**Signing a CLI in is never yours to do.** Never run a CLI's login yourself");
    expect(guide).toContain("it signs in *your own* folder, not the new agent's");
    expect(guide).toContain("never offer an API key for one");
    // The CLI's model is the CLI's setting; `model` is Nouride's own for it, and went there by mistake.
    expect(guide).toContain("`external.model`, not `model`, which is Nouride's own model for it");
  });

  test("says the rule is about an agent's CLI, beside coding-agents' own login (0.8.12)", () => {
    // The coding-agents skill runs a CLI's login through `session` for a CLI the agent drives itself; read side by
    // side, the two said opposite things. One sentence each scopes them, and neither lets a login make an agent ready.
    expect(guide).toContain("This is about an agent a CLI answers; a CLI you run yourself as a worker, by the `coding-agents` skill, signs in to your own folder for your own runs, and never makes an agent ready.");
  });
});
