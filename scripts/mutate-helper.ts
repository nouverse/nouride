#!/usr/bin/env bun
/**
 * A mutation sweep over the root helper, `nouride-run` (packages/isolation/root): each decision it makes as root broken
 * in turn — a check dropped, a mode widened, a step moved before the drop — on a copy, and the helper's tests run on
 * that copy as root in a container, the way `packages/isolation/scripts/test-root.sh` runs them. A mutant the tests let
 * live is a rule nothing holds the helper to: a missing test. Run it after changing the helper.
 *
 * Usage:
 *   bun run mutate:helper            every mutant
 *   bun run mutate:helper drop-      the ones whose name starts so
 *
 * Needs Docker, about half a minute a mutant. Each copy's crate is cleaned before it is built: copied files keep their
 * times on macOS, and cargo took a copy for one it had built and tested the last mutant again (the first sweep,
 * 2026-10-28, reported a dozen mutants alive that were not).
 *
 * A mutant marked `lives` changes nothing a test can see, and says why; one of those killed, or any other left alive,
 * fails the sweep. On 2026-10-28 every other mutant here was killed.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CRATE = join(import.meta.dir, "../packages/isolation/root/nouride-run");

interface Mutant {
  name: string;
  file: string;
  /** Each `from` must be in the file exactly once. */
  edits: [from: string, to: string][];
  /** Why no test can tell this one apart from the helper as it is. */
  lives?: string;
}

const off = (from: string): [string, string] => [from, "if false {"];

