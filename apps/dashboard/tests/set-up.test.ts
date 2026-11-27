/**
 * Set it up on a coding CLI's card, and the three their makers install with a script of their own:
 * Antigravity, Cursor and Grok Build had none, their install being said as a terminal's work for whoever runs the server.
 */

import { describe, expect, test } from "bun:test";
import { byInstaller, setUpMessage } from "@/commons/lib/set-up";

describe("Set it up", () => {
  test("an npm one has it, and one installed by its maker's script alike (each built-in's line: `cli-install.test.ts`)", () => {
    for (const install of ["npm i -g @agentclientprotocol/codex-acp", "nouride agents install antigravity", "nouride agents install cursor", "nouride agents install grok"]) {
      expect({ install, offered: byInstaller(install) }).toEqual({ install, offered: true });
    }
  });

  test("a person's own CLI that installs some other way does not: whoever runs the server does it", () => {
    expect(byInstaller("curl -fsSL https://example.com/install.sh | bash")).toBe(false);
    expect(byInstaller("nouride agents update codex")).toBe(false);
  });

  test("the orchestrator is asked by the command that installs it, where Nouride has one", () => {
    expect(setUpMessage("Antigravity", "nouride agents install antigravity")).toBe(
      "Please install Antigravity on this server with `nouride agents install antigravity`, and tell me when it is ready to sign in.",
    );
    expect(setUpMessage("Codex", "npm i -g @agentclientprotocol/codex-acp")).toContain("with what Nouride needs to use it as an agent (its ACP adapter)");
  });
});
