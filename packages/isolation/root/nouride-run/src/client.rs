//! The daemon's side, as a program the daemon runs like any other: `nouride-run exec --agent nouva -- ls -la`.
//!
//! Its environment, working directory, stdin, stdout, stderr and exit are the command's — passed to the helper and
//! back — so everything the daemon already does with a child (a timeout, capped output, a process group to stop, the
//! commands cgroup) works unchanged, and stopping this process is stopping the command. It never runs the command
//! itself as the daemon's user: a helper that cannot be reached is an error, not a fallback.

use crate::frame::{self, read_frame, write_frame};
use crate::landlock::Mode;
use crate::request::{Op, Request};
use crate::serve::{prepare, Settings};
use std::io::{self, Read, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::thread;

/// Exit codes of its own, for what never reached the command: the helper refused, or could not be reached.
pub const EXIT_REFUSED: i32 = 125;

pub struct Target {
    /// `/run/nouride-run.sock`, or none to act as the helper in this process — a daemon running as root, on a Box.
    pub socket: Option<PathBuf>,
    /// For acting as the helper here: what the unit would have said.
    pub local: Option<Settings>,
}

fn connect(target: &Target) -> io::Result<UnixStream> {
    let path = target
        .socket
        .as_ref()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no socket"))?;
    UnixStream::connect(path).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!("the helper is not answering at {}: {err}", path.display()),
        )
    })
}

/// Send a request, then pass frames back as this process's output until the command's exit — which this process then
/// takes as its own.
fn converse(stream: UnixStream, request: &Request, forward_stdin: bool, pid_file: Option<&PathBuf>) -> i32 {
    let mut writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(err) => return refused(&err.to_string()),
    };
    if let Err(err) = request.write_to(&mut writer) {
        return refused(&format!("the request could not be sent: {err}"));
    }
    if forward_stdin {
        thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if write_frame(&mut writer, frame::STDIN, &buf[..n]).is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = write_frame(&mut writer, frame::STDIN_CLOSED, b"");
        });
    }
    let mut reader = stream;
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr();
    loop {
        match read_frame(&mut reader) {
            Ok(Some((frame::STDOUT, data))) => {
                let _ = stdout.write_all(&data);
                let _ = stdout.flush();
            }
            Ok(Some((frame::STDERR, data))) => {
                let _ = stderr.write_all(&data);
            }
            // Where the daemon reads what the command is doing: its process group, the helper's child — not this
            // process, which only waits. Written once, by the daemon's user, in the daemon's own temporary folder.
            Ok(Some((frame::STARTED, pid))) => {
                if let Some(path) = pid_file {
                    let _ = std::fs::write(path, &pid);
                }
            }
            Ok(Some((frame::REFUSED, reason))) => return refused(&String::from_utf8_lossy(&reason)),
            Ok(Some((frame::EXIT, status))) => return exit_as(&String::from_utf8_lossy(&status)),
            Ok(Some(_)) => continue,
            Ok(None) => return refused("the helper closed the connection before the command ended"),
            Err(err) => return refused(&format!("the connection broke: {err}")),
        }
    }
}

fn refused(reason: &str) -> i32 {
    eprintln!("nouride-run: {reason}");
    EXIT_REFUSED
}

/// The command's end, as this process's: its code, or the same signal.
fn exit_as(status: &str) -> i32 {
    let mut parts = status.split(' ');
    let (kind, value) = (parts.next(), parts.next().and_then(|v| v.parse::<i32>().ok()));
    match (kind, value) {
        (Some("code"), Some(code)) => code,
        (Some("signal"), Some(signal)) => unsafe {
            let _ = io::stdout().flush();
            libc::signal(signal, libc::SIG_DFL);
            libc::raise(signal);
            128 + signal
        },
        _ => refused(&format!("an exit it cannot read: {status}")),
    }
}

/// `exec`: run `argv` as `agent`, here and now.
/// What `exec` asks for, beyond the command.
pub struct Exec {
    pub agent: String,
    pub cwd: Option<PathBuf>,
    pub argv: Vec<Vec<u8>>,
    pub pid_file: Option<PathBuf>,
    pub landlock: Mode,
    pub writable: Vec<PathBuf>,
}

pub fn exec(target: &Target, exec: Exec) -> i32 {
    let Exec {
        agent,
        cwd,
        argv,
        pid_file,
        landlock,
        writable,
    } = exec;
    let cwd = cwd
        .or_else(|| std::env::current_dir().ok())
        .map(|path| path.into_os_string().into_vec());
    let env = std::env::vars_os()
        .map(|(name, value)| {
            let mut pair = name.as_bytes().to_vec();
            pair.push(b'=');
            pair.extend_from_slice(value.as_bytes());
            pair
        })
        .collect();
    let request = Request {
        op: Some(Op::Run),
        agent,
        argv,
        cwd,
        env,
        groups: vec![],
        landlock,
        writable: writable
            .into_iter()
            .map(|dir| dir.into_os_string().into_vec())
            .collect(),
    };
    if let Some(settings) = &target.local {
        return exec_here(settings, &request);
    }
    match connect(target) {
        Ok(stream) => converse(stream, &request, true, pid_file.as_ref()),
        Err(err) => refused(&err.to_string()),
    }
}

/// A daemon that is root runs the command through the same rules, in this process: no socket, no second process.
fn exec_here(settings: &Settings, request: &Request) -> i32 {
    if unsafe { libc::geteuid() } != 0 {
        return refused("--local is for a daemon running as root");
    }
    // Validated as the helper validates a request read from the wire.
    let mut wire = Vec::new();
    if let Err(err) = request.write_to(&mut wire) {
        return refused(&err.to_string());
    }
    let request = match Request::read_from(&mut wire.as_slice()) {
        Ok(request) => request,
        Err(reason) => return refused(&reason),
    };
    let Some(service) = crate::account::lookup_user(&settings.service_user) else {
        return refused(&format!("the service user {} does not exist", settings.service_user));
    };
    match prepare(settings, &service, 0, &request) {
        Ok(becoming) => {
            let err = unsafe { becoming.become_and_exec() };
            eprintln!("nouride-run: {err}");
            if err.raw_os_error() == Some(libc::ENOENT) {
                127
            } else {
                126
            }
        }
        Err(reason) => refused(&reason),
    }
}

/// `groups`: set what the agent may be granted, exactly.
pub fn groups(target: &Target, agent: String, groups: Vec<String>) -> i32 {
    let request = Request {
        op: Some(Op::Groups),
        agent,
        groups,
        ..Default::default()
    };
    if target.local.is_some() {
        return match crate::account::set_groups(&request.agent, &request.groups) {
            Ok(()) => 0,
            Err(reason) => refused(&reason),
        };
    }
    match connect(target) {
        Ok(stream) => converse(stream, &request, false, None),
        Err(err) => refused(&err.to_string()),
    }
}

/// `info`: the helper's version and the workspace it serves.
pub fn info(target: &Target) -> i32 {
    if let Some(settings) = &target.local {
        print!("{}", settings.describe());
        return 0;
    }
    let request = Request {
        op: Some(Op::Info),
        ..Default::default()
    };
    match connect(target) {
        Ok(stream) => converse(stream, &request, false, None),
        Err(err) => refused(&err.to_string()),
    }
}
