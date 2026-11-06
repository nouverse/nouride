//! The escape tests (RFC §8): every way out, tried against the real binary, as root, with real users — each refused by
//! the helper or by the kernel, never by anything the daemon does.
//!
//! Run where they can be: a Linux container as root (`packages/isolation/scripts/test-root.sh`). Anywhere else they
//! say so and pass nothing — a skipped escape test is not a passed one, so CI runs them in the container.

#![cfg(target_os = "linux")]

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_nouride-run");
/// The capabilities `nouride-run@.service` gives the helper (`HELPER_CAPABILITIES`, packages/isolation/src/units.ts),
/// and all it is run with here: a test as full root passed while the unit, short of two, refused every command.
const HELPER_CAPS: &[&str] = &[
    "setuid",
    "setgid",
    "chown",
    "fowner",
    "fsetid",
    "dac_override",
    "dac_read_search",
    "kill",
    "sys_ptrace",
    "sys_admin",
    "sys_chroot",
];
const SERVICE: &str = "nrsvc";
const OPERATOR: &str = "nrop";

struct World {
    root: PathBuf,
    socket: PathBuf,
    service_uid: u32,
    service_gid: u32,
    operator_uid: u32,
}

fn sh(script: &str) {
    let status = Command::new("sh").arg("-c").arg(script).status().unwrap();
    assert!(status.success(), "setup failed: {script}");
}

/// A group's id, from the system's files.
fn group_id(name: &str) -> u32 {
    let out = Command::new("getent").args(["group", name]).output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .split(':')
        .nth(2)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

fn id(flag: &str, name: &str) -> u32 {
    let out = Command::new("id").arg(flag).arg(name).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

/// Everything the tests share, made once: the service user and an operator in its group, `nr-agents` and `nr-creds`,
/// an install's folders with the modes `install.sh` gives them, and the socket, accepted the way systemd's
/// `Accept=yes` does — one `serve` per connection, the connection as its stdin and stdout.
fn world() -> Option<&'static World> {
    static WORLD: OnceLock<Option<World>> = OnceLock::new();
    WORLD
        .get_or_init(|| {
            if unsafe { libc::geteuid() } != 0 {
                eprintln!("escape tests skipped: they need root (packages/isolation/scripts/test-root.sh)");
                return None;
            }
            let root = PathBuf::from(format!("/srv/nr-escape-{}", std::process::id()));
            let root_text = root.display();
            sh(&format!(
                "set -e
                getent group nr-agents >/dev/null || groupadd --system nr-agents
                getent group nr-creds >/dev/null || groupadd --system nr-creds
                id {SERVICE} >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin {SERVICE}
                id {OPERATOR} >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin -G {SERVICE} {OPERATOR}
                usermod -aG nr-agents {SERVICE}
                R={root_text}
                umask 0027
                mkdir -p $R/workspace/shared $R/workspace/private $R/data $R/agents $R/jobs $R/credentials
                echo '{{\"key\":\"value\"}}' > $R/data/secrets.json; chmod 0600 $R/data/secrets.json
                echo left > $R/workspace/shared/left-by-the-daemon
                echo id_ed25519 > $R/credentials/key; chmod 0600 $R/credentials/key
                chown -R {SERVICE}:{SERVICE} $R
                chmod 0755 $R
                mkdir -p $R/open; chmod 0777 $R/open"
            ));
            let socket = root.join("run.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let service_uid = id("-u", SERVICE);
            let service_gid = id("-g", SERVICE);
            let operator_uid = id("-u", OPERATOR);
            fs::set_permissions(&socket, fs::Permissions::from_mode(0o660)).unwrap();
            std::os::unix::fs::chown(&socket, Some(0), Some(service_gid)).unwrap();
            let at = |name: &str| root.join(name).to_str().unwrap().to_string();
            let serve = [
                "serve".to_string(),
                "--workspace".into(),
                at("workspace"),
                "--reads".into(),
                at("agents"),
                "--reads".into(),
                at("jobs"),
                "--credentials".into(),
                at("credentials"),
                "--service-user".into(),
                SERVICE.into(),
            ];
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let input = stream.try_clone().unwrap();
                    // Root with the unit's capabilities and no others, as systemd starts it.
                    let bounding = format!("-all,{}", HELPER_CAPS.iter().map(|cap| format!("+{cap}")).collect::<Vec<_>>().join(","));
                    let mut served = Command::new("setpriv")
                        .args(["--bounding-set", &bounding, "--", BIN])
                        .args(&serve)
                        .stdin(Stdio::from(std::os::fd::OwnedFd::from(input)))
                        .stdout(Stdio::from(std::os::fd::OwnedFd::from(stream)))
                        .stderr(Stdio::null())
                        .spawn()
                        .unwrap();
                    // Reaped as systemd would, so the tests that count processes see none left behind.
                    thread::spawn(move || served.wait());
                }
            });
            Some(World { root, socket, service_uid, service_gid, operator_uid })
        })
        .as_ref()
}

macro_rules! world_or_skip {
    () => {
        match world() {
            Some(world) => world,
            None => return,
        }
    };
}

