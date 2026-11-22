/**
 * How the chat commands' answers are laid out, and what each command says of itself.
 *
 * Several were hard to read on a phone: uses run together on one line parted by "·", a sentence broken by hand in
 * its middle, a list under dashes with its id first. And `/help` was a list typed by hand, which by the time it was
 * read lacked ten commands that all answered. The answers share a layout now, and `/help` is made of the commands.
 */

import { describe, expect, test } from "bun:test";
import { agentHooks } from "@/modules/hooks/builtins/agent.ts";
import { approvalHooks } from "@/modules/hooks/builtins/approvals.ts";
import { HELP_GROUPS, helpSaid } from "@/modules/hooks/builtins/meta.ts";
import { titled, uses } from "@/modules/hooks/format.ts";
import { HookRegistry, type HookContext } from "@/modules/hooks/registry.ts";

const registry = new HookRegistry({} as never);
const listed = registry.list().filter((hook) => !hook.hidden);

describe("the shared layout", () => {
  test("a command's uses are a line each: the use as code, then what it does", () => {
    expect(uses([["/x", "does one thing"], ["/x <id>", "does another"]])).toBe("`/x`: does one thing\n`/x <id>`: does another");
  });

  test("a list's title is bold, with its count where it has one", () => {
    expect(titled("Agents", 3)).toBe("**Agents** (3)");
    expect(titled("Commands for Nouva")).toBe("**Commands for Nouva**");
  });
});

