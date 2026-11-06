/**
 * `nouride <command> --help`, and `nouride chat` given a flag.
 *
 * `nouride chat --help` used to read `--help` as an agent id, print "addressing: --help" and wait on
 * stdin — which over ssh never closes, so every attempt left a process behind on the live box. And
 * `nouride secret --help` failed outright: six such errors in two weeks of an agent exploring the CLI.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { chat } from "@/cli/commands/chat.ts";
import { usageFor } from "@/cli/usage.ts";

const plain = (text: string | null) => (text ?? "").replace(/\x1b\[[0-9;]*m/g, "");

describe("usageFor", () => {
  test("a command's own lines, and only its own", () => {
    const secret = plain(usageFor("secret"));
    expect(secret).toContain("nouride secret set <name> --stdin");
    expect(secret).not.toContain("nouride gateway");
  });

  test("continuation lines stay with the command they continue", () => {
    // `setup`'s description runs over several indented lines; cutting after the first would drop
    // the part about never taking a key as an argument.
    expect(plain(usageFor("setup"))).toContain("argument, where it would land in shell history");
  });

  test("chat is answered from here now, not by opening a chat", () => {
    expect(plain(usageFor("chat"))).toContain("nouride chat [agent]");
  });

  test("a command the help does not know is null, so the caller can say so", () => {
    expect(usageFor("nope")).toBeNull();
  });
});

describe("nouride chat with a flag", () => {
  const untouchable = {
    baseUrl: "http://127.0.0.1:0",
    get: async () => {
      throw new Error("the daemon was contacted");
    },
  } as never;

  test("is refused, not taken for an agent, and never reaches the daemon", async () => {
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      // A flag where an agent id goes is asking wrongly: exit 2, not a failure (D5).
      await expect(chat(untouchable, ["--verbose"])).rejects.toThrow("exit 2");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
