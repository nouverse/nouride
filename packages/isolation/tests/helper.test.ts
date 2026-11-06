/**
 * What boot decides about agents' users, from what it can read — and the client's command line it then puts in
 * front of every agent's command.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientPrefix, findAgentUsers, groupsCommand, HELPER_BINARY, HELPER_SOCKET, helperUnits, putCommand } from "../src/index.ts";

const FOLDERS = {
  workspace: "/srv/nouride/.nouride/workspace",
  reads: ["/srv/nouride/.nouride/agents", "/srv/nouride/.nouride/jobs"] as [string, string],
  credentials: "/srv/nouride/.nouride/credentials",
};
const INFO = `version=0.1.0\nprotocol=1\nworkspace=${FOLDERS.workspace}\nreads=${FOLDERS.reads.join(":")}\ncredentials=${FOLDERS.credentials}\nlandlock=abi 4\n`;

const facts = (over: Partial<Parameters<typeof findAgentUsers>[0]> = {}) => ({
  platform: "linux",
  inContainer: false,
  root: false,
  folders: FOLDERS,
  binaryPresent: true,
  socketPresent: true,
  info: async () => ({ exitCode: 0, stdout: INFO, stderr: "" }),
  ...over,
});

const answering = (text: string) => async () => ({ exitCode: 0, stdout: text, stderr: "" });

describe("where agents' commands run", () => {
  test("through the socket, where the helper answers for these folders", async () => {
    const found = await findAgentUsers(facts());
    expect(found.users).toEqual({ through: "socket", binary: HELPER_BINARY, socket: HELPER_SOCKET, folders: FOLDERS });
    expect({ version: found.version, landlock: found.landlock }).toEqual({ version: "0.1.0", landlock: "abi 4" });
    expect(found.reason).toContain("its own user");
  });

  test("in the client itself where the daemon is root — a Box — with no socket to ask", async () => {
    const found = await findAgentUsers(facts({ root: true, socketPresent: false }));
    expect(found.users).toEqual({ through: "local", binary: HELPER_BINARY, folders: FOLDERS });
  });

  test("beside the daemon, with the reason, wherever the helper cannot be had or serves other folders", async () => {
    const cases: [Parameters<typeof findAgentUsers>[0], string][] = [
      [facts({ platform: "darwin" }), "not Linux"],
      [facts({ inContainer: true }), "the container is the boundary"],
      [facts({ binaryPresent: false }), "is not installed"],
      [facts({ socketPresent: false }), "nouride-run.socket is not running"],
      [facts({ info: async () => ({ exitCode: 125, stdout: "", stderr: "nouride-run: refused" }) }), "did not answer as one should (nouride-run: refused)"],
      [facts({ info: answering(INFO.replace("protocol=1", "protocol=2")) }), "speaks protocol 2"],
      [facts({ info: answering(INFO.replace(FOLDERS.workspace, "/elsewhere")) }), "serves the workspace /elsewhere"],
      [facts({ info: answering(INFO.replace(`reads=${FOLDERS.reads.join(":")}`, `reads=${FOLDERS.reads[0]}`)) }), "this config names /srv/nouride/.nouride/agents, /srv/nouride/.nouride/jobs"],
      [facts({ info: answering(INFO.replace(`credentials=${FOLDERS.credentials}`, "credentials=/old")) }), "the credentials directory /old"],
    ];
    for (const [input, reason] of cases) {
      const found = await findAgentUsers(input);
      expect({ users: found.users, reason: found.reason.includes(reason) ? reason : found.reason }).toEqual({ users: null, reason });
      expect(found.reason).toContain("run as the daemon's user");
    }
  });
});

describe("the client's command line", () => {
  const users = { through: "socket" as const, binary: HELPER_BINARY, socket: HELPER_SOCKET, folders: FOLDERS };

  test("names the socket, the agent, where it starts, where its pid goes and what Landlock gives back — then the command", () => {
    expect(clientPrefix(users, "nouva", { cwd: "/w/shared", pidFile: "/tmp/p.pid", landlock: "auto", writable: ["/srv/project"] })).toEqual([
      HELPER_BINARY, "exec", "--socket", HELPER_SOCKET, "--agent", "nouva", "--cwd", "/w/shared", "--pid-file", "/tmp/p.pid", "--landlock", "auto", "--writable", "/srv/project", "--",
    ]);
    expect(groupsCommand(users, "nouva", ["nr-creds"])).toEqual([HELPER_BINARY, "groups", "--socket", HELPER_SOCKET, "--agent", "nouva", "--group", "nr-creds"]);
  });

  test("a file the daemon writes for an agent is the helper's `put`, run as that agent", () => {
    const line = putCommand(users, "nouva", "/w/shared/notes.md", { landlock: "off", writable: [] });
    expect(line.slice(-4)).toEqual([HELPER_BINARY, "put", "--to", "/w/shared/notes.md"]);
    expect(line.slice(0, 6)).toEqual([HELPER_BINARY, "exec", "--socket", HELPER_SOCKET, "--agent", "nouva"]);
  });

  test("a root daemon's client is the helper itself, with the folders and root as the service user", () => {
    const local = { through: "local" as const, binary: HELPER_BINARY, folders: FOLDERS };
    expect(clientPrefix(local, "nouva", { pidFile: "/tmp/p.pid", landlock: "off", writable: [] })).toEqual([
      HELPER_BINARY, "exec", "--local", "--workspace", FOLDERS.workspace, "--reads", FOLDERS.reads[0], "--reads", FOLDERS.reads[1], "--credentials", FOLDERS.credentials,
      "--service-user", "root", "--agent", "nouva", "--pid-file", "/tmp/p.pid", "--landlock", "off", "--",
    ]);
  });
});

describe("the helper's units", () => {
  test("serve the config's folders, and only the daemon's group may connect", () => {
    const units = helperUnits({ user: "nouride", group: "nouride", folders: FOLDERS });
    expect(Object.keys(units)).toEqual(["nouride-run.socket", "nouride-run@.service"]);
    expect(units["nouride-run.socket"]).toContain("SocketGroup=nouride\nSocketMode=0660\nAccept=yes");
    expect(units["nouride-run@.service"]).toContain(
      `ExecStart=${HELPER_BINARY} serve --workspace ${FOLDERS.workspace} --reads ${FOLDERS.reads[0]} --reads ${FOLDERS.reads[1]} --credentials ${FOLDERS.credentials} --service-user nouride`,
    );
    // The command is this unit's child: what the daemon's unit held its commands to, held here.
    expect(units["nouride-run@.service"]).toContain("RestrictNamespaces=mnt\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK");
    // The escape tests run the helper with exactly the unit's capabilities: a run as full root passed while a unit short
    // of two refused every command (CAP_SYS_CHROOT to enter the daemon's mount namespace, CAP_FSETID for setgid folders).
    const unit = /^CapabilityBoundingSet=(.*)$/m.exec(units["nouride-run@.service"]!)![1]!.split(" ");
    const escape = readFileSync(join(import.meta.dir, "../root/nouride-run/tests/escape.rs"), "utf-8");
    const tested = /const HELPER_CAPS: &\[&str\] = &\[([^\]]*)\]/.exec(escape)![1]!.match(/"([a-z_]+)"/g)!.map((cap) => `CAP_${cap.slice(1, -1).toUpperCase()}`);
    expect(tested).toEqual(unit);
    expect(unit).toContain("CAP_SYS_CHROOT");
    expect(unit).toContain("CAP_FSETID");
    // What it changes as root is writable to it, and nothing else but /etc.
    expect(units["nouride-run@.service"]).toContain(`ReadWritePaths=/etc -${FOLDERS.workspace} -${FOLDERS.reads.join(" -")} -${FOLDERS.credentials}`);
  });
});