impl World {
    fn workspace(&self) -> PathBuf {
        self.root.join("workspace")
    }

    /// The client, as the daemon runs it: as the service user, with an environment of its choosing.
    fn client(&self, uid: u32, args: &[&str], env: &[(&str, &str)], stdin: Option<&[u8]>) -> Output {
        let mut command = Command::new(BIN);
        command
            .arg(args[0])
            .args(["--socket", self.socket.to_str().unwrap()])
            .args(&args[1..])
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .envs(env.iter().copied())
            .current_dir(&self.root)
            .uid(uid)
            .gid(self.service_gid)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        if let Some(input) = stdin {
            child.stdin.take().unwrap().write_all(input).unwrap();
        }
        child.wait_with_output().unwrap()
    }

    fn run(&self, agent: &str, command: &[&str]) -> Output {
        let mut args = vec!["exec", "--agent", agent, "--cwd", "/"];
        args.push("--");
        args.extend_from_slice(command);
        self.client(self.service_uid, &args, &[], None)
    }

    fn sh_as(&self, agent: &str, script: &str) -> Output {
        self.run(agent, &["sh", "-c", script])
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// An install of its own at `root`, for a test that bends it: `workspace/shared`, `workspace/private`, `agents`,
/// `credentials`, root's.
fn own_install(root: &Path) {
    sh(&format!(
        "set -e; R={}; mkdir -p $R/workspace/shared $R/workspace/private $R/agents $R/credentials",
        root.display()
    ));
}

/// The helper `--local`, as a daemon that is root runs it, on the install at `root`.
fn local(root: &Path, agent: &str, command: &[&str]) -> Output {
    let at = |name: &str| root.join(name).to_str().unwrap().to_string();
    Command::new("setsid")
        .args([BIN, "exec", "--local"])
        .args(["--workspace", &at("workspace"), "--reads", &at("agents")])
        .args(["--credentials", &at("credentials"), "--service-user", "root"])
        .args(["--agent", agent, "--cwd", "/", "--"])
        .args(command)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .output()
        .unwrap()
}

#[test]
fn a_command_runs_as_its_agent_in_a_folder_only_it_and_the_daemon_reach() {
    let world = world_or_skip!();
    let out = world.run("alpha", &["id", "-un"]);
    assert_eq!(text(&out.stdout), "nr-alpha\n", "{}", text(&out.stderr));
    let folder = fs::metadata(world.workspace().join("private/alpha")).unwrap();
    assert_eq!(folder.uid(), id("-u", "nr-alpha"));
    assert_eq!(folder.gid(), world.service_gid);
    assert_eq!(folder.mode() & 0o7777, 0o2770);
    // Its scratchpad is in it, and its own to write: `TMPDIR` points there.
    let scratch = world.sh_as(
        "alpha",
        &format!(
            "touch {}/private/alpha/.scratchpad/t && echo ok",
            world.workspace().display()
        ),
    );
    assert_eq!(text(&scratch.stdout), "ok\n", "{}", text(&scratch.stderr));
    // Its home is that folder, it has no login shell, and it carries the marker that says nouride made it.
    let passwd = text(
        &Command::new("getent")
            .args(["passwd", "nr-alpha"])
            .output()
            .unwrap()
            .stdout,
    );
    assert!(
        passwd.contains("nouride agent alpha") && passwd.contains("private/alpha") && passwd.contains("nologin"),
        "{passwd}"
    );
}

#[test]
fn an_agent_id_that_is_no_agents_names_nothing() {
    let world = world_or_skip!();
    for bad in ["../root", "root", "", "Nouva", "shared", "a/b"] {
        let out = world.run(bad, &["id"]);
        assert_eq!(out.status.code(), Some(125), "{bad:?}");
        assert!(
            text(&out.stderr).contains("not an agent id"),
            "{bad:?}: {}",
            text(&out.stderr)
        );
    }
    assert!(Command::new("id").arg("nr-root").output().unwrap().status.code() != Some(0));
}

#[test]
fn only_the_daemon_is_answered_and_an_agent_cannot_reach_the_socket() {
    let world = world_or_skip!();
    // An operator in the service group reaches the socket — and is still not the daemon.
    let out = world.client(world.operator_uid, &["exec", "--agent", "alpha", "--", "id"], &[], None);
    assert_eq!(out.status.code(), Some(125));
    assert!(
        text(&out.stderr).contains("is not the daemon's"),
        "{}",
        text(&out.stderr)
    );
    // An agent's own command asking the helper for another agent: the socket is not its to open.
    let socket = world.socket.to_str().unwrap();
    let out = world.run(
        "alpha",
        &[BIN, "exec", "--socket", socket, "--agent", "beta", "--", "id"],
    );
    assert_eq!(out.status.code(), Some(125));
    assert!(text(&out.stderr).contains("Permission denied"), "{}", text(&out.stderr));
}

#[test]
fn the_daemons_data_is_out_of_reach_however_the_path_is_spelled() {
    let world = world_or_skip!();
    let secrets = world.root.join("data/secrets.json");
    let out = world.run("alpha", &["cat", secrets.to_str().unwrap()]);
    assert_ne!(out.status.code(), Some(0));
    assert!(text(&out.stderr).contains("Permission denied"), "{}", text(&out.stderr));
    // Built at run time, which no check of the command line could see.
    let built = format!(
        "d={}; f=sec; cat \"$d/${{f}}rets.json\"",
        world.root.join("data").display()
    );
    let out = world.sh_as("alpha", &built);
    assert!(
        text(&out.stderr).contains("Permission denied") && out.stdout.is_empty(),
        "{}",
        text(&out.stderr)
    );
}

#[test]
fn another_agents_folder_is_closed_directly_and_through_a_link_in_shared() {
    let world = world_or_skip!();
    let beta = world.workspace().join("private/beta");
    let made = world.sh_as("beta", &format!("echo mine > {}/note", beta.display()));
    assert!(made.status.success(), "{}", text(&made.stderr));
    let out = world.run("alpha", &["ls", beta.to_str().unwrap()]);
    assert!(text(&out.stderr).contains("Permission denied"), "{}", text(&out.stderr));
    let link = world.workspace().join("shared/to-beta");
    let linked = world.run("beta", &["ln", "-sfn", beta.to_str().unwrap(), link.to_str().unwrap()]);
    assert!(linked.status.success(), "{}", text(&linked.stderr));
    let out = world.run("alpha", &["cat", link.join("note").to_str().unwrap()]);
    assert!(text(&out.stderr).contains("Permission denied"), "{}", text(&out.stderr));
    // A working directory through that link is resolved as the agent too: refused, not run.
    let out = world.client(
        world.service_uid,
        &["exec", "--agent", "alpha", "--cwd", link.to_str().unwrap(), "--", "pwd"],
        &[],
        None,
    );
    assert_eq!(out.status.code(), Some(126), "{}", text(&out.stderr));
}

#[test]
fn its_own_pack_is_read_not_written_and_another_agents_not_at_all() {
    let world = world_or_skip!();
    // As the daemon made it, before the agent had a user: the service user's, its group, `0640` under `UMask=0027`.
    let pack = world.root.join("agents/alpha");
    sh(&format!(
        "umask 0027 && mkdir -p {p}/skills && echo 'model = \"x\"' > {p}/config.toml && echo run > {p}/skills/run.sh && chown -R {SERVICE}:{SERVICE} {p}",
        p = pack.display()
    ));
    let read = world.run("alpha", &["cat", pack.join("config.toml").to_str().unwrap()]);
    assert_eq!(text(&read.stdout), "model = \"x\"\n", "{}", text(&read.stderr));
    let nested = world.run("alpha", &["cat", pack.join("skills/run.sh").to_str().unwrap()]);
    assert_eq!(text(&nested.stdout), "run\n", "{}", text(&nested.stderr));
    let write = world.sh_as(
        "alpha",
        &format!("echo 'model = \"y\"' >> {}", pack.join("config.toml").display()),
    );
    assert!(
        text(&write.stderr).contains("Permission denied"),
        "{}",
        text(&write.stderr)
    );
    let other = world.run("beta", &["cat", pack.join("config.toml").to_str().unwrap()]);
    assert!(
        text(&other.stderr).contains("Permission denied"),
        "{}",
        text(&other.stderr)
    );
    let folder = fs::metadata(&pack).unwrap();
    assert_eq!(
        (folder.uid(), folder.gid(), folder.mode() & 0o7777),
        (world.service_uid, group_id("nr-alpha"), 0o2750)
    );
}

#[test]
fn a_jobs_log_is_read_by_its_agent_alone_and_written_by_none() {
    let world = world_or_skip!();
    let jobs = world.root.join("jobs/epsilon");
    // The daemon's: the folder made and a log written before the agent's first command.
    sh(&format!(
        "umask 0027 && mkdir -p {j} && echo started > {j}/job_1.log && chown -R {SERVICE}:{SERVICE} {j} \
         && ln -s {secrets} {j}/link && chown -h {SERVICE}:{SERVICE} {j}/link \
         && echo roots > {j}/roots && chmod 0600 {j}/roots",
        j = jobs.display(),
        secrets = world.root.join("data/secrets.json").display()
    ));
    let read = world.run("epsilon", &["cat", jobs.join("job_1.log").to_str().unwrap()]);
    assert_eq!(text(&read.stdout), "started\n", "{}", text(&read.stderr));
    let append = world.sh_as(
        "epsilon",
        &format!("echo forged >> {}", jobs.join("job_1.log").display()),
    );
    assert!(
        text(&append.stderr).contains("Permission denied"),
        "{}",
        text(&append.stderr)
    );
    let other = world.run("beta", &["cat", jobs.join("job_1.log").to_str().unwrap()]);
    assert!(
        text(&other.stderr).contains("Permission denied"),
        "{}",
        text(&other.stderr)
    );
    // Sharing followed no link and took nothing of root's: the store is still the daemon's alone.
    let secrets = fs::metadata(world.root.join("data/secrets.json")).unwrap();
    assert_eq!((secrets.gid(), secrets.mode() & 0o777), (world.service_gid, 0o600));
    assert_eq!(fs::metadata(jobs.join("roots")).unwrap().gid(), 0);
    let through = world.run("epsilon", &["cat", jobs.join("link").to_str().unwrap()]);
    assert!(
        text(&through.stderr).contains("Permission denied"),
        "{}",
        text(&through.stderr)
    );
    // A log the daemon writes later takes the agent's group from the folder, and is read `0640`.
    sh(&format!(
        "setpriv --reuid={SERVICE} --regid={SERVICE} --clear-groups sh -c 'umask 0027; echo later > {j}/job_2.log'",
        j = jobs.display()
    ));
    let later = world.run("epsilon", &["cat", jobs.join("job_2.log").to_str().unwrap()]);
    assert_eq!(text(&later.stdout), "later\n", "{}", text(&later.stderr));
}

#[test]
fn what_the_daemon_left_in_shared_becomes_every_agents_to_edit() {
    let world = world_or_skip!();
    let left = world.workspace().join("shared/left-by-the-daemon");
    let out = world.sh_as("alpha", &format!("echo edited >> {}", left.display()));
    assert!(out.status.success(), "{}", text(&out.stderr));
    let shared = fs::metadata(world.workspace().join("shared")).unwrap();
    assert_eq!((shared.gid(), shared.mode() & 0o7777), (group_id("nr-agents"), 0o2770));
}

#[test]
fn a_file_put_through_the_helper_is_its_agents_whole_and_keeps_its_mode() {
    let world = world_or_skip!();
    world.run("alpha", &["true"]);
    let script = world.workspace().join("private/alpha/tools/run.sh");
    let put = |agent: &str, to: &std::path::Path, body: &[u8]| {
        world.client(
            world.service_uid,
            &[
                "exec",
                "--agent",
                agent,
                "--cwd",
                "/",
                "--",
                BIN,
                "put",
                "--to",
                to.to_str().unwrap(),
            ],
            &[],
            Some(body),
        )
    };
    let out = put("alpha", &script, b"#!/bin/sh\necho made\n");
    assert!(out.status.success(), "{}", text(&out.stderr));
    let made = fs::metadata(&script).unwrap();
    assert_eq!((made.uid(), made.mode() & 0o777), (id("-u", "nr-alpha"), 0o664));
    // Its own, so its command makes it executable — and a later write keeps that.
    let chmod = world.run("alpha", &["chmod", "+x", script.to_str().unwrap()]);
    assert!(chmod.status.success(), "{}", text(&chmod.stderr));
    let out = put("alpha", &script, b"#!/bin/sh\necho changed\n");
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        text(&world.run("alpha", &[script.to_str().unwrap()]).stdout),
        "changed\n"
    );
    // Into another agent's folder: refused by the kernel, and nothing left behind.
    let theirs = world.workspace().join("private/alpha/stolen");
    let out = put("beta", &theirs, b"x");
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out.stderr).contains("Permission denied"), "{}", text(&out.stderr));
    assert!(!theirs.exists());
}

