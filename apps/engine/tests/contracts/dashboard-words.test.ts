/**
 * The reader behind the dashboard's word inventory (`scripts/dashboard-words.ts`, 0.8.19): it finds what a person reads
 * on the dashboard and nothing else, so the sweep for technical wording and the contract test that holds it read the
 * same strings. A class name or a query key taken for wording would make the rule cry wolf; a toast or a confirmation
 * missed would let a command through.
 */

import { describe, expect, test } from "bun:test";
import { sources, technical, wordsIn, type Wording } from "../../../../scripts/dashboard-words.ts";

const read = (source: string, path = "fixture.tsx") => wordsIn(path, source);
const texts = (found: Wording[]) => found.map((word) => word.text);
/** How each was found, beside its words: a string the sentence test caught instead would pass a check of the words alone. */
const how = (found: Wording[]) => found.map((word) => `${word.where} ${word.text}`);

describe("what the inventory reads as wording", () => {
  test("JSX text, the props that are shown, and what a child renders through ?:, &&, || and a template", () => {
    const found = read(`
      export function Page({ busy, name }: { busy: boolean; name: string }) {
        return (
          <Card title="Your agents" description={busy ? "Working on it" : "Nothing running"}>
            <input placeholder="Search agents" aria-label="Search the agents" className="input input-sm" />
            <p>Every agent you made.</p>
            {busy && "Still working"}
            {name || "No name yet"}
            {\`Hello \${name}, welcome\`}
          </Card>
        );
      }
    `);
    expect(how(found)).toEqual([
      "prop:title Your agents",
      "prop:description Working on it",
      "prop:description Nothing running",
      "prop:placeholder Search agents",
      "prop:aria-label Search the agents",
      "text Every agent you made.",
      "child Still working",
      "child No name yet",
      "child Hello {}, welcome",
    ]);
  });

  test("toasts, a confirmation's words, a choice's label, an error the page throws, and a sentence anywhere else", () => {
    const found = read(`
      const CHOICES = [{ id: "latest", label: "Newest" }];
      const FAILED = "Could not save the schedule";
      export function useThing(toast: Toaster, confirm: Confirm) {
        toast.success("Saved", "From the next message.");
        toast.show({ message: "Allowed from now on", kind: "success" });
        void confirm({ title: "Delete it?", body: "It cannot be undone.", confirmLabel: "Delete" });
        const onClick = () => setError("Could not reach the server");
        throw new Error("the page could not load");
      }
    `, "fixture.ts");
    expect(texts(found)).toEqual([
      "Newest",
      "Could not save the schedule",
      "Saved",
      "From the next message.",
      "Allowed from now on",
      "Delete it?",
      "It cannot be undone.",
      "Delete",
      "Could not reach the server",
      "the page could not load",
    ]);
    expect(found.map((word) => word.where)).toEqual(["key:label", "sentence", "toast", "toast", "toast", "key:title", "key:body", "key:confirmLabel", "sentence", "error"]);
  });

  test("a lowercase phrase a helper returns is wording; a class list kept in a constant is not", () => {
    const found = read(`
      const TONE = "btn btn-ghost btn-sm rounded-xl";
      export function heading(via: string): string {
        if (via === "cli stopped") return "a restart stopped a command its coding CLI had left running";
        return "the daemon started this turn";
      }
    `, "fixture.ts");
    expect(how(found)).toEqual([
      "sentence a restart stopped a command its coding CLI had left running",
      "sentence the daemon started this turn",
    ]);
  });

  test("code is not wording: class lists, routes, keys, a value compared against, an import, a type", () => {
    const found = read(`
      import { api } from "@/commons/lib/api";
      type Kind = "Gateway Token";
      export function Row({ kind }: { kind: Kind }) {
        const query = useQuery({ queryKey: ["cli-accounts"], queryFn: api.status });
        const tone = cn("btn btn-ghost", kind === "Gateway Token" && "text-error");
        return <Link to="/chat" className="link link-hover" href="https://example.test/Some Page">{kind === "Daemon Config" ? null : null}</Link>;
      }
    `);
    expect(texts(found)).toEqual([]);
  });

  test("a Details section, shown as code, and a line kept with its reason", () => {
    const found = read(`
      export function Card({ install }: { install: string }) {
        return (
          <div>
            <p>Claude Code is not set up on this server yet.</p>
            <details>
              <summary>Details</summary>
              <p>It installs with the ACP adapter.</p>
            </details>
            <Details>
              <p>Its config.toml names it.</p>
            </Details>
            <details>
              <summary>Or install it yourself</summary>
              <p>
                Run the daemon by hand.
              </p>
            </details>
            <p>Run <code>nouride doctor</code> first.</p>
            <p>Bot token {/* plain-words-ok: what BotFather calls it */}</p>
          </div>
        );
      }
    `);
    const at = (text: string) => found.find((word) => word.text === text)!;
    expect(at("Claude Code is not set up on this server yet.").inDetails).toBe(false);
    expect(at("It installs with the ACP adapter.").inDetails).toBe(true);
    expect(at("Its config.toml names it.").inDetails).toBe(true);
    // Only a summary that reads "Details" makes a Details section.
    expect(at("Run the daemon by hand.").inDetails).toBe(false);
    // A text's line is its first word's, not the line its tag ends on.
    expect(at("Run the daemon by hand.").line).toBe(16);
    expect(at("nouride doctor").inCode).toBe(true);
    expect(at("Bot token").kept).toBe(true);
    expect(at("Run the daemon by hand.").kept).toBe(false);
  });
});

