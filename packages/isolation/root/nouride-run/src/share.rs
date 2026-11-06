//! The daemon's folders an agent reaches, and how far (the RFC's §3).
//!
//! - The workspace: `shared/`, every agent's to read and write; `private/`, passed through to each agent's own folder
//!   (`fsafe::ensure_private`).
//! - The folders the daemon keeps per agent and the agent's commands read (`--reads`): its pack, its jobs' logs, its
//!   attachments, its tools' long output. `<root>/<agent>` is the service user's, group `nr-<agent>`, setgid: what the
//!   daemon writes there takes the agent's group, so the agent reads it and never writes it.
//! - The credentials directory, read by an agent granted `nr-creds`.
//!
//! Each folder stays the service user's; what changes is its group and the group's bits. Only entries the service user
//! owns are touched, a link is never followed, and a file is changed through a descriptor checked after it is opened —
//! `shared/` is writable by every agent, and a name swapped for a link to `/etc/shadow` meanwhile must change nothing.

use crate::fsafe::{check, cstr, entries, is_dir, open_at, open_dir, stat_at};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;

/// What a group may do with what it is given.
#[derive(Clone, Copy)]
enum Grant {
    Read,
    ReadWrite,
}

impl Grant {
    fn file_bits(self) -> libc::mode_t {
        match self {
            Grant::Read => libc::S_IRGRP,
            Grant::ReadWrite => libc::S_IRGRP | libc::S_IWGRP,
        }
    }

    /// A directory's: searchable, and setgid so what is made in it later takes the same group.
    fn dir_bits(self) -> libc::mode_t {
        self.file_bits() | libc::S_IXGRP | libc::S_ISGID
    }
}

fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    check(unsafe { libc::fstat(fd, &mut st) })?;
    Ok(st)
}

/// `fd` given `gid` and `bits`, where it lacks them. A file loses setuid and setgid: a bit that meant the service
/// group must not come to mean an agent's.
fn give(fd: RawFd, st: &libc::stat, gid: libc::gid_t, bits: libc::mode_t) -> io::Result<()> {
    if st.st_gid != gid {
        check(unsafe { libc::fchown(fd, libc::uid_t::MAX, gid) })?;
    }
    let keep = if is_dir(st) { 0o7777 } else { 0o0777 };
    let mode = st.st_mode & keep;
    if st.st_gid != gid || mode | bits != st.st_mode & 0o7777 {
        check(unsafe { libc::fchmod(fd, mode | bits) })?;
    }
    Ok(())
}

