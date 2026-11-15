/**
 * What a coding CLI runs on, in the words a person reads: its own version on the badge, what carries and runs
 * it under that, a warning where the runtime is too old, the rest for Details. The badge said "installed" and no version,
 * because the one version read was the connector's.
 */

import { describe, expect, test } from "bun:test";
import type { CliPart } from "@nouride/wire";
import { partsWords } from "@/commons/lib/cli-parts";

const PARTS: CliPart[] = [
  { kind: "cli", name: "Claude Code", package: "@anthropic-ai/claude-agent-sdk", version: "2.1.323" },
  { kind: "connector", name: "@agentclientprotocol/claude-agent-acp", package: "@agentclientprotocol/claude-agent-acp", version: "0.107.0" },
  { kind: "runtime", name: "Node.js", version: "24.15.0", needs: ">=22", tooOld: false },
  { kind: "dependency", name: "@agentclientprotocol/sdk", package: "@agentclientprotocol/sdk", version: "2.6.0" },
  { kind: "dependency", name: "zod", package: "zod" },
];

describe("a coding CLI's parts in words", () => {
  test("the badge is the CLI's own version, never its connector's", () => {
    expect(partsWords(PARTS)).toEqual({
      own: "Claude Code 2.1.323",
      inside: "Runs in claude-agent-acp 0.107.0, on Node.js 24.15.0.",
      tooOld: null,
      // A dependency whose version was not read says so.
      rest: ["@agentclientprotocol/sdk 2.6.0", "zod (version not read)"],
    });
  });

  test("a CLI whose own version was not read has none on its badge", () => {
    const unread = PARTS.map((part) => (part.kind === "cli" ? { kind: part.kind, name: part.name } : part)) as CliPart[];
    expect(partsWords(unread).own).toBeNull();
    // The connector's version is not put in its place.
    expect(partsWords(PARTS.filter((part) => part.kind !== "cli")).own).toBeNull();
  });

  test("a runtime under what the connector asks for is a warning, in plain words", () => {
    const old = PARTS.map((part) => (part.kind === "runtime" ? { ...part, version: "20.11.1", tooOld: true } : part));
    expect(partsWords(old).tooOld).toBe("Node.js 20.11.1 is too old for claude-agent-acp, which needs 22 or newer. Whoever runs this server needs to update Node.js.");
  });

  test("nothing read is nothing said", () => {
    expect(partsWords(undefined)).toEqual({ own: null, inside: null, tooOld: null, rest: [] });
    expect(partsWords([{ kind: "connector", name: "x-acp", package: "x-acp", version: "1.0.0" }]).inside).toBe("Runs in x-acp 1.0.0.");
  });
});