describe("what it calls technical", () => {
  const why = (text: string, inCode = false) => technical({ text, inCode });

  test("a command, a flag, a file name, a path, and text shown as code", () => {
    expect(why("Run nouride skills drafts to see them.")).toBe("a command");
    expect(why("Pipe it with --stdin.")).toBe("a flag");
    expect(why("It is written to config.toml.")).toBe("a file name");
    expect(why("Each skill has a SKILL.md.")).toBe("a file name");
    expect(why("Kept in data/secrets.json.")).toBe("a file name");
    expect(why("Kept under /srv/nouride.")).toBe("a path");
    expect(why("journalctl -u nouride", true)).toBe("shown as code");
  });

  test("the internal words, install as a noun but never the verb, line as a line of releases", () => {
    for (const text of ["Restart the daemon?", "Live gateways", "The snapshots hold these", "sealed to your passphrase", "the payload", "MCP servers", "the CLI reports none", "Run it in a CLI", "the ACP adapter", "the registry", "the config", "Make a token", "What this install is", "on the long-term line"]) {
      expect(`${text}: ${why(text)}`).toBe(`${text}: an internal word`);
    }
    expect(why("Ask Nouva to install it")).toBeNull();
    expect(why("Claude Code is installed")).toBeNull();
    expect(why("Shift+Enter for a new line")).toBeNull();
    expect(why("Nouride does not share its login")).toBeNull();
  });

  test("a section of the config file, a setting's name as the file writes it, and git's words (0.8.20)", () => {
    // The two the server said on the dashboard on 2026-11-05.
    expect(why("semantic search is off: it needs [memory.semantic] enabled, provider and model")).toBe("a section of the config file");
    expect(why("Its folder holds work nobody committed. Commit it there first.")).toBe("a git word");
    expect(why("person must be someone in [[people]] with a key")).toBe("a section of the config file");
    expect(why("pass_model is a tier, so pass_provider goes")).toBe("a setting's name");
    expect(why("give agent_id, gateway_id and chat_id together")).toBe("a setting's name");
    expect(why("Its worktree's branch")).toBe("a git word");
    expect(why("git worktree add refused")).toBe("a git word");
    // Everyday words that look like them, and an id, are not.
    expect(why("Merge #travel into #trips?")).toBeNull();
    expect(why("The branch it works on, when the folder keeps a history of its changes.")).toBeNull();
    expect(why("Install from a repository or URL")).toBeNull();
    expect(why("Delete mission msn_3d28e0?")).toBeNull();
    expect(why("Their name becomes [Forgotten] where others mention them")).toBeNull();
  });

  test("a coding CLI is the name the owner kept (2026-11-05), the Models page's tab", () => {
    expect(why("Coding CLIs")).toBeNull();
    expect(why("The Models page, under Coding CLIs, can ask for one.")).toBeNull();
    expect(why("Kuro answers through a coding CLI.")).toBeNull();
    expect(why("Its CLI reports none")).toBe("an internal word");
  });
});

test("the inventory reads the whole dashboard", () => {
  const files = sources();
  expect(files.length).toBeGreaterThan(300);
  expect(files.flatMap((path) => wordsIn(path)).length).toBeGreaterThan(3000);
});
