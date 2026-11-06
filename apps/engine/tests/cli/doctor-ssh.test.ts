/**
 * `doctor`'s hint about the agents' ssh connections (0.7.17): a config that names hosts and opens a new connection for
 * every `ssh` is told the three lines that reuse one — a hint, never a failure.
 */

import { expect, test } from "bun:test";
import { homeInPasswd } from "@nouride/runtime";
import { sshReuseCheck } from "@/cli/commands/doctor-checks.ts";

test("hosts with no reuse get the hint, as a warning and never a failure", () => {
  const check = sshReuseCheck("Host proxmox\n    HostName 192.0.2.5\n    User root\n\nHost nas\n    User admin\n");
  expect(check).toMatchObject({ level: "warn", message: expect.stringContaining("2 host(s)"), hint: expect.stringContaining("ControlMaster auto") });
});

test("nothing to say with reuse on, with no host, or with no config to read", () => {
  expect(sshReuseCheck("Host *\n    ControlMaster auto\n    ControlPath ~/.ssh/cm-%C\nHost proxmox\n    User root\n")).toBeNull();
  expect(sshReuseCheck("# nothing yet\n")).toBeNull();
  expect(sshReuseCheck(null)).toBeNull();
});

test("the config is found where ssh reads it: the home /etc/passwd gives the data's owner", () => {
  const passwd = "root:x:0:0:root:/root:/bin/bash\nnouride:x:998:998::/home/nouride:/usr/sbin/nologin\n";
  expect(homeInPasswd(passwd, 998)).toBe("/home/nouride");
  expect(homeInPasswd(passwd, 1234)).toBeNull();
});