const MUTANTS: Mutant[] = [
  // The request, read before anything is done with it.
  { name: "req-reserved", file: "src/request.rs", edits: [["\n        && !RESERVED.contains(&id)", ""]] },
  { name: "req-slash-dot", file: "src/request.rs", edits: [["*b == b'-')", "*b == b'-' || *b == b'/' || *b == b'.')"]] },
  { name: "req-agent-unchecked", file: "src/request.rs", edits: [off("if request.op != Some(Op::Info) && !valid_agent(&request.agent) {")] },
  { name: "req-arg-nul", file: "src/request.rs", edits: [["                    if payload.contains(&0) {\n                        return Err(\"an argument", "                    if false {\n                        return Err(\"an argument"]] },
  { name: "req-total-cap", file: "src/request.rs", edits: [off("if total > MAX_TOTAL {")] },
  { name: "req-writable-absolute", file: "src/request.rs", edits: [off("if payload.first() != Some(&b'/') || payload.contains(&0) {")] },
  { name: "req-version-required", file: "src/request.rs", edits: [off("if !version {")] },
  { name: "req-protocol-match", file: "src/request.rs", edits: [off("if payload != PROTOCOL.as_bytes() {")] },
  // Who is answered, and what the command is started with.
  { name: "serve-caller-uid", file: "src/serve.rs", edits: [off("if cred.uid != service.uid && cred.uid != 0 {")] },
  {
    name: "serve-env-clear",
    file: "src/serve.rs",
    edits: [["        .env_clear()\n        .stdin(Stdio::piped())", "        .stdin(Stdio::piped())"]],
    lives: "the child `execve`s with the request's environment whole: the spawn's own is never used",
  },
  {
    name: "serve-stop-on-close",
    file: "src/serve.rs",
    edits: [["        unsafe { libc::killpg(pid, libc::SIGTERM) };\n        thread::sleep(STOP_GRACE);\n        if !reaped.load(Ordering::SeqCst) {\n            unsafe { libc::killpg(pid, libc::SIGKILL) };\n        }", ""]],
  },
  { name: "serve-landlock-require", file: "src/serve.rs", edits: [["    if mode != Mode::Require {", "    if true {"]] },
  {
    name: "serve-landlock-unwired",
    file: "src/serve.rs",
    edits: [["    landlock_available(request.landlock, landlock::abi)?;\n", ""]],
    lives: "only a kernel without Landlock tells it, and the machines the tests run on have one",
  },
  { name: "serve-landlock-root-writable", file: "src/serve.rs", edits: [["        (path(b\"/tmp\")?, Gives::Everything),", "        (path(b\"/tmp\")?, Gives::Everything),\n        (path(b\"/\")?, Gives::Everything),"]] },
  { name: "serve-drain-unprivileged", file: "src/serve.rs", edits: [["        drain_unprivileged();\n", ""]] },
  // Becoming the agent, in the order that matters.
  { name: "drop-setgroups", file: "src/drop.rs", edits: [off("if libc::setgroups(self.groups.len(), self.groups.as_ptr()) < 0 {")] },
  { name: "drop-setresgid", file: "src/drop.rs", edits: [off("if libc::setresgid(self.gid, self.gid, self.gid) < 0 {")] },
  { name: "drop-setresuid", file: "src/drop.rs", edits: [off("if libc::setresuid(self.uid, self.uid, self.uid) < 0 {")] },
  {
    name: "drop-proof",
    file: "src/drop.rs",
    edits: [off("if libc::getuid() != self.uid || libc::geteuid() != self.uid || libc::setuid(0) == 0 {")],
    lives: "it guards a `setresuid` that failed without saying so, and nothing makes one fail",
  },
  { name: "drop-no-new-privs", file: "src/drop.rs", edits: [["        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 {\n            return fail();\n        }\n", ""]] },
  { name: "drop-umask", file: "src/drop.rs", edits: [["libc::umask(0o002);", "libc::umask(0o022);"]] },
  {
    name: "drop-cgroup-join",
    file: "src/drop.rs",
    edits: [["if let Some(procs) = &self.cgroup_procs {", "if let Some(procs) = Option::<&CString>::None {"]],
    lives: "in the tests' container the client and the helper share one cgroup, so there is none to join",
  },
  { name: "drop-mount-ns", file: "src/drop.rs", edits: [["if let Some(ns) = &self.mount_ns {", "if let Some(ns) = Option::<&OwnedFd>::None {"]] },
  {
    name: "drop-chdir-as-root",
    file: "src/drop.rs",
    edits: [
      ["        // Groups, then the group, then the user:", "        if let Some(cwd) = &self.cwd {\n            if libc::chdir(cwd.as_ptr()) < 0 {\n                return fail();\n            }\n        }\n        // Groups, then the group, then the user:"],
      ["        libc::umask(0o002);\n        if let Some(cwd) = &self.cwd {\n            if libc::chdir(cwd.as_ptr()) < 0 {\n                return fail();\n            }\n        }\n", "        libc::umask(0o002);\n"],
    ],
  },
  // The users it makes, and the groups it hands out.
  { name: "account-marker-on-run", file: "src/account.rs", edits: [["        if user.gecos != marker(agent) {\n            return Err(format!(\n                \"a user named {name} exists that nouride did not make", "        if false {\n            return Err(format!(\n                \"a user named {name} exists that nouride did not make"]] },
  { name: "account-marker-on-groups", file: "src/account.rs", edits: [["    if user.gecos != marker(agent) {\n        return Err(format!(\"a user named {name} exists that nouride did not make\"));", "    if false {\n        return Err(format!(\"a user named {name} exists that nouride did not make\"));"]] },
  { name: "account-grantable", file: "src/account.rs", edits: [off("if !GRANTABLE.contains(&group.as_str()) {")] },
  // The folders it changes as root.
  { name: "fsafe-nofollow", file: "src/fsafe.rs", edits: [["libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,", "libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,"]] },
  { name: "fsafe-private-mode", file: "src/fsafe.rs", edits: [["libc::fchmod(folder.as_raw_fd(), 0o2770) }).map_err(|err| format!(\"{agent}'s folder: {err}\"))?;", "libc::fchmod(folder.as_raw_fd(), 0o2777) }).map_err(|err| format!(\"{agent}'s folder: {err}\"))?;"]] },
  { name: "fsafe-private-owner", file: "src/fsafe.rs", edits: [["Ok(st) if st.st_uid != uid && st.st_uid != service_uid => {", "Ok(st) if st.st_uid != uid && st.st_uid != service_uid && false => {"]] },
  { name: "share-owned-only", file: "src/share.rs", edits: [off("if st.st_uid != service_uid || (kind != libc::S_IFDIR && kind != libc::S_IFREG) {")] },
  { name: "share-agent-mode", file: "src/share.rs", edits: [["check(unsafe { libc::fchmod(folder.as_raw_fd(), 0o2750) }).map_err(at)?;", "check(unsafe { libc::fchmod(folder.as_raw_fd(), 0o2755) }).map_err(at)?;"]] },
  { name: "share-creds-owner", file: "src/share.rs", edits: [["    if st.st_uid != service_uid {\n        return Ok(());\n    }\n    say_skipped(", "    say_skipped("]] },
  {
    name: "put-nofollow",
    file: "src/put.rs",
    edits: [[".custom_flags(libc::O_NOFOLLOW)", ".custom_flags(0)"]],
    lives: "`create_new` refuses a link in the temporary file's place before `O_NOFOLLOW` is read",
  },
  { name: "client-local-root-only", file: "src/client.rs", edits: [["    if unsafe { libc::geteuid() } != 0 {\n        return refused(", "    if false {\n        return refused("]] },
];

