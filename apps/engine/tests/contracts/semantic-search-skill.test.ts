/**
 * Setting search by meaning up from a chat: the Semantic search card's "Ask Nouva" button writes the request, and the
 * built-in nouride skill is what the orchestrator reads to carry it out. Its guide carries the rules: ask where the
 * model should run before anything is installed, never run an installer script from the internet, say that a cloud
 * service is sent what is remembered, and switch it on with the one command that checks the model first. What is sent
 * to a model is behaviour: these are the words that carry it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_DIR = join(import.meta.dir, "../../../../content/skills/nouride");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
// As one line: where Markdown wraps a sentence is not part of what it says.
const guide = readFileSync(join(SKILL_DIR, "references/semantic-search.md"), "utf8").replace(/\s+/g, " ");

describe("setting search by meaning up from a chat", () => {
  test("the nouride skill is chosen for it, and points to its guide", () => {
    const description = skill.match(/^description: (.*)$/m)![1]!;
    expect(description).toContain("end to end, set up semantic search, and");
    expect(description).toContain("to set up semantic search or embeddings");
    expect(skill).toContain("`references/semantic-search.md`");
  });

  test("asks where the model should run before anything else: this machine, another of theirs, or a cloud service", () => {
    expect(guide).toContain("This is a conversation before it is a command.");
    for (const place of ["**On this machine.**", "**On another machine of theirs.**", "**A cloud service.**"]) expect(guide).toContain(place);
    expect(guide).toContain("look at what the machine has before you suggest it, and say what you found");
    // What leaves the machine is said out loud, and no price is quoted from memory.
    expect(guide).toContain("The text of what is remembered is sent to that service to be embedded, which is the thing to say out loud");
    expect(guide).toContain("do not quote one from memory");
  });

  test("installs only through the machine's own packages, asked first, and never pipes a script into a shell", () => {
    expect(guide).toContain("Say what you will install and wait for a yes");
    expect(guide).toContain('`["pkg", "check", "install", "ollama"]`');
    expect(guide).toContain('`["pkg", "install", "ollama"]` installs it, a person approving it');
    expect(guide).toContain("Do not pipe a script from the internet into a shell yourself: give the person that line, say that whoever runs this machine runs it");
    // A container loses what is installed inside it at the next update.
    expect(guide).toContain("**In a container**, do not install it inside");
  });

  test("a key is asked for in the chat and goes in through stdin", () => {
    expect(guide).toContain("ask the person for the key in the chat and store it yourself, through `stdin`, never in `args`");
  });

  test("switches it on with the command that checks the model first, and does not call it on before that says so", () => {
    expect(guide).toContain("`memory set semantic <provider>/<model>`");
    expect(guide).toContain("The daemon asks that model for one embedding before it switches anything on");
    expect(guide).toContain("Do not report it as on until the command says it saved.");
    expect(guide).toContain("`memory set semantic off` switches it off again.");
  });

  test("gives what was remembered before its vectors, and says what was done", () => {
    expect(guide).toContain("`memory embed` runs one now");
    expect(guide).toContain("Until an item has one it is still found by its words.");
    expect(guide).toContain("If it runs in the cloud, say again that what is remembered is sent there to be embedded.");
  });

  test("the three services it names are the ones the dashboard's own help names, with the same addresses and models", () => {
    const help = readFileSync(join(import.meta.dir, "../../../dashboard/src/modules/memories/embedding-help.tsx"), "utf8");
    for (const [baseUrl, model] of [["http://<its address>:11434/v1", "bge-m3"], ["https://api.openai.com/v1", "text-embedding-3-small"], ["https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-embedding-001"]] as const) {
      expect(help).toContain(`baseUrl: "${baseUrl}", model: "${model}"`);
      expect(guide).toContain(`\`${baseUrl}\` | \`${model}\``);
    }
  });
});
