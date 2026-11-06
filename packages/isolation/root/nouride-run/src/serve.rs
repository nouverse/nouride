//! The helper: one connection, one request, as root — started by `nouride-run.socket` with the connection as stdin and
//! stdout (`Accept=yes`).

use crate::account::{self, groups_of, lookup_user};
use crate::drop::Becoming;
use crate::frame::{self, read_frame, write_frame};
use crate::landlock::{self, Gives, Mode, Plan};
use crate::request::{Op, Request};
use crate::share;
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Where the folders it makes and shares are — fixed by the unit, never taken from a request.
pub struct Settings {
    /// The workspace: `shared/`, and the `private/<agent>` folders.
    pub workspace: PathBuf,
    /// The daemon's folders whose `<agent>` folder that agent's commands read (`share::share_with_agent`).
    pub reads: Vec<PathBuf>,
    /// The credentials directory, read by the agents granted `nr-creds`.
    pub credentials: Option<PathBuf>,
    /// The daemon's user: the only one, beside root, it takes a request from.
    pub service_user: String,
}

impl Settings {
    /// `info`'s answer: what boot compares with its own config before it trusts the helper.
    pub fn describe(&self) -> String {
        let reads: Vec<String> = self.reads.iter().map(|dir| dir.display().to_string()).collect();
        format!(
            "version={}\nprotocol={}\nworkspace={}\nreads={}\ncredentials={}\nlandlock={}\n",
            env!("CARGO_PKG_VERSION"),
            crate::request::PROTOCOL,
            self.workspace.display(),
            reads.join(":"),
            self.credentials
                .as_ref()
                .map(|dir| dir.display().to_string())
                .unwrap_or_default(),
            match landlock::abi() {
                Ok(abi) => format!("abi {abi}"),
                Err(why) => format!("none — {why}"),
            }
        )
    }
}

/// How long a command has to stop after the connection closes before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// How long output still open after the command ended — a child it left running — is waited for.
const OUTPUT_GRACE: Duration = Duration::from_secs(2);
/// Who reads a child's output once its command has ended (`drain_unprivileged`): the overflow id, where `nobody` is not
/// in the user database.
const NOBODY: u32 = 65534;

type Out = Arc<Mutex<File>>;

fn send(out: &Out, kind: u8, payload: &[u8]) -> io::Result<()> {
    let mut out = out.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    write_frame(&mut *out, kind, payload)
}

/// Who is on the other end of the connection: pid, uid, gid — the kernel's word, not the request's.
fn peer(fd: i32) -> io::Result<libc::ucred> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(cred)
    }
}

/// A process's cgroup (v2), as the kernel lists it, or none.
fn cgroup_of(pid: &str) -> Option<String> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::to_string)
}

/// The cgroup the command joins: the client's — the daemon's commands — where it is not this helper's own.
fn command_cgroup(peer_pid: libc::pid_t) -> Option<String> {
    let theirs = cgroup_of(&peer_pid.to_string())?;
    if Some(&theirs) == cgroup_of("self").as_ref() {
        return None;
    }
    Some(format!(
        "/sys/fs/cgroup{}/cgroup.procs",
        if theirs == "/" { "" } else { theirs.as_str() }
    ))
}

pub fn serve(settings: &Settings) -> i32 {
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        libc::umask(0o022);
    }
    let out: Out = Arc::new(Mutex::new(unsafe { File::from_raw_fd(libc::dup(1)) }));
    let mut input = unsafe { File::from_raw_fd(libc::dup(0)) };
    let refuse = |reason: String| -> i32 {
        eprintln!("nouride-run: refused: {reason}");
        let _ = send(&out, frame::REFUSED, reason.as_bytes());
        0
    };

    let cred = match peer(0) {
        Ok(cred) => cred,
        Err(err) => {
            return refuse(format!(
                "the connection is not a socket it can ask who is calling: {err}"
            ))
        }
    };
    let Some(service) = lookup_user(&settings.service_user) else {
        return refuse(format!("the service user {} does not exist", settings.service_user));
    };
    if cred.uid != service.uid && cred.uid != 0 {
        return refuse(format!("uid {} is not the daemon's", cred.uid));
    }
    let request = match Request::read_from(&mut input) {
        Ok(request) => request,
        Err(reason) => return refuse(reason),
    };
    match request.op {
        Some(Op::Info) => {
            let _ = send(&out, frame::STDOUT, settings.describe().as_bytes());
            let _ = send(&out, frame::EXIT, b"code 0");
            0
        }
        Some(Op::Groups) => match account::set_groups(&request.agent, &request.groups) {
            Ok(()) => {
                let _ = send(&out, frame::EXIT, b"code 0");
                0
            }
            Err(reason) => refuse(reason),
        },
        Some(Op::Run) | None => match prepare(settings, &service, cred.pid, &request) {
            Ok(becoming) => run(becoming, input, &out),
            Err(reason) => refuse(reason),
        },
    }
}

