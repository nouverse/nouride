/**
 * Tool combinations that are legal, and almost never what the author meant.
 *
 * Both checks here have the same shape and the same reason for existing: a pack enumerates its tools,
 * the list is missing one name, and nothing about the running agent shows it. The cost only appears
 * later, as behaviour nobody connects back to a config file — so they are reported at boot, named
 * agent by agent, while somebody is still looking at the terminal. Neither is a refusal and neither
 * merges the missing name in: a pack whose tools are enumerated is a pack whose author had opinions.
 *
 * Both were found on the live install rather than reasoned out, and both are recorded below.
 */

import { describe, expect, test } from "bun:test";
import { agentsWithMemoryButNoPeople, agentsWithMemoryButNoSearch, agentsWithPeopleButNoNotes, agentsWithShellButNoCli } from "@/boot/preflight.ts";

const agent = (id: string, enabled: string[]) => ({ config: { id, tools: { enabled } } });

/**
 * An agent with a shell but not the CLI tool, which is an oversight every time it means anything.
 *
 * Watched on the live install: six packs, each holding `exec`, none listing `nouride`. Their prompts
 * told them to run `nouride config check` and `nouride doctor` — and the section that explains what
 * the CLI *is* never rendered, because that block is gated on the tool. So the daemon's own control
 * surface was reached by guessing, or by reading SQLite, or not at all.
 *
 * The combination withholds no authority. With `exec` the CLI is already reachable — run it inside
 * exec's exact sandbox and `nouride agents` prints the live agent list. What it withholds is the typed
 * path, the per-call gate, the audit row, and the teaching.
 */
describe("shell without the CLI tool", () => {
  test("is reported", () => {
    expect(agentsWithShellButNoCli([agent("nouva", ["read", "exec"])])).toEqual(["nouva"]);
  });

  test("is not reported once the tool is listed", () => {
    expect(agentsWithShellButNoCli([agent("nouva", ["read", "exec", "nouride"])])).toEqual([]);
  });

  /**
   * The intentional case stays silent, and this is the distinction the whole check rests on.
   *
   * `DEFAULT_TOOLS` documents dropping `nouride` as a real choice: "a pack that wants an agent with no
   * reach into the daemon drops it". That choice only means something alongside dropping the shell —
   * so an agent with neither is coherent, and warning about it would be noise the operator cannot
   * silence by doing the right thing.
   */
  test("an agent with neither is left alone", () => {
    expect(agentsWithShellButNoCli([agent("reader", ["read", "glob", "grep"])])).toEqual([]);
  });

  test("every affected agent is named, not just the first", () => {
    // Six packs had it. A warning that names one sends the operator to fix one file.
    const found = agentsWithShellButNoCli([
      agent("nouva", ["exec"]),
      agent("nox", ["exec", "nouride"]),
      agent("nero", ["exec", "read"]),
      agent("reader", ["read"]),
    ]);
    expect(found).toEqual(["nouva", "nero"]);
  });

  test("no agents, nothing to say", () => {
    expect(agentsWithShellButNoCli([])).toEqual([]);
  });
});

/**
 * The same shape one file over, and the same live failure behind it.
 *
 * Somebody introduced themselves to `ren` on Telegram and the turn's only tool call was
 * `memory_write` with `## User — **Name:** Gading`. The pack listed `memory_write` and not
 * `person_record`, so the one place the name could go was the one place the identity line never
 * reads. Checked at boot rather than per turn: the fact is static, and the operator can only act on
 * it while they are looking at the terminal.
 */
describe("memory without a way to record a person", () => {
  test("is reported", () => {
    expect(agentsWithMemoryButNoPeople([agent("ren", ["read", "memory_write"])])).toEqual(["ren"]);
  });

  test("is not reported once the tool is listed", () => {
    expect(agentsWithMemoryButNoPeople([agent("ren", ["memory_write", "person_record"])])).toEqual([]);
  });

  /**
   * A read-only agent that keeps no memory has nowhere to misfile a name, so there is nothing to say.
   * Warning here would be noise an operator cannot silence by doing the right thing.
   */
  test("an agent with neither is left alone", () => {
    expect(agentsWithMemoryButNoPeople([agent("reader", ["read", "glob"])])).toEqual([]);
  });

  test("every affected agent is named, not just the first", () => {
    // Six packs on the live box had exactly this, which is why it is a boot check and not a comment.
    const found = agentsWithMemoryButNoPeople([
      agent("nouva", ["memory_write"]),
      agent("nox", ["memory_write", "person_record"]),
      agent("nero", ["memory_write", "read"]),
      agent("reader", ["read"]),
    ]);
    expect(found).toEqual(["nouva", "nero"]);
  });
});

describe("memory without memory_search", () => {
  test("a pack that reads memory but cannot search it, once memory is on, is named", () => {
    expect(agentsWithMemoryButNoSearch([agent("nouva", ["memory_read", "memory_recent"])], true)).toEqual(["nouva"]);
    // `memory_recent` alone is a tool that no longer exists: nothing to warn about reading.
    expect(agentsWithMemoryButNoSearch([agent("nero", ["memory_recent"])], true)).toEqual([]);
  });

  test("silent with it, without either memory tool, or before memory is set up", () => {
    expect(agentsWithMemoryButNoSearch([agent("nouva", ["memory_read", "memory_search"])], true)).toEqual([]);
    expect(agentsWithMemoryButNoSearch([agent("reader", ["read"])], true)).toEqual([]);
    expect(agentsWithMemoryButNoSearch([agent("nouva", ["memory_read"])], false)).toEqual([]);
  });
});

/**
 * `person_notes` is new in 0.7.0, so every pack that lists its tools predates it — the six on the live
 * box among them. Such an agent can write down a name and nothing else about who somebody is.
 */
describe("recording people without their notes", () => {
  test("a pack that records people but cannot change their notes is named", () => {
    expect(agentsWithPeopleButNoNotes([agent("nouva", ["memory_write", "person_record"])])).toEqual(["nouva"]);
  });

  test("not once it lists the tool, and not a pack that records nobody", () => {
    expect(agentsWithPeopleButNoNotes([agent("nouva", ["person_record", "person_notes"])])).toEqual([]);
    expect(agentsWithPeopleButNoNotes([agent("reader", ["read"])])).toEqual([]);
  });
});