/// `name` in `dir`, opened without following a link and without blocking on a fifo — a directory or a regular file
/// the service user owns, checked on the descriptor; anything else, None.
fn open_owned(dir: RawFd, name: &[u8], service_uid: libc::uid_t) -> io::Result<Option<(OwnedFd, libc::stat)>> {
    let c = cstr(name)?;
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOCTTY;
    let fd = unsafe { libc::openat(dir, c.as_ptr(), flags) };
    if fd < 0 {
        let err = io::Error::last_os_error();
        return match err.raw_os_error() {
            Some(libc::ELOOP) | Some(libc::ENOENT) | Some(libc::ENXIO) => Ok(None),
            _ => Err(err),
        };
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let st = fstat(fd.as_raw_fd())?;
    let kind = st.st_mode & libc::S_IFMT;
    if st.st_uid != service_uid || (kind != libc::S_IFDIR && kind != libc::S_IFREG) {
        return Ok(None);
    }
    Ok(Some((fd, st)))
}

/// Everything under `dir` the service user owns given `gid` and `grant`. Best effort: an entry that cannot be changed —
/// gone meanwhile, nested past 64, refused by the filesystem — is left as it is and counted, never a reason to refuse
/// the agent's command. A real workspace holds hundreds of thousands, and one odd file must not stop every agent.
fn regroup(dir: RawFd, service_uid: libc::uid_t, gid: libc::gid_t, grant: Grant, depth: u32) -> u64 {
    if depth > 64 {
        return 1;
    }
    let Ok(names) = entries(dir) else {
        return 1;
    };
    let mut skipped = 0;
    for name in names {
        let (fd, st) = match open_owned(dir, &name, service_uid) {
            Ok(Some(found)) => found,
            Ok(None) => continue,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let bits = if is_dir(&st) {
            grant.dir_bits()
        } else {
            grant.file_bits()
        };
        if give(fd.as_raw_fd(), &st, gid, bits).is_err() {
            skipped += 1;
        }
        if is_dir(&st) {
            skipped += regroup(fd.as_raw_fd(), service_uid, gid, grant, depth + 1);
        }
    }
    skipped
}

/// Said in the journal (`journalctl -t nouride-run`), where an operator looks: what was left as it was, and where.
fn say_skipped(skipped: u64, what: &str) {
    if skipped > 0 {
        eprintln!("nouride-run: {what}: {skipped} entries could not be changed and were left as they were");
    }
}

/// A directory of the service user's that every agent passes through to its own folder and lists nothing in — not
/// which other agents there are: group `nr-agents`, `--x` for it, nothing for anyone else. One that is someone else's
/// — an operator's choice — is left as it is.
fn make_passable(dir: RawFd, service_uid: libc::uid_t, agents_gid: libc::gid_t) -> io::Result<()> {
    let st = fstat(dir)?;
    if st.st_uid != service_uid {
        return Ok(());
    }
    if st.st_gid != agents_gid {
        check(unsafe { libc::fchown(dir, libc::uid_t::MAX, agents_gid) })?;
    }
    let mode = (st.st_mode & 0o7700) | libc::S_IXGRP;
    if st.st_gid != agents_gid || st.st_mode & 0o7777 != mode {
        check(unsafe { libc::fchmod(dir, mode) })?;
    }
    Ok(())
}

/// `name` in `parent`: made, the service user's, when missing; refused when it is not a directory of the service
/// user's.
fn service_dir(parent: RawFd, name: &str, service_uid: libc::uid_t) -> Result<OwnedFd, String> {
    match stat_at(parent, name.as_bytes()) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            let c = cstr(name.as_bytes()).map_err(|e| e.to_string())?;
            check(unsafe { libc::mkdirat(parent, c.as_ptr(), 0o700) }).map_err(|err| format!("{name}: {err}"))?;
            check(unsafe {
                libc::fchownat(
                    parent,
                    c.as_ptr(),
                    service_uid,
                    libc::gid_t::MAX,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            })
            .map_err(|err| format!("{name}: {err}"))?;
        }
        Err(err) => return Err(format!("{name}: {err}")),
        Ok(st) if !is_dir(&st) || st.st_uid != service_uid => {
            return Err(format!("{name} is not a directory of the service user's"))
        }
        Ok(_) => {}
    }
    open_at(parent, name.as_bytes()).map_err(|err| format!("{name}: {err}"))
}

/// The workspace, `private/` passed through to each agent's folder, and `shared/` — every agent's to read and write,
/// `2770`, group `nr-agents`. What the daemon put in `shared/` before is given the group once, the first time.
pub fn ensure_workspace(workspace: &Path, service_uid: libc::uid_t, agents_gid: libc::gid_t) -> Result<(), String> {
    let at = |err: io::Error| format!("{}: {err}", workspace.display());
    let root = open_dir(workspace).map_err(at)?;
    make_passable(root.as_raw_fd(), service_uid, agents_gid).map_err(at)?;
    let private = service_dir(root.as_raw_fd(), "private", service_uid)?;
    make_passable(private.as_raw_fd(), service_uid, agents_gid).map_err(|err| format!("private: {err}"))?;
    let shared = service_dir(root.as_raw_fd(), "shared", service_uid)?;
    let st = fstat(shared.as_raw_fd()).map_err(|err| format!("shared: {err}"))?;
    if st.st_gid != agents_gid || st.st_mode & 0o7777 != 0o2770 {
        say_skipped(
            regroup(shared.as_raw_fd(), service_uid, agents_gid, Grant::ReadWrite, 0),
            "giving shared/ to every agent",
        );
        check(unsafe { libc::fchown(shared.as_raw_fd(), libc::uid_t::MAX, agents_gid) })
            .map_err(|err| format!("shared: {err}"))?;
        check(unsafe { libc::fchmod(shared.as_raw_fd(), 0o2770) }).map_err(|err| format!("shared: {err}"))?;
    }
    Ok(())
}

/// `<root>/<agent>`, one of the folders the daemon keeps for an agent: made when missing, the service user's, group
/// `nr-<agent>`, `2750`. What the daemon kept there before is given the group once, the first time; after that the
/// setgid bit gives it, and the daemon writes what its agent reads `0640`. The root itself only passes agents through.
/// A root the daemon has not made yet has nothing to share.
pub fn share_with_agent(
    root: &Path,
    agent: &str,
    service_uid: libc::uid_t,
    agents_gid: libc::gid_t,
    agent_gid: libc::gid_t,
) -> Result<(), String> {
    let at = |err: io::Error| format!("{}: {err}", root.display());
    let top = match open_dir(root) {
        Ok(fd) => fd,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(at(err)),
    };
    make_passable(top.as_raw_fd(), service_uid, agents_gid).map_err(at)?;
    let folder =
        service_dir(top.as_raw_fd(), agent, service_uid).map_err(|reason| format!("{}: {reason}", root.display()))?;
    let st = fstat(folder.as_raw_fd()).map_err(at)?;
    if st.st_gid != agent_gid || st.st_mode & 0o7777 != 0o2750 {
        say_skipped(
            regroup(folder.as_raw_fd(), service_uid, agent_gid, Grant::Read, 0),
            &format!("sharing {}/{agent}", root.display()),
        );
        check(unsafe { libc::fchown(folder.as_raw_fd(), libc::uid_t::MAX, agent_gid) }).map_err(at)?;
        check(unsafe { libc::fchmod(folder.as_raw_fd(), 0o2750) }).map_err(at)?;
    }
    Ok(())
}

/// The credentials directory, read by `nr-creds`: `2750`, and each file in it the group's to read. Every time, not
/// once: a key is put there by hand, after the fact, and the agents allowed it should not wait for anything. It holds
/// a few files. Left as it is when it is not the service user's, or not there.
pub fn ensure_credentials(dir: &Path, service_uid: libc::uid_t, creds_gid: libc::gid_t) -> Result<(), String> {
    let at = |err: io::Error| format!("{}: {err}", dir.display());
    let fd = match open_dir(dir) {
        Ok(fd) => fd,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(at(err)),
    };
    let st = fstat(fd.as_raw_fd()).map_err(at)?;
    if st.st_uid != service_uid {
        return Ok(());
    }
    say_skipped(
        regroup(fd.as_raw_fd(), service_uid, creds_gid, Grant::Read, 0),
        &format!("sharing {}", dir.display()),
    );
    give(fd.as_raw_fd(), &st, creds_gid, Grant::Read.dir_bits()).map_err(at)
}