/// The agent's user and folder, made where they are not, and everything the child needs — or why not.
pub fn prepare(
    settings: &Settings,
    service: &account::User,
    peer_pid: libc::pid_t,
    request: &Request,
) -> Result<Becoming, String> {
    let private = settings.workspace.join("private");
    let home = private.join(&request.agent);
    let user = account::ensure_user(&request.agent, &home)?;
    let agents_gid = account::lookup_group(account::AGENTS_GROUP).ok_or_else(|| {
        format!(
            "this system has no {} group — run install.sh again",
            account::AGENTS_GROUP
        )
    })?;
    share::ensure_workspace(&settings.workspace, service.uid, agents_gid)?;
    crate::fsafe::ensure_private(&private, &request.agent, user.uid, service.uid, service.gid)?;
    for root in &settings.reads {
        share::share_with_agent(root, &request.agent, service.uid, agents_gid, user.gid)?;
    }
    if let (Some(dir), Some(creds_gid)) = (&settings.credentials, account::lookup_group(account::CREDS_GROUP)) {
        share::ensure_credentials(dir, service.uid, creds_gid)?;
    }
    let groups = groups_of(&crate::request::user_of(&request.agent), user.gid);
    let cgroup = if peer_pid > 0 { command_cgroup(peer_pid) } else { None };
    let mut becoming = Becoming::new(
        user.uid,
        user.gid,
        groups,
        cgroup,
        request.cwd.clone(),
        &request.argv,
        &request.env,
    )
    .map_err(|err| err.to_string())?;
    if peer_pid > 0 {
        becoming.mount_ns = mount_namespace_of(peer_pid)?;
    }
    becoming.landlock = landlock_plan(settings, request)?;
    Ok(becoming)
}

/// Where the agent's commands change files: `shared/`, its own folder, its declared roots, the temporary folders; file
/// writes alone under `/dev` and `/proc`. Refused up front where Landlock is required and the kernel has none.
fn landlock_plan(settings: &Settings, request: &Request) -> Result<Plan, String> {
    landlock_available(request.landlock, landlock::abi)?;
    let path = |bytes: &[u8]| CString::new(bytes).map_err(|_| "a NUL in a path".to_string());
    let workspace = settings.workspace.as_os_str().as_bytes();
    let mut folders = vec![
        (path(&[workspace, b"/shared"].concat())?, Gives::Everything),
        (
            path(&[workspace, b"/private/", request.agent.as_bytes()].concat())?,
            Gives::Everything,
        ),
        (path(b"/tmp")?, Gives::Everything),
        (path(b"/var/tmp")?, Gives::Everything),
        (path(b"/dev/shm")?, Gives::Everything),
        (path(b"/dev")?, Gives::FileWrites),
        (path(b"/proc")?, Gives::FileWrites),
    ];
    for dir in &request.writable {
        folders.push((path(dir)?, Gives::Everything));
    }
    Ok(Plan {
        mode: request.landlock,
        folders,
    })
}

/// Whether the kernel has what `mode` needs — `abi` asked only where Landlock is required: a command that requires it is
/// refused where it is absent rather than run without it.
fn landlock_available(mode: Mode, abi: impl FnOnce() -> Result<i64, &'static str>) -> Result<(), String> {
    if mode != Mode::Require {
        return Ok(());
    }
    abi()
        .map(|_| ())
        .map_err(|why| format!("Landlock is required ([security.exec] landlock) and this kernel's is {why}"))
}

/// The client's mount namespace — the daemon's — where it is not this process's own; opened here, as root.
fn mount_namespace_of(pid: libc::pid_t) -> Result<Option<OwnedFd>, String> {
    let theirs = format!("/proc/{pid}/ns/mnt");
    let (Ok(them), Ok(us)) = (std::fs::metadata(&theirs), std::fs::metadata("/proc/self/ns/mnt")) else {
        return Err("the daemon's view of the files could not be read".into());
    };
    if (them.dev(), them.ino()) == (us.dev(), us.ino()) {
        return Ok(None);
    }
    File::open(&theirs)
        .map(|file| Some(OwnedFd::from(file)))
        .map_err(|err| format!("the daemon's view of the files: {err}"))
}

