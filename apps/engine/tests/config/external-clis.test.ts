/**
 * `[[external_clis]]` (0.8.1): a coding CLI the person adds beside the two built in — read as a row of the same
 * shape, with the defaults a built-in one spells out, and refused at load, naming the entry, where it would start the
 * wrong program, take a built-in's name or write outside the folder the CLI works in.
 */

import { describe, expect, test } from "bun:test";
import { addLogSink } from "@nouride/shared";
import { readConfigText } from "@/modules/config/global/index.ts";
import { cliRows, parseExternalClis } from "@/modules/config/global/external-clis.ts";

const BASE = `[providers.nougate]
kind = "openai"
base_url = "https://nougate.test/v1"
api_key = "nougate_key"

[llm.defaults]
provider = "nougate"
model = "pro"
`;

/** What loading said of a person's row with a built-in one's id. */
const said: unknown[] = [];
addLogSink((entry) => void (entry.message.includes("has the id of one built in") && said.push(entry.data)));

const read = (rows: string) => readConfigText(`${BASE}\n${rows}`, "config.toml").externalClis;

describe("a CLI the person adds", () => {
  test("is read as a row, with the defaults said", () => {
    expect(read(`[[external_clis]]\nid = "opencode"\ncommand = "opencode"\nargs = ["acp"]\n`)).toEqual([
      { id: "opencode", name: "opencode", command: "opencode", args: ["acp"], install: "install opencode where the daemon's user finds it on its PATH", versionArgs: ["--version"], instructionFile: "AGENTS.md" },
    ]);
    expect(readConfigText(BASE, "config.toml").externalClis).toEqual([]);
  });

  test("carries what it says of itself: its profile variable, its modes, its sign-in", () => {
    const [row] = read(`[[external_clis]]
id = "my-cli"
name = "My CLI"
command = "/opt/my-cli/bin/my-cli"
profile_env = "MY_CLI_HOME"
instruction_file = "MY.md"
login = ["auth", "login"]
login_note = "It prints a code."
status = ["auth", "status"]
signed_out = ["please log in"]
modes = { folder = "free", all = "ask" }
`);
    expect(row).toMatchObject({ name: "My CLI", profileEnv: "MY_CLI_HOME", instructionFile: "MY.md", login: ["auth", "login"], loginNote: "It prints a code.", status: ["auth", "status"], signedOut: ["please log in"], modes: { folder: "free", all: "ask" } });
  });

  test("of the id a built-in row marked Experimental has is kept in that row's place, said once at load: an install that had one goes on", () => {
    said.splice(0);
    {
      // Read as a start reads it, which says what it finds: the config check holds those words and says them too.
      const own = parseExternalClis([{ id: "cursor", name: "My Cursor", command: "my-cursor", args: ["acp"] }]);
      expect(own).toMatchObject([{ id: "cursor", name: "My Cursor", command: "my-cursor" }]);
      expect(said).toEqual([{ cli: "cursor", built_in: "Cursor CLI" }]);
      const rows = cliRows(own);
      expect(rows.filter((row) => row.id === "cursor")).toEqual([own[0]!]);
      expect(rows.map((row) => row.id)).toEqual(["claude-code", "codex", "antigravity", "grok", "cursor"]);
    }
  });

  test("is refused at load, naming the entry, where it would run the wrong thing", () => {
    expect(() => read(`[[external_clis]]\nid = "codex"\ncommand = "my-codex"\n`)).toThrow(`[[external_clis]] "codex" is a built-in CLI's id`);
    expect(() => read(`[[external_clis]]\nid = "nocmd"\n`)).toThrow(`[[external_clis]] "nocmd" command is required`);
    expect(() => read(`[[external_clis]]\nid = "Bad Id"\ncommand = "x"\n`)).toThrow("[[external_clis]] #1 id must be lowercase");
    expect(() => read(`[[external_clis]]\nid = "a"\ncommand = "x"\n\n[[external_clis]]\nid = "a"\ncommand = "y"\n`)).toThrow(`[[external_clis]] id "a" is written twice`);
    expect(() => read(`[external_clis]\nid = "a"\n`)).toThrow("[[external_clis]] must be a list of tables");
    expect(() => read(`[[external_clis]]\nid = "a"\ncommand = "x"\nmodes = { careful = "ask" }\n`)).toThrow(`modes.careful is not a preset`);
    expect(() => read(`[[external_clis]]\nid = "a"\ncommand = "x"\nargs = "acp"\n`)).toThrow(`[[external_clis]] "a" args must be a list of strings`);
    expect(() => read(`[[external_clis]]\nid = "a"\ncommand = "x"\nprofile_env = "my-home"\n`)).toThrow("profile_env must be a variable name");
  });

  test("writes its instructions in the folder it works in, never a path out of it", () => {
    expect(() => read(`[[external_clis]]\nid = "a"\ncommand = "x"\ninstruction_file = "../.bashrc"\n`)).toThrow("instruction_file must be a file name");
    expect(() => read(`[[external_clis]]\nid = "a"\ncommand = "x"\ninstruction_file = "sub/AGENTS.md"\n`)).toThrow("instruction_file must be a file name");
  });
});