#[test]
fn the_requests_environment_reaches_the_command_only() {
    let world = world_or_skip!();
    // A static helper loads nothing at all, and the variable is applied at the command's exec, after the drop.
    let out = world.client(
        world.service_uid,
        &[
            "exec",
            "--agent",
            "alpha",
            "--cwd",
            "/",
            "--",
            "sh",
            "-c",
            "echo \"$LD_PRELOAD|$HOME_HINT\"",
        ],
        &[("LD_PRELOAD", "/nonexistent/evil.so"), ("HOME_HINT", "x")],
        None,
    );
    assert_eq!(text(&out.stdout), "/nonexistent/evil.so|x\n");
    assert!(out.status.success(), "{}", text(&out.stderr));
}

#[test]
fn groups_are_only_the_ones_it_hands_out_and_the_credentials_follow_them() {
    let world = world_or_skip!();
    world.run("gamma", &["true"]);
    let key = world.root.join("credentials/key");
    let shared = fs::metadata(&key).unwrap();
    assert_eq!(
        (shared.gid(), shared.mode() & 0o777),
        (group_id("nr-creds"), 0o640),
        "a key put there 0600 is the group's to read"
    );
    // Made in `nr-agents` alone: the daemon grants `nr-creds` where the pack allows it, so one kept out never reads them.
    let ungranted = world.run("gamma", &["cat", key.to_str().unwrap()]);
    assert!(
        text(&ungranted.stderr).contains("Permission denied"),
        "a new agent reads the credentials only once granted: {}",
        text(&ungranted.stderr)
    );
    let granted = world.client(
        world.service_uid,
        &["groups", "--agent", "gamma", "--group", "nr-creds"],
        &[],
        None,
    );
    assert!(granted.status.success(), "{}", text(&granted.stderr));
    let read = world.run("gamma", &["cat", key.to_str().unwrap()]);
    assert_eq!(
        text(&read.stdout),
        "id_ed25519\n",
        "a Nouride agent granted the credentials reads them: {}",
        text(&read.stderr)
    );
    for refused in [SERVICE, "root", "sudo", "nr-alpha"] {
        let out = world.client(
            world.service_uid,
            &["groups", "--agent", "gamma", "--group", refused],
            &[],
            None,
        );
        assert_eq!(out.status.code(), Some(125), "{refused}");
        assert!(
            text(&out.stderr).contains("not a group this helper hands out"),
            "{refused}: {}",
            text(&out.stderr)
        );
    }
    let off = world.client(world.service_uid, &["groups", "--agent", "gamma"], &[], None);
    assert!(off.status.success(), "{}", text(&off.stderr));
    let denied = world.run("gamma", &["cat", key.to_str().unwrap()]);
    assert!(
        text(&denied.stderr).contains("Permission denied"),
        "credentials off: {}",
        text(&denied.stderr)
    );
    let on = world.client(
        world.service_uid,
        &["groups", "--agent", "gamma", "--group", "nr-creds"],
        &[],
        None,
    );
    assert!(on.status.success(), "{}", text(&on.stderr));
    assert_eq!(
        text(&world.run("gamma", &["cat", key.to_str().unwrap()]).stdout),
        "id_ed25519\n"
    );
}