type Verdict = "killed" | "lived" | "build-failed";

/** The helper's tests on a copy with `mutant`'s edits, as root in the container `test-root.sh` uses. */
function run(mutant: Mutant | null): { verdict: Verdict; failed: string[] } {
  const copy = mkdtempSync(join(tmpdir(), "nr-mutant-"));
  try {
    cpSync(CRATE, copy, { recursive: true, filter: (path) => !path.includes("/target") });
    for (const [from, to] of mutant?.edits ?? []) {
      const path = join(copy, mutant!.file);
      const source = readFileSync(path, "utf8");
      const count = source.split(from).length - 1;
      if (count !== 1) throw new Error(`${mutant!.name}: what it changes is in ${mutant!.file} ${count} times, not once — the helper moved on; update the mutant`);
      writeFileSync(path, source.replace(from, to));
    }
    const docker = Bun.spawnSync(
      [
        "docker", "run", "--rm", "--cap-add", "SYS_PTRACE", "--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined",
        "-v", `${copy}:/src:ro`, "-v", "nr-cargo:/usr/local/cargo/registry", "-v", "nr-mutate-target:/tmp/target", "-w", "/src",
        "-e", "CARGO_TARGET_DIR=/tmp/target", "rust:1.99-bookworm",
        "sh", "-c", "cargo clean -p nouride-run >/dev/null 2>&1; cargo test -- --test-threads=1 2>&1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = docker.stdout.toString();
    if (/^error(\[|: could not compile)/m.test(out)) return { verdict: "build-failed", failed: [] };
    const failed = [...out.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((match) => match[1]!);
    return { verdict: failed.length > 0 || docker.exitCode !== 0 ? "killed" : "lived", failed };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

const only = process.argv[2] ?? "";
const baseline = run(null);
if (baseline.verdict !== "lived") {
  console.error(`✗ the helper's tests do not pass as it is (${baseline.verdict}${baseline.failed.length ? `: ${baseline.failed.join(", ")}` : ""})`);
  process.exit(1);
}
let wrong = 0;
for (const mutant of MUTANTS.filter((candidate) => candidate.name.startsWith(only))) {
  const { verdict, failed } = run(mutant);
  const expected: Verdict = mutant.lives ? "lived" : "killed";
  const ok = verdict === expected;
  if (!ok) wrong += 1;
  const why = verdict === "killed" ? failed.slice(0, 2).join(", ") : (mutant.lives ?? "no test failed: a missing test");
  console.log(`${ok ? "✓" : "✗"} ${mutant.name} — ${verdict}${why ? ` (${why})` : ""}`);
}
if (wrong > 0) {
  console.error(`✗ ${wrong} mutant${wrong === 1 ? "" : "s"} not as expected: a live one needs a test, a killed \`lives\` its mark removed`);
  process.exit(1);
}
console.log("✓ every mutant the tests can see was killed");
