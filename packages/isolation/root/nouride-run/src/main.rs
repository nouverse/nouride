//! nouride-run — a Nouride agent's command, run as that agent's own user.
//!
//!   nouride-run serve --workspace <dir> [--reads <dir>]… [--credentials <dir>] --service-user <name>
//!                                                    the helper, one connection on stdin/stdout (root)
//!   nouride-run exec [--socket <path>] --agent <id> [--cwd <dir>] [--pid-file <path>]
//!                    [--landlock off|auto|require] [--writable <dir>]… -- <command>…
//!   nouride-run exec --local --workspace <dir> [--reads <dir>]… [--credentials <dir>] --service-user <name> …
//!                                                    the same, for a daemon that is root, in this process
//!   nouride-run put --to <path>                      stdin into a file, as whoever runs it — through `exec`
//!   nouride-run groups [--socket <path>] --agent <id> [--group <name>]…
//!   nouride-run info [--socket <path>]
//!
//! The rules are in `serve.rs` and the files it uses, and nowhere else: see `packages/isolation/README.md`.

mod account;
mod client;
mod drop;
mod frame;
mod fsafe;
mod landlock;
mod put;
mod request;
mod serve;
mod share;

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

const DEFAULT_SOCKET: &str = "/run/nouride-run.sock";

fn usage() -> i32 {
    eprintln!(
        "usage: nouride-run serve --workspace <dir> [--reads <dir>]... [--credentials <dir>] --service-user <name>\n       nouride-run exec [--socket <path> | --local --workspace <dir> [--reads <dir>]... [--credentials <dir>] --service-user <name>] --agent <id> [--cwd <dir>] [--pid-file <path>] [--landlock off|auto|require] [--writable <dir>]... -- <command>...\n       nouride-run put --to <path>\n       nouride-run groups [--socket <path>] --agent <id> [--group <name>]...\n       nouride-run info [--socket <path>]"
    );
    2
}

struct Args {
    socket: Option<PathBuf>,
    local: bool,
    workspace: Option<PathBuf>,
    reads: Vec<PathBuf>,
    credentials: Option<PathBuf>,
    service_user: Option<String>,
    agent: Option<String>,
    cwd: Option<PathBuf>,
    pid_file: Option<PathBuf>,
    groups: Vec<String>,
    landlock: landlock::Mode,
    writable: Vec<PathBuf>,
    to: Option<PathBuf>,
    command: Vec<Vec<u8>>,
}

fn parse(mut rest: impl Iterator<Item = OsString>) -> Option<Args> {
    let mut args = Args {
        socket: None,
        local: false,
        workspace: None,
        reads: vec![],
        credentials: None,
        service_user: None,
        agent: None,
        cwd: None,
        pid_file: None,
        groups: vec![],
        landlock: landlock::Mode::Off,
        writable: vec![],
        to: None,
        command: vec![],
    };
    while let Some(arg) = rest.next() {
        let text = arg.to_str()?.to_string();
        let mut value = || rest.next().and_then(|v| v.into_string().ok());
        match text.as_str() {
            "--socket" => args.socket = Some(PathBuf::from(value()?)),
            "--local" => args.local = true,
            "--workspace" => args.workspace = Some(PathBuf::from(value()?)),
            "--reads" => args.reads.push(PathBuf::from(value()?)),
            "--credentials" => args.credentials = Some(PathBuf::from(value()?)),
            "--service-user" => args.service_user = Some(value()?),
            "--agent" => args.agent = Some(value()?),
            "--cwd" => args.cwd = Some(PathBuf::from(value()?)),
            "--pid-file" => args.pid_file = Some(PathBuf::from(value()?)),
            "--group" => args.groups.push(value()?),
            "--landlock" => args.landlock = landlock::Mode::parse(value()?.as_bytes())?,
            "--writable" => args.writable.push(PathBuf::from(value()?)),
            "--to" => args.to = Some(PathBuf::from(value()?)),
            "--" => {
                args.command = rest.map(|arg| arg.into_vec()).collect();
                break;
            }
            _ => return None,
        }
    }
    Some(args)
}

fn settings(args: &Args) -> Option<serve::Settings> {
    let settings = serve::Settings {
        workspace: args.workspace.clone()?,
        reads: args.reads.clone(),
        credentials: args.credentials.clone(),
        service_user: args.service_user.clone()?,
    };
    // Every folder it changes as root is named whole by the unit; a relative one would be wherever it was started.
    let absolute = settings.workspace.is_absolute()
        && settings.reads.iter().all(|dir| dir.is_absolute())
        && settings.credentials.as_ref().is_none_or(|dir| dir.is_absolute());
    absolute.then_some(settings)
}

fn main() {
    let mut all = std::env::args_os().skip(1);
    let Some(verb) = all.next().and_then(|v| v.into_string().ok()) else {
        std::process::exit(usage());
    };
    if verb == "--version" {
        println!("nouride-run {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let Some(args) = parse(all) else {
        std::process::exit(usage());
    };
    let target = || -> Option<client::Target> {
        if args.local {
            Some(client::Target {
                socket: None,
                local: Some(settings(&args)?),
            })
        } else {
            Some(client::Target {
                socket: Some(args.socket.clone().unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET))),
                local: None,
            })
        }
    };
    let code = match verb.as_str() {
        "serve" => match settings(&args) {
            Some(settings) => serve::serve(&settings),
            _ => usage(),
        },
        "exec" => match (target(), args.agent.clone()) {
            (Some(target), Some(agent)) if !args.command.is_empty() => client::exec(
                &target,
                client::Exec {
                    agent,
                    cwd: args.cwd.clone(),
                    argv: args.command.clone(),
                    pid_file: args.pid_file.clone(),
                    landlock: args.landlock,
                    writable: args.writable.clone(),
                },
            ),
            _ => usage(),
        },
        "put" => match &args.to {
            Some(to) if to.is_absolute() => put::put(to),
            _ => usage(),
        },
        "groups" => match (target(), args.agent.clone()) {
            (Some(target), Some(agent)) => client::groups(&target, agent, args.groups.clone()),
            _ => usage(),
        },
        "info" => match target() {
            Some(target) => client::info(&target),
            None => usage(),
        },
        _ => usage(),
    };
    std::process::exit(code);
}