#[test]
fn a_command_holds_its_agents_ids_in_every_slot_and_none_of_roots_groups() {
    let world = world_or_skip!();
    // Real, effective, saved and filesystem: a slot still root's is one a command can take root back through.
    let out = world.sh_as("alpha", "grep -E '^(Uid|Gid|Groups):' /proc/self/status");
    let status = text(&out.stdout);
    let (uid, gid) = (id("-u", "nr-alpha"), id("-g", "nr-alpha"));
    assert!(
        status.contains(&format!("Uid:\t{uid}\t{uid}\t{uid}\t{uid}\n")),
        "{status}"
    );
    assert!(
        status.contains(&format!("Gid:\t{gid}\t{gid}\t{gid}\t{gid}\n")),
        "{status}"
    );
    let groups: Vec<u32> = status
        .lines()
        .find_map(|line| line.strip_prefix("Groups:"))
        .unwrap()
        .split_whitespace()
        .map(|group| group.parse().unwrap())
        .collect();
    assert!(groups.contains(&gid) && !groups.contains(&0), "{status}");
}

#[test]
fn a_link_where_a_folder_it_changes_should_be_is_refused_not_followed() {
    // The service user owns the install: a link it put in place of a folder the helper changes as root would have it
    // make, hand over or open up a folder wherever the link points — under `/etc` as easily as here.
    world_or_skip!();
    for (n, folder) in ["workspace/private", "agents"].into_iter().enumerate() {
        let root = PathBuf::from(format!("/srv/nr-link-{}-{n}", std::process::id()));
        own_install(&root);
        sh(&format!(
            "set -e; R={}; mkdir -m 0700 $R/elsewhere; rmdir $R/{folder}; ln -s $R/elsewhere $R/{folder}",
            root.display()
        ));
        let out = local(&root, "epsilon", &["true"]);
        assert!(!out.status.success(), "{folder}: {}", text(&out.stdout));
        assert!(
            !root.join("elsewhere/epsilon").exists(),
            "{folder}: nothing made through the link"
        );
        let elsewhere = fs::metadata(root.join("elsewhere")).unwrap();
        assert_eq!(
            (elsewhere.uid(), elsewhere.gid(), elsewhere.mode() & 0o7777),
            (0, 0, 0o700),
            "{folder}: and what it points at as it was"
        );
    }
}

