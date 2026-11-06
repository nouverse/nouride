//! One request: what to run, and for which agent. Read whole before anything is done with it.

use crate::frame::{self, read_frame, write_frame};
use crate::landlock::Mode;
use std::io::{self, Read, Write};

pub const PROTOCOL: &str = "1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    /// Run `argv` as the agent.
    Run,
    /// Set the agent's groups to `groups` — only groups this helper hands out.
    Groups,
    /// The helper's version and the workspace it serves, so the daemon can check it is the one it expects.
    Info,
}

#[derive(Debug, Default)]
pub struct Request {
    pub op: Option<Op>,
    pub agent: String,
    pub argv: Vec<Vec<u8>>,
    pub cwd: Option<Vec<u8>>,
    pub env: Vec<Vec<u8>>,
    pub groups: Vec<String>,
    pub landlock: Mode,
    pub writable: Vec<Vec<u8>>,
}

/// Bounds a request is held to, so a client cannot make the root process hold an unbounded one.
const MAX_ARGS: usize = 4096;
const MAX_ENV: usize = 1024;
const MAX_WRITABLE: usize = 64;
const MAX_TOTAL: usize = 8 * 1024 * 1024;

/// Ids an agent may not have, whatever the pattern says: the names `agents/` reserves, and `root`.
const RESERVED: &[&str] = &["root", "shared", "skills"];

/// An agent id that can be a user's name: `nr-` and at most 29 more of `[a-z0-9-]`, starting with a letter or digit.
/// Everything else names nothing — `../root`, `root`, `Nouva`, an empty id.
pub fn valid_agent(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 29
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && !RESERVED.contains(&id)
}

/// The user an agent's commands run as.
pub fn user_of(agent: &str) -> String {
    format!("nr-{agent}")
}

impl Request {
    pub fn write_to(&self, out: &mut impl Write) -> io::Result<()> {
        write_frame(out, frame::VERSION, PROTOCOL.as_bytes())?;
        let op = match self.op {
            Some(Op::Run) | None => "run",
            Some(Op::Groups) => "groups",
            Some(Op::Info) => "info",
        };
        write_frame(out, frame::OP, op.as_bytes())?;
        write_frame(out, frame::AGENT, self.agent.as_bytes())?;
        for arg in &self.argv {
            write_frame(out, frame::ARG, arg)?;
        }
        if let Some(cwd) = &self.cwd {
            write_frame(out, frame::CWD, cwd)?;
        }
        for pair in &self.env {
            write_frame(out, frame::ENV, pair)?;
        }
        for group in &self.groups {
            write_frame(out, frame::GROUP, group.as_bytes())?;
        }
        write_frame(out, frame::LANDLOCK, self.landlock.name().as_bytes())?;
        for dir in &self.writable {
            write_frame(out, frame::WRITABLE, dir)?;
        }
        write_frame(out, frame::END, b"")
    }