describe("what each command says of itself", () => {
  // It is shown in a chat app's own menu, which draws no marks, and Discord takes a hundred characters.
  test("in plain words: no code marks, no bold, and short enough for every menu", () => {
    const marked = listed.filter((hook) => /[`*_]/.test(hook.description.replace(/\/[a-z_-]+/g, ""))).map((hook) => hook.command);
    expect(marked).toEqual([]);
    expect(listed.filter((hook) => hook.description.length > 100).map((hook) => `${hook.command}: ${hook.description.length}`)).toEqual([]);
    expect(listed.filter((hook) => hook.description.trim() === "").map((hook) => hook.command)).toEqual([]);
  });
});

describe("/help", () => {
  const text = helpSaid("Nouva", registry.list());
  const lines = text.split("\n");

  test("is made of the commands: every one that is not hidden is in it, with what it says of itself", () => {
    for (const hook of listed.filter((one) => one.command !== "/help")) expect(lines).toContain(`\`${hook.command}\`: ${hook.description}`);
    // The ten the hand-typed list had lost, by name.
    for (const command of ["/mission", "/helpers", "/backgrounds", "/effort", "/notes", "/schedule", "/secret", "/sleep", "/wake", "/drafts"]) expect(text).toContain(`\`${command}\`: `);
  });

  test("leaves out a hidden name, which answers and is taught to nobody", () => {
    expect(registry.has("/goal")).toBe(true);
    expect(text).not.toContain("/goal");
    expect(text).not.toContain("/daemon_restart");
  });

  test("every command is in a group, each once: one added later cannot be left out, nor fall under More unnoticed", () => {
    const grouped = HELP_GROUPS.flatMap(([, commands]) => commands);
    expect(listed.map((hook) => hook.command).filter((command) => command !== "/help" && !grouped.includes(command))).toEqual([]);
    expect(grouped.filter((command, index) => grouped.indexOf(command) !== index)).toEqual([]);
    // And no group names a command that is not there.
    expect(grouped.filter((command) => !registry.has(command))).toEqual([]);
    expect(text).not.toContain("**More**");
  });

  test("a command in no group is still listed, under More", () => {
    const more = helpSaid("Nouva", [...registry.list(), { command: "/later", description: "Added later" }]);
    expect(more.split("\n").slice(-2)).toEqual(["**More**", "`/later`: Added later"]);
  });

  test("laid out to be read: a title, then a group to a block under its name in bold, a blank line between blocks", () => {
    expect(lines.slice(0, 3)).toEqual(["**Commands for Nouva**", "", `**${HELP_GROUPS[0]![0]}**`]);
    const titles = lines.filter((line) => /^\*\*[^*]+\*\*$/.test(line)).slice(1);
    expect(titles).toEqual(HELP_GROUPS.map(([title]) => `**${title}**`));
    for (const title of titles.slice(1)) expect(lines[lines.indexOf(title) - 1]).toBe("");
    // A command to a line: none holds two.
    expect(lines.filter((line) => (line.match(/`\//g) ?? []).length > 1)).toEqual([]);
  });
});

describe("/approvals", () => {
  const approvals = approvalHooks.find((hook) => hook.command === "/approvals")!;
  const ask = async (agentLevel: string | undefined) =>
    (await approvals.handler({ agent: { config: { id: "nouva", displayName: "Nouva", ...(agentLevel ? { approvals: agentLevel } : {}) } }, gatewayId: "telegram:nouva", chatId: "1", senderId: "u1", args: [], envelope: { chatType: "dm" }, deps: { daemonApprovals: "careful" } } as unknown as HookContext)).reply ?? "";

  test("the level, what it means and who set it are a line each, then how it is changed", async () => {
    expect((await ask(undefined)).split("\n")).toEqual([
      "Approvals: `careful`",
      "A new command or change asks once, and deletes, teardowns, force-pushes and the rest of the fixed list every time.",
      "The daemon default, because neither this agent nor you have set one.",
      "",
      "`/approvals balanced`: stop being asked about ordinary calls",
      "`/approvals careful`: be asked again",
    ]);
  });

  test("a level set on the agent says so once, and where it is changed", async () => {
    const text = await ask("trusted");
    expect(text.match(/Set on this agent/g)).toHaveLength(1);
    expect(text.split("\n").at(-1)).toBe("Change it in the dashboard, under this agent.");
  });
});

describe("/agents and /grants", () => {
  const agent = (id: string, displayName: string, more: Record<string, unknown> = {}) => ({ config: { id, displayName, enabled: true, ...more } });
  const ctx = (deps: Record<string, unknown>): HookContext => ({ agent: agent("nouva", "Nouva"), gatewayId: "telegram:nouva", chatId: "1", senderId: "u1", args: [], envelope: { chatType: "dm" }, deps }) as unknown as HookContext;
  const run = async (hooks: typeof agentHooks, command: string, c: HookContext) => (await hooks.find((hook) => hook.command === command)!.handler(c)).reply ?? "";

  test("/agents: a title with how many, then an agent to a line that leads with its name, its id as code", async () => {
    const all = [agent("nouva", "Nouva", { emoji: "🐈" }), agent("nix", "Nix"), agent("old", "Old", { enabled: false })];
    const text = await run(agentHooks, "/agents", ctx({ registry: { all: () => all, status: (id: string) => (id === "nix" ? "paused" : "running"), loadFailures: () => [{ id: "broken", error: "config.toml: [llm] model is missing" }] } }));
    expect(text.split("\n")).toEqual([
      "**Agents** (3)",
      "• 🐈 **Nouva** `nouva` · running",
      "• **Nix** `nix` · paused",
      "• **Old** `old` · disabled",
      "",
      "**Did not load** (1)",
      "• `broken`: config.toml: [llm] model is missing",
    ]);
  });

  test("/grants: a command and its id on lines of their own, a blank line between permissions, the two ways back a line each", async () => {
    const list = [
      { id: "grt_1", commandText: "git -C /srv/app pull --ff-only", useCount: 4 },
      { id: "grt_2", commandText: "echo `date`", useCount: 0 },
    ];
    const text = await run(approvalHooks, "/grants", ctx({ grants: { list: () => list } }));
    expect(text.split("\n")).toEqual([
      "**Commands I no longer ask about** (2)",
      "",
      "`git -C /srv/app pull --ff-only`",
      "`grt_1` · used 4×",
      "",
      // A backtick in a command does not end the code it is shown as.
      "`echo 'date'`",
      "`grt_2` · never used",
      "",
      "`/grants revoke <id>`: ask about that one again",
      "`/grants revoke all`: ask about all of them again",
    ]);
  });
});