#[test]
fn a_private_folder_of_somebody_elses_is_refused_not_taken_over() {
    world_or_skip!();
    let root = PathBuf::from(format!("/srv/nr-owner-{}", std::process::id()));
    own_install(&root);
    // Neither the agent's nor the service user's: the helper's adoption would hand it, and what is in it, to the agent.
    sh(&format!(
        "set -e; F={}/workspace/private/zeta; mkdir -m 0700 $F; echo theirs > $F/note; chown -R {OPERATOR}: $F",
        root.display()
    ));
    let out = local(&root, "zeta", &["true"]);
    assert!(
        text(&out.stderr).contains("neither the agent's nor the service user's"),
        "{}",
        text(&out.stderr)
    );
    let folder = fs::metadata(root.join("workspace/private/zeta")).unwrap();
    let note = fs::metadata(root.join("workspace/private/zeta/note")).unwrap();
    assert_eq!((folder.uid(), note.uid()), (id("-u", OPERATOR), id("-u", OPERATOR)));
}

#[test]
fn a_credentials_folder_that_is_not_the_service_users_is_left_as_it_is() {
    world_or_skip!();
    let root = PathBuf::from(format!("/srv/nr-creds-{}", std::process::id()));
    own_install(&root);
    sh(&format!(
        "set -e; C={}/credentials; echo key > $C/key; chown -R {OPERATOR}: $C; chmod 0700 $C",
        root.display()
    ));
    let out = local(&root, "eta", &["true"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let dir = fs::metadata(root.join("credentials")).unwrap();
    assert_eq!(
        (dir.gid(), dir.mode() & 0o7777),
        (id("-g", OPERATOR), 0o700),
        "not regrouped for nr-creds"
    );
}

#[test]
fn local_is_for_a_daemon_that_is_root_alone() {
    let world = world_or_skip!();
    let at = |name: &str| world.root.join(name).to_str().unwrap().to_string();
    let out = Command::new(BIN)
        .args([
            "exec",
            "--local",
            "--workspace",
            &at("workspace"),
            "--service-user",
            SERVICE,
        ])
        .args(["--agent", "alpha", "--cwd", "/", "--", "id"])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .uid(world.service_uid)
        .gid(world.service_gid)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(
        text(&out.stderr).contains("--local is for a daemon running as root"),
        "{}",
        text(&out.stderr)
    );
}

#[test]
fn a_user_nouride_did_not_make_is_never_run_as() {
    let world = world_or_skip!();
    sh("id nr-impostor >/dev/null 2>&1 || useradd --system --no-create-home nr-impostor");
    let out = world.run("impostor", &["id"]);
    assert_eq!(out.status.code(), Some(125));
    assert!(
        text(&out.stderr).contains("nouride did not make"),
        "{}",
        text(&out.stderr)
    );
    // Nor given a group: `nr-creds` on a user of somebody else's making hands them the keys.
    let grouped = world.client(
        world.service_uid,
        &["groups", "--agent", "impostor", "--group", "nr-creds"],
        &[],
        None,
    );
    assert!(
        text(&grouped.stderr).contains("nouride did not make"),
        "{}",
        text(&grouped.stderr)
    );
}

#[test]
fn a_folder_the_daemon_made_is_handed_over_and_nothing_of_roots_moves_with_it() {
    let world = world_or_skip!();
    let folder = world.workspace().join("private/delta");
    sh(&format!(
        "mkdir -p {f}/sub && echo hi > {f}/sub/file && chown -R {SERVICE}:{SERVICE} {f} && touch {f}/roots && chown root:root {f}/roots && chmod 0600 {f}/roots",
        f = folder.display()
    ));
    let out = world.run("delta", &["cat", folder.join("sub/file").to_str().unwrap()]);
    assert_eq!(text(&out.stdout), "hi\n", "{}", text(&out.stderr));
    let uid = id("-u", "nr-delta");
    assert_eq!(fs::metadata(folder.join("sub/file")).unwrap().uid(), uid);
    assert_eq!(
        fs::metadata(folder.join("roots")).unwrap().uid(),
        0,
        "root's file stays root's"
    );
}

#[test]
fn stdin_output_and_the_exit_are_the_commands() {
    let world = world_or_skip!();
    let echoed = world.client(
        world.service_uid,
        &["exec", "--agent", "alpha", "--cwd", "/", "--", "cat"],
        &[],
        Some(b"hello\n"),
    );
    assert_eq!(text(&echoed.stdout), "hello\n");
    let both = world.sh_as("alpha", "echo out; echo err >&2; exit 3");
    assert_eq!(
        (text(&both.stdout), text(&both.stderr), both.status.code()),
        ("out\n".into(), "err\n".into(), Some(3))
    );
    let signalled = world.sh_as("alpha", "kill -TERM $$");
    assert_eq!(signalled.status.signal(), Some(libc::SIGTERM));
    // The command's pid, where the daemon reads what it is doing: the helper's child, the agent's.
    let pid_file = world.root.join(format!("cmd-{}.pid", std::process::id()));
    let reported = world.client(
        world.service_uid,
        &[
            "exec",
            "--agent",
            "alpha",
            "--cwd",
            "/",
            "--pid-file",
            pid_file.to_str().unwrap(),
            "--",
            "sh",
            "-c",
            "echo $$",
        ],
        &[],
        None,
    );
    assert_eq!(
        fs::read_to_string(&pid_file).unwrap(),
        text(&reported.stdout).trim(),
        "{}",
        text(&reported.stderr)
    );
    let missing = world.run("alpha", &["no-such-program-anywhere"]);
    assert_eq!(missing.status.code(), Some(127), "{}", text(&missing.stderr));
}

#[test]
fn what_a_command_leaves_running_lives_on_though_it_prints_and_is_read_by_nobody_not_root() {
    let world = world_or_skip!();
    let log = world.root.join("open").join(format!("left-{}.log", std::process::id()));
    let lines = || fs::read_to_string(&log).map(|kept| kept.lines().count()).unwrap_or(0);
    // As an agent starts a server or a bot with `&`: it prints to its command's output, and keeps a log of its own.
    // The helper stopped reading at the command's end, and its next line killed it (0.8.6).
    let started = world.sh_as(
        "alpha",
        &format!(
            "(i=0; while [ $i -lt 8 ]; do echo tick $i; echo $i >> {}; i=$((i+1)); sleep 1; done) & echo started",
            log.display()
        ),
    );
    assert_eq!(started.status.code(), Some(0), "{}", text(&started.stderr));
    // The job's first tick may come before `started`: both write to one output, and which is first is the scheduler's
    // (a GitHub-hosted runner printed "tick 0" first, 2026-11-02). That the foreground ran to its end is the claim.
    assert!(
        text(&started.stdout).lines().any(|line| line == "started"),
        "{}",
        text(&started.stdout)
    );
    // What still reads its output is no longer root: reading a pipe already open needs no right at all.
    let serving = || {
        let mut ps = String::new();
        Command::new("ps")
            .args(["-eo", "user=,args="])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap()
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut ps)
            .unwrap();
        ps.lines()
            .filter(|line| line.contains(" serve --workspace"))
            .map(|line| line.split_whitespace().next().unwrap_or("").to_string())
            .collect::<Vec<_>>()
    };
    let asked = Instant::now();
    while serving() != ["nobody"] && asked.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(serving(), ["nobody"], "one helper left, reading as nobody");
    let waited = Instant::now();
    while lines() < 8 && waited.elapsed() < Duration::from_secs(20) {
        thread::sleep(Duration::from_millis(250));
    }
    assert_eq!(lines(), 8, "it printed past its command's end, and lived to its own");
    let ended = Instant::now();
    while !serving().is_empty() && ended.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(100));
    }
    assert!(serving().is_empty(), "and the helper went once its output closed");
}

