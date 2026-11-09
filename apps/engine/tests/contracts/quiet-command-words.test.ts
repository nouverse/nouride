/**
 * What an agent and a person read about a scheduled command's quiet run (0.8.17): a run that prints nothing
 * sends nothing, and `--then agent` wakes the agent only when the command printed something. A prompt is behaviour,
 * so the words that carry it are asserted where they are read: the schedule tool, `nouride help`, the docs, the
 * built-in skill that schedules a morning check. The homelab-ops skill said `--then agent` cost a model call on every
 * run, even the quiet ones, and told the agent to reply with nothing to an empty report it is no longer woken for.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { usageFor } from "@/cli/usage.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

describe("the words about a scheduled command's quiet run", () => {
  test("the schedule tool says a command that prints nothing sends nothing", () => {
    const tool = createScheduleTool({ store: {} as never, timezone: () => "UTC", agentExists: () => true, post: async () => true });
    const command = (tool.definition.parameters as { properties: Record<string, { description: string }> }).properties.command!;
    expect(command.description).toBe("A shell line; what it prints is sent, and nothing at all when it prints nothing.");
  });

  test("`nouride help cron` says --then agent wakes the agent with what it printed, and a quiet run sends nothing", () => {
    const help = (usageFor("cron") ?? "").replace(/\s+/g, " ");
    expect(help).toContain("--then agent to wake the agent with what it printed; a run that prints nothing sends nothing");
  });

  test("the docs say it, in English and Indonesian", () => {
    expect(read("docs/CLI.md")).toContain("A run that prints nothing sends nothing and runs no turn");
    expect(read("docs/SPEC.md")).toContain("A run that prints nothing runs no turn and sends nothing (0.8.17)");
    expect(read("apps/site/src/content/docs/en/docs/manual/schedule.md")).toContain("A run that prints nothing sends nothing, and with `--then agent` wakes nobody");
    expect(read("apps/site/src/content/docs/id/docs/manual/schedule.md")).toContain("dengan `--then agent` tidak membangunkan siapa pun");
    expect(read("apps/site/src/content/docs/en/docs/cli/cron.md")).toContain("A run that prints nothing wakes nobody and sends nothing");
  });

  test("the homelab-ops skill no longer says a quiet run costs a model call", () => {
    const skill = read("content/skills/homelab-ops/SKILL.md");
    expect(skill).toContain("A quiet run prints nothing and wakes nobody, so a model call is spent only on a morning something is wrong.");
    expect(skill).not.toContain("even the quiet ones");
  });
});
