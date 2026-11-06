/**
 * The home `/etc/passwd` gives, which is where OpenSSH reads `~/.ssh/config` — never `$HOME`. Bun's
 * `os.userInfo().homedir` answers `$HOME`, and the first version used it: on a Raspberry Pi it agreed with the service's
 * HOME every time, so the ssh bridge never ran (2026-10-18).
 */

import { afterEach, expect, test } from "bun:test";
import { homeInPasswd, passwdHome } from "../src/index.ts";

const saved = process.env.HOME;
afterEach(() => {
  process.env.HOME = saved;
});

test("a HOME the process was given is not the passwd home", () => {
  process.env.HOME = "/nowhere/agents-home";
  expect(passwdHome()).not.toBe("/nowhere/agents-home");
});

test("the home is the sixth field of the line with that uid", () => {
  const passwd = "root:x:0:0:root:/root:/bin/bash\nnouride:x:998:998::/home/nouride:/usr/sbin/nologin\n";
  expect(homeInPasswd(passwd, 998)).toBe("/home/nouride");
  expect(homeInPasswd(passwd, 0)).toBe("/root");
  expect(homeInPasswd(passwd, 1234)).toBeNull();
});