#[test]
fn stopping_the_client_stops_the_command_and_what_it_started() {
    let world = world_or_skip!();
    let marker = format!("nr-stop-{}", std::process::id());
    let mut child = Command::new(BIN)
        .args([
            "exec",
            "--socket",
            world.socket.to_str().unwrap(),
            "--agent",
            "alpha",
            "--cwd",
            "/",
            "--",
            "sh",
            "-c",
            &format!("sleep 300 & sleep 301; : {marker}"),
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .uid(world.service_uid)
        .gid(world.service_gid)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let running = || {
        let mut ps = String::new();
        Command::new("ps")
            .args(["-u", "nr-alpha", "-o", "args="])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap()
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut ps)
            .unwrap();
        ps.lines().filter(|line| line.starts_with("sleep 30")).count()
    };
    let started = Instant::now();
    while running() < 2 && started.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(running(), 2, "both sleeps run as the agent");
    child.kill().unwrap();
    let _ = child.wait();
    let stopped = Instant::now();
    while running() > 0 && stopped.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(200));
    }
    assert_eq!(running(), 0, "the command's whole group went with the connection");
}

#[test]
fn the_folders_every_agent_passes_through_list_nothing() {
    let world = world_or_skip!();
    world.run("alpha", &["true"]);
    for dir in ["workspace", "workspace/private", "agents", "jobs"] {
        let path = world.root.join(dir);
        let out = world.run("alpha", &["ls", path.to_str().unwrap()]);
        assert!(
            text(&out.stderr).contains("Permission denied"),
            "{dir}: {}",
            text(&out.stderr)
        );
    }
    // And still passed through, to its own.
    let own = world.run(
        "alpha",
        &["ls", world.workspace().join("private/alpha").to_str().unwrap()],
    );
    assert!(own.status.success(), "{}", text(&own.stderr));
}