fn run(becoming: Becoming, mut input: File, out: &Out) -> i32 {
    let mut command = Command::new(Path::new("/nonexistent/nouride-run-child"));
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Spawned before any thread of this process starts: the child allocates nothing it could deadlock on.
    unsafe {
        command.pre_exec(move || Err(becoming.become_and_exec()));
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            let reason = match err.raw_os_error() {
                Some(libc::ENOENT) => "command not found".to_string(),
                _ => format!("could not start it as the agent: {err}"),
            };
            let _ = send(out, frame::STDERR, format!("nouride-run: {reason}\n").as_bytes());
            let _ = send(
                out,
                frame::EXIT,
                if err.raw_os_error() == Some(libc::ENOENT) {
                    b"code 127"
                } else {
                    b"code 126"
                },
            );
            return 0;
        }
    };
    let pid = child.id() as libc::pid_t;
    let _ = send(out, frame::STARTED, pid.to_string().as_bytes());

    let (done_tx, done_rx) = mpsc::channel::<()>();
    let mut streams = 0;
    for (stream, kind) in [
        (
            child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
            frame::STDOUT,
        ),
        (
            child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
            frame::STDERR,
        ),
    ] {
        let Some(mut stream) = stream else { continue };
        let out = Arc::clone(out);
        let done = done_tx.clone();
        streams += 1;
        thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            // Passed on while the connection takes it, and read to its end either way: a pipe nobody reads is one a
            // child the command left running dies writing to (SIGPIPE).
            let mut passing = true;
            loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if passing && send(&out, kind, &buf[..n]).is_err() {
                            passing = false;
                        }
                    }
                }
            }
            let _ = done.send(());
        });
    }
    drop(done_tx);

    // The connection: stdin for the command, and its closing is the stop — of a command still running. Once it is
    // reaped its pid is free, and a group killed by that number could be somebody else's.
    let exited = Arc::new(AtomicBool::new(false));
    let reaped = Arc::clone(&exited);
    let mut stdin = child.stdin.take();
    thread::spawn(move || {
        loop {
            match read_frame(&mut input) {
                Ok(Some((frame::STDIN, data))) => {
                    if let Some(pipe) = stdin.as_mut() {
                        if pipe.write_all(&data).is_err() {
                            stdin = None;
                        }
                    }
                }
                Ok(Some((frame::STDIN_CLOSED, _))) => stdin = None,
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
        // Gone: the daemon stopped it, or went away. The group goes, politely and then not.
        if reaped.load(Ordering::SeqCst) {
            return;
        }
        unsafe { libc::killpg(pid, libc::SIGTERM) };
        thread::sleep(STOP_GRACE);
        if !reaped.load(Ordering::SeqCst) {
            unsafe { libc::killpg(pid, libc::SIGKILL) };
        }
    });

    let status = child.wait();
    exited.store(true, Ordering::SeqCst);
    // Output still open past the end is a child the command left running; it is not waited for long.
    let mut closed = 0;
    while closed < streams && done_rx.recv_timeout(OUTPUT_GRACE).is_ok() {
        closed += 1;
    }
    let exit = match status {
        Ok(status) => match (status.code(), status.signal()) {
            (Some(code), _) => format!("code {code}"),
            (None, Some(signal)) => format!("signal {signal}"),
            (None, None) => "code 1".into(),
        },
        Err(_) => "code 1".into(),
    };
    let _ = send(out, frame::EXIT, exit.as_bytes());
    // That child — a server started with `&`, a bot — is read on until it closes its output, as the daemon reads a child
    // its own commands leave (`drain` in packages/runtime). Ending here closed the pipe, and the next line it printed
    // killed it: on a box with agents as their own users a `nohup python3 bot.py &` died two seconds after its command
    // (0.8.6). Not as root: what is left is reading pipes already open.
    if closed < streams {
        drain_unprivileged();
        while closed < streams && done_rx.recv().is_ok() {
            closed += 1;
        }
    }
    0
}

/// This process, root no longer: `nobody`, with no groups.
fn drain_unprivileged() {
    let (uid, gid) = lookup_user("nobody").map_or((NOBODY, NOBODY), |user| (user.uid, user.gid));
    unsafe {
        libc::setgroups(0, std::ptr::null());
        libc::setgid(gid);
        libc::setuid(uid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn landlock_required_on_a_kernel_without_it_is_a_refusal_and_otherwise_the_kernel_is_not_asked() {
        let absent = || Err("absent");
        assert_eq!(
            landlock_available(Mode::Require, absent).unwrap_err(),
            "Landlock is required ([security.exec] landlock) and this kernel's is absent"
        );
        assert!(landlock_available(Mode::Require, || Ok(4)).is_ok());
        let unasked = || -> Result<i64, &'static str> { panic!("the kernel was asked") };
        assert!(landlock_available(Mode::Auto, unasked).is_ok());
        assert!(landlock_available(Mode::Off, unasked).is_ok());
    }
}