    /// Read a request up to its end frame. An error is a reason, said to the client as a refusal.
    pub fn read_from(input: &mut impl Read) -> Result<Request, String> {
        let mut request = Request::default();
        let mut total = 0usize;
        let mut version = false;
        loop {
            let (kind, payload) = match read_frame(input) {
                Ok(Some(frame)) => frame,
                Ok(None) => return Err("the request ended before its end".into()),
                Err(err) => return Err(format!("the request could not be read: {err}")),
            };
            total += payload.len();
            if total > MAX_TOTAL {
                return Err("the request is too large".into());
            }
            match kind {
                frame::VERSION => {
                    if payload != PROTOCOL.as_bytes() {
                        return Err(format!(
                            "protocol {} is not this helper's ({PROTOCOL})",
                            String::from_utf8_lossy(&payload)
                        ));
                    }
                    version = true;
                }
                frame::OP => {
                    request.op = Some(match payload.as_slice() {
                        b"run" => Op::Run,
                        b"groups" => Op::Groups,
                        b"info" => Op::Info,
                        other => return Err(format!("no such operation: {}", String::from_utf8_lossy(other))),
                    })
                }
                frame::AGENT => {
                    request.agent = String::from_utf8(payload).map_err(|_| "an agent id is text".to_string())?
                }
                frame::ARG => {
                    if request.argv.len() >= MAX_ARGS {
                        return Err("too many arguments".into());
                    }
                    if payload.contains(&0) {
                        return Err("an argument holds a NUL byte".into());
                    }
                    request.argv.push(payload);
                }
                frame::CWD => {
                    if payload.contains(&0) {
                        return Err("the working directory holds a NUL byte".into());
                    }
                    request.cwd = Some(payload);
                }
                frame::ENV => {
                    if request.env.len() >= MAX_ENV {
                        return Err("too many environment variables".into());
                    }
                    let eq = payload.iter().position(|b| *b == b'=');
                    if eq.is_none() || eq == Some(0) || payload.contains(&0) {
                        return Err("an environment variable is not NAME=value".into());
                    }
                    request.env.push(payload);
                }
                frame::GROUP => request
                    .groups
                    .push(String::from_utf8(payload).map_err(|_| "a group is text".to_string())?),
                frame::LANDLOCK => {
                    request.landlock = Mode::parse(&payload).ok_or("landlock is off, auto or require".to_string())?
                }
                frame::WRITABLE => {
                    if request.writable.len() >= MAX_WRITABLE {
                        return Err("too many writable folders".into());
                    }
                    if payload.first() != Some(&b'/') || payload.contains(&0) {
                        return Err("a writable folder is an absolute path".into());
                    }
                    request.writable.push(payload);
                }
                frame::END => break,
                other => return Err(format!("unknown request field {other}")),
            }
        }
        if !version {
            return Err("the request names no protocol version".into());
        }
        if request.op.is_none() {
            return Err("the request names no operation".into());
        }
        if request.op != Some(Op::Info) && !valid_agent(&request.agent) {
            return Err(format!(
                "{:?} is not an agent id this helper runs as — [a-z0-9-], at most 29, not reserved",
                request.agent
            ));
        }
        if request.op == Some(Op::Run) && request.argv.is_empty() {
            return Err("nothing to run".into());
        }
        Ok(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_id_is_a_user_name_or_nothing() {
        for ok in ["nouva", "nix", "a", "agent-2", "0day", "a2345678901234567890123456789"] {
            assert!(valid_agent(ok), "{ok}");
        }
        for bad in [
            "",
            "../root",
            "root",
            "shared",
            "skills",
            "Nouva",
            "nou va",
            "-x",
            "a/b",
            "nouva\n",
            "a234567890123456789012345678901",
        ] {
            assert!(!valid_agent(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_request_reads_back_as_written() {
        let request = Request {
            op: Some(Op::Run),
            agent: "nouva".into(),
            argv: vec![b"ls".to_vec(), b"-la".to_vec()],
            cwd: Some(b"/tmp".to_vec()),
            env: vec![b"PATH=/usr/bin".to_vec()],
            groups: vec![],
            landlock: Mode::Require,
            writable: vec![b"/srv/project".to_vec()],
        };
        let mut wire = Vec::new();
        request.write_to(&mut wire).unwrap();
        let read = Request::read_from(&mut wire.as_slice()).unwrap();
        assert_eq!(read.argv, request.argv);
        assert_eq!(read.cwd, request.cwd);
        assert_eq!(read.env, request.env);
        assert_eq!(read.landlock, Mode::Require);
        assert_eq!(read.writable, request.writable);
    }

    /// A request as the wire may carry it, frame by frame: what `write_to` would never make.
    fn wire(frames: &[(u8, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (kind, payload) in frames {
            write_frame(&mut out, *kind, payload).unwrap();
        }
        out
    }

    fn refusal(frames: &[(u8, &[u8])]) -> String {
        Request::read_from(&mut wire(frames).as_slice()).unwrap_err()
    }

    #[test]
    fn a_request_of_another_protocol_or_past_its_bounds_is_a_reason_not_a_run() {
        let v1 = (frame::VERSION, PROTOCOL.as_bytes());
        let run = (frame::OP, &b"run"[..]);
        let agent = (frame::AGENT, &b"nouva"[..]);
        let id = (frame::ARG, &b"id"[..]);
        let end = (frame::END, &b""[..]);
        assert!(refusal(&[run, agent, id, end]).contains("names no protocol version"));
        assert!(refusal(&[(frame::VERSION, &b"2"[..]), run, agent, id, end]).contains("is not this helper's"));
        // A NUL ends a C string early: what reached `execve` would not be what was asked, nor what the audit shows.
        assert!(refusal(&[v1, run, agent, (frame::ARG, &b"echo x\0y"[..]), end]).contains("NUL byte"));
        assert!(refusal(&[v1, run, agent, id, (frame::CWD, &b"/tmp\0/etc"[..]), end]).contains("NUL byte"));
        // A writable folder is named whole, or Landlock would read it against wherever the helper stands.
        assert!(refusal(&[v1, run, agent, id, (frame::WRITABLE, &b"relative/dir"[..]), end]).contains("absolute path"));
        // Bounded, so a client cannot make the root process hold what it likes: three frames of 3 MB pass 8 MB.
        let big = vec![b'x'; 3 * 1024 * 1024];
        let arg = (frame::ARG, big.as_slice());
        assert_eq!(
            refusal(&[v1, run, agent, arg, arg, arg, end]),
            "the request is too large"
        );
    }

    #[test]
    fn a_bad_request_is_a_reason_not_a_run() {
        let mut wire = Vec::new();
        Request {
            op: Some(Op::Run),
            agent: "../root".into(),
            argv: vec![b"id".to_vec()],
            ..Default::default()
        }
        .write_to(&mut wire)
        .unwrap();
        assert!(Request::read_from(&mut wire.as_slice())
            .unwrap_err()
            .contains("not an agent id"));

        let mut empty = Vec::new();
        Request {
            op: Some(Op::Run),
            agent: "nouva".into(),
            ..Default::default()
        }
        .write_to(&mut empty)
        .unwrap();
        assert_eq!(Request::read_from(&mut empty.as_slice()).unwrap_err(), "nothing to run");

        let mut env = Vec::new();
        Request {
            op: Some(Op::Run),
            agent: "nouva".into(),
            argv: vec![b"id".to_vec()],
            env: vec![b"=x".to_vec()],
            ..Default::default()
        }
        .write_to(&mut env)
        .unwrap();
        assert!(Request::read_from(&mut env.as_slice())
            .unwrap_err()
            .contains("NAME=value"));
    }
}