#[test]
fn what_cannot_be_given_its_group_is_left_and_the_command_still_runs() {
    let world = world_or_skip!();
    // Nested past what the walk descends — a folder it cannot finish is no reason to refuse every command.
    let deep = (0..70).fold(world.root.join("jobs/theta"), |path, n| path.join(format!("d{n}")));
    sh(&format!(
        "mkdir -p {d} && echo deep > {d}/f && chown -R {SERVICE}:{SERVICE} {j}",
        d = deep.display(),
        j = world.root.join("jobs/theta").display()
    ));
    let out = world.run("theta", &["id", "-un"]);
    assert_eq!(text(&out.stdout), "nr-theta\n", "{}", text(&out.stderr));
    let folder = fs::metadata(world.root.join("jobs/theta")).unwrap();
    assert_eq!(
        folder.mode() & 0o7777,
        0o2750,
        "the folder itself is shared all the same"
    );
}

#[test]
fn info_names_the_version_and_the_workspace_it_serves() {
    let world = world_or_skip!();
    let out = world.client(world.service_uid, &["info"], &[], None);
    let said = text(&out.stdout);
    for line in [
        "protocol=1".to_string(),
        format!("workspace={}", world.workspace().display()),
        format!(
            "reads={}:{}",
            world.root.join("agents").display(),
            world.root.join("jobs").display()
        ),
        format!("credentials={}", world.root.join("credentials").display()),
        "landlock=".to_string(),
    ] {
        assert!(said.contains(&line), "{line} in {said}");
    }
}

#[test]
fn landlock_keeps_changes_to_the_agents_own_folders_where_the_kernel_has_it() {
    let world = world_or_skip!();
    let open = world.root.join("open");
    let run = |extra: &[&str], script: &str| {
        let mut args = vec!["exec", "--agent", "alpha", "--cwd", "/"];
        args.extend_from_slice(extra);
        args.extend_from_slice(&["--", "sh", "-c", script]);
        world.client(world.service_uid, &args, &[], None)
    };
    let into_open = format!("echo x > {}/by-alpha && echo wrote", open.display());
    let info = text(&world.client(world.service_uid, &["info"], &[], None).stdout);
    if info.contains("landlock=none") {
        let out = run(&["--landlock", "require"], "echo ran");
        assert_eq!(out.status.code(), Some(125));
        assert!(out.stdout.is_empty());
        assert!(
            text(&out.stderr).contains("Landlock is required"),
            "{}",
            text(&out.stderr)
        );
        let out = run(&["--landlock", "auto"], &into_open);
        assert_eq!(
            text(&out.stdout),
            "wrote\n",
            "auto runs where there is none: {}",
            text(&out.stderr)
        );
        eprintln!("this kernel has no Landlock ({info}): only `require`'s refusal and `auto`'s fallback were tested");
        return;
    }
    // A folder anyone may write, by its mode: the user alone would not stop an agent there; the ruleset does.
    let out = run(&["--landlock", "require"], &into_open);
    assert!(text(&out.stderr).contains("Permission denied"), "{}", text(&out.stderr));
    let out = run(&["--landlock", "off"], &into_open);
    assert_eq!(text(&out.stdout), "wrote\n", "{}", text(&out.stderr));
    let own = format!(
        "echo x > {w}/shared/by-alpha && echo x > {w}/private/alpha/by-alpha && echo x > /dev/null && echo x > /tmp/by-alpha && echo ok",
        w = world.workspace().display()
    );
    let out = run(&["--landlock", "require"], &own);
    assert_eq!(text(&out.stdout), "ok\n", "{}", text(&out.stderr));
    let out = run(
        &["--landlock", "require", "--writable", open.to_str().unwrap()],
        &into_open,
    );
    assert_eq!(
        text(&out.stdout),
        "wrote\n",
        "a declared root is given back: {}",
        text(&out.stderr)
    );
}

#[test]
fn the_shared_workspace_is_every_agents_and_a_file_there_keeps_its_maker() {
    let world = world_or_skip!();
    let shared = world.workspace().join("shared");
    let made = world.sh_as("alpha", &format!("echo draft > {}/handover.md", shared.display()));
    assert!(made.status.success(), "{}", text(&made.stderr));
    let edited = world.sh_as("beta", &format!("echo reviewed >> {}/handover.md", shared.display()));
    assert!(
        edited.status.success(),
        "another agent edits it: {}",
        text(&edited.stderr)
    );
    let file = fs::metadata(shared.join("handover.md")).unwrap();
    assert_eq!(file.uid(), id("-u", "nr-alpha"));
    assert_eq!(
        file.gid(),
        group_id("nr-agents"),
        "the shared workspace's group, from its setgid"
    );
    let chmod = world.run("beta", &["chmod", "+x", shared.join("handover.md").to_str().unwrap()]);
    assert!(!chmod.status.success(), "only its maker changes its mode");
}

#[test]
fn the_command_sees_the_files_as_the_daemon_does_not_as_the_helper_does() {
    let world = world_or_skip!();
    // A daemon whose unit gives it a private /tmp: a mount only its own namespace has, and the helper's has not.
    let script = format!(
        "mkdir -p /mnt/nr-view && mount -t tmpfs nr-view /mnt/nr-view && echo daemons > /mnt/nr-view/file \
         && exec setpriv --reuid={uid} --regid={gid} --clear-groups {BIN} exec --socket {socket} --agent alpha --cwd / -- cat /mnt/nr-view/file",
        uid = world.service_uid,
        gid = world.service_gid,
        socket = world.socket.display(),
    );
    let out = Command::new("unshare")
        .args(["--mount", "--propagation", "private", "sh", "-c", &script])
        .output()
        .unwrap();
    assert_eq!(text(&out.stdout), "daemons\n", "{}", text(&out.stderr));
}

#[test]
fn a_daemon_that_is_root_runs_the_command_in_the_session_it_was_started_in() {
    // `--local` becomes the agent in its own process, which the daemon starts as every command: through `setsid(1)`,
    // already the leader of its session. Its own `setsid()` was refused there, and every agent's command with it.
    world_or_skip!();
    let root = PathBuf::from(format!("/srv/nr-local-{}", std::process::id()));
    sh(&format!(
        "set -e; R={}; mkdir -p $R/workspace/shared $R/workspace/private $R/agents $R/credentials",
        root.display()
    ));
    let at = |name: &str| root.join(name).to_str().unwrap().to_string();
    let out = Command::new("setsid")
        .args([BIN, "exec", "--local"])
        .args(["--workspace", &at("workspace"), "--reads", &at("agents")])
        .args(["--credentials", &at("credentials"), "--service-user", "root"])
        .args(["--agent", "delta", "--cwd", "/", "--", "id", "-un"])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .output()
        .unwrap();
    assert_eq!(text(&out.stdout), "nr-delta\n", "{}", text(&out.stderr));
}
