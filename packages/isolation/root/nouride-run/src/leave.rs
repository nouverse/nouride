//! What a removed agent's user leaves behind (`account::remove_user`): its processes, ended, and its files, handed to
//! the service user. As root throughout: the user being removed can signal a process that has become it, and write in
//! the folders being walked, so neither is trusted here.

use crate::fsafe::{check, cstr, entries, is_dir};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;
use std::thread;
use std::time::Duration;

/// A process as `/proc` lists it: its real, effective, saved and filesystem ids, its state's letter and its cgroup.
struct Seen {
    pid: libc::pid_t,
    uids: Vec<libc::uid_t>,
    zombie: bool,
}

/// `Uid:` and `State:` of a `/proc/<pid>/status`. None for a process that went away while it was read.
fn seen(pid: libc::pid_t) -> Option<Seen> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let line = |name: &str| status.lines().find_map(|line| line.strip_prefix(name));
    let uids = line("Uid:")?
        .split_whitespace()
        .filter_map(|one| one.parse().ok())
        .collect();
    let zombie = line("State:").is_some_and(|state| state.trim_start().starts_with('Z'));
    Some(Seen { pid, uids, zombie })
}

/// Every process that holds `uid` in any of its four ids and is not already dead and waiting to be reaped.
fn living(uid: libc::uid_t) -> Vec<libc::pid_t> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<libc::pid_t>().ok())
        .filter_map(seen)
        .filter(|process| !process.zombie && process.uids.contains(&uid))
        .map(|process| process.pid)
        .collect()
}

/// Whether a process in cgroup `theirs` is outside the daemon's, `daemon`: neither in it nor under it. With no cgroup
/// of the daemon's to compare with (none read, or the root of the tree, as inside a container), nothing is outside.
pub fn outside(daemon: Option<&str>, theirs: &str) -> bool {
    match daemon {
        None | Some("/") | Some("") => false,
        Some(daemon) => theirs != daemon && !theirs.starts_with(&format!("{}/", daemon.trim_end_matches('/'))),
    }
}

fn cgroup_of(pid: libc::pid_t) -> Option<String> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::to_string)
}

/// A process of `uid` that runs outside the daemon's cgroup: not an agent's command, which the helper puts there
/// (`serve::command_cgroup`), but something else on the machine under the same number, a container's user most
/// often. Its pid, so the refusal names it.
pub fn stranger(uid: libc::uid_t, daemon: Option<&str>) -> Option<libc::pid_t> {
    living(uid)
        .into_iter()
        .find(|pid| cgroup_of(*pid).is_some_and(|theirs| outside(daemon, &theirs)))
}

/// `signal` to `pid`, through a descriptor of the process itself and only while it still holds `uid`: a number read
/// from `/proc` may be another process's by the time it is signalled, and a descriptor is not.
fn signal(pid: libc::pid_t, uid: libc::uid_t, signal: libc::c_int) {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return;
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd as RawFd) };
    // Read after the descriptor is held: if the number now names another process, either it is not `uid`'s and is
    // left, or it is and the signal goes to the one the descriptor holds, which is gone.
    if seen(pid).is_some_and(|process| process.uids.contains(&uid)) {
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
    }
}

/// How many rounds `uid`'s processes are stopped and killed in before the removal gives up, and the pause between two.
const ROUNDS: u32 = 50;
const ROUND_PAUSE: Duration = Duration::from_millis(40);

/// Every process of `uid` ended, by root: stopped first, so none forks while the rest are killed, then killed, round
/// after round until `/proc` lists none alive. Not by a child that becomes `uid` and signals all it may: the processes
/// being ended could kill or stop that child first, and the removal would go on over a user still running. Never for
/// root. An error when they outlast every round: nothing is handed over or removed then.
pub fn end_processes(uid: libc::uid_t) -> Result<(), String> {
    if uid == 0 {
        return Err("root's processes are never ended".into());
    }
    for _ in 0..ROUNDS {
        let alive = living(uid);
        if alive.is_empty() {
            return Ok(());
        }
        for pid in &alive {
            signal(*pid, uid, libc::SIGSTOP);
        }
        for pid in living(uid) {
            signal(pid, uid, libc::SIGKILL);
        }
        thread::sleep(ROUND_PAUSE);
    }
    Err(format!(
        "uid {uid}'s processes could not be ended, so nothing of it was removed"
    ))
}

/// Which entries a walk changes hands: the user's become the service user's, and the user's own group's become the
/// service group's, so that neither number, given out again, reaches them.
#[derive(Clone, Copy)]
pub struct Handing {
    pub uid: libc::uid_t,
    pub gid: libc::gid_t,
    pub to_uid: libc::uid_t,
    pub to_gid: libc::gid_t,
}

/// An entry of `dir`, held without following it where it is a link: what is checked is what is changed, whatever is
/// done to the name meanwhile.
fn hold(dir: RawFd, name: &[u8]) -> io::Result<(OwnedFd, libc::stat)> {
    let name = cstr(name)?;
    let fd = check(unsafe { libc::openat(dir, name.as_ptr(), libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) })?;
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    check(unsafe { libc::fstat(fd.as_raw_fd(), &mut st) })?;
    Ok((fd, st))
}

/// The held entry given to the service user, or its group, where it is the removed user's. True when it could not be.
fn give(fd: RawFd, st: &libc::stat, handing: Handing) -> bool {
    let uid = if st.st_uid == handing.uid {
        handing.to_uid
    } else {
        libc::uid_t::MAX
    };
    let gid = if st.st_gid == handing.gid {
        handing.to_gid
    } else {
        libc::gid_t::MAX
    };
    if uid == libc::uid_t::MAX && gid == libc::gid_t::MAX {
        return false;
    }
    unsafe { libc::fchownat(fd, c"".as_ptr(), uid, gid, libc::AT_EMPTY_PATH) != 0 }
}

/// Everything under `dir` that is the removed user's, or its group's, handed over: each entry held first (`hold`), a
/// link itself and never what it points at, a hard link to somebody else's file left as theirs. `everywhere`: every
/// real directory is gone into, as in `shared/`, where the user's files may lie in another agent's folder; without
/// it only the user's own, as in a temporary folder of the machine's. How many entries could not be changed.
pub fn hand_over(dir: RawFd, handing: Handing, everywhere: bool, depth: u32) -> u64 {
    if depth > 64 {
        return 1;
    }
    let Ok(names) = entries(dir) else {
        return 1;
    };
    let mut left = 0;
    for name in names {
        let (fd, st) = match hold(dir, &name) {
            Ok(held) => held,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                left += 1;
                continue;
            }
        };
        let own = st.st_uid == handing.uid;
        if give(fd.as_raw_fd(), &st, handing) {
            left += 1;
        }
        if is_dir(&st) && (everywhere || own) {
            // The same directory the descriptor holds, opened to be listed: not the name again.
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            let listed = unsafe { libc::openat(fd.as_raw_fd(), c".".as_ptr(), flags) };
            if listed < 0 {
                left += 1;
                continue;
            }
            let listed = unsafe { OwnedFd::from_raw_fd(listed) };
            left += hand_over(listed.as_raw_fd(), handing, everywhere, depth + 1);
        }
    }
    left
}

/// `path` walked (`hand_over`), and the folder itself handed over where it is the user's. A folder that is not there
/// holds nothing of the user's.
pub fn hand_over_at(path: &Path, handing: Handing, everywhere: bool) -> Result<u64, String> {
    let dir = match crate::fsafe::open_dir(path) {
        Ok(dir) => dir,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(0),
        // A link where a folder should be, or a folder closed to root on this filesystem: said, and nothing removed.
        Err(err) => return Err(format!("{}: {err}", path.display())),
    };
    let mut left = hand_over(dir.as_raw_fd(), handing, everywhere, 0);
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(dir.as_raw_fd(), &mut st) } == 0 && give(dir.as_raw_fd(), &st, handing) {
        left += 1;
    }
    Ok(left)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn a_process_outside_the_daemons_cgroup_is_a_strangers() {
        let daemon = Some("/system.slice/nouride.service");
        assert!(!outside(daemon, "/system.slice/nouride.service"));
        assert!(!outside(daemon, "/system.slice/nouride.service/commands"));
        // A container's, a login's, and one whose name only starts the same.
        assert!(outside(daemon, "/system.slice/docker-3f2a.scope"));
        assert!(outside(daemon, "/user.slice/user-1000.slice/session-3.scope"));
        assert!(outside(daemon, "/system.slice/nouride.service-other"));
        assert!(outside(daemon, "/"));
        // Nothing to compare with: inside a container every process is at the root of the tree.
        assert!(!outside(None, "/system.slice/docker-3f2a.scope"));
        assert!(!outside(Some("/"), "/anything"));
    }

    #[test]
    fn roots_processes_are_never_ended() {
        assert_eq!(end_processes(0).unwrap_err(), "root's processes are never ended");
    }

    #[test]
    fn a_uid_with_no_process_is_ended_at_once_and_this_process_is_seen_as_its_own_users() {
        // No user holds this number on a machine the tests run on.
        assert_eq!(end_processes(3_999_999_931), Ok(()));
        let me = unsafe { libc::getuid() };
        assert!(living(me).contains(&(std::process::id() as libc::pid_t)));
        assert!(stranger(3_999_999_931, Some("/system.slice/nouride.service")).is_none());
    }

    /// The walk, as far as it can be seen without being root: it finds what is the user's, never follows a link, and
    /// goes into another's folder only where asked to. Handing a file to its own owner changes nothing and fails
    /// nowhere, so what it would change is read from what it leaves.
    #[test]
    fn the_walk_holds_each_entry_and_never_follows_a_link() {
        // Under /tmp itself: the walk opens a path one folder at a time from the root, and every folder on the way has
        // to be one this test's user can list.
        let root = Path::new("/tmp").join(format!("nr-leave-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("mine/deep")).unwrap();
        std::fs::write(root.join("mine/deep/file"), b"x").unwrap();
        std::fs::write(root.join("outside"), b"x").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.join("mine/link")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("mine/loop")).unwrap();
        let me = unsafe { libc::getuid() };
        let my_gid = std::fs::metadata(&root).unwrap().gid();
        let handing = Handing {
            uid: me,
            gid: my_gid,
            to_uid: me,
            to_gid: my_gid,
        };
        // Every entry is this user's and handed to itself: none is left, the loop of links is not followed (it would
        // never end), and what the link points at is as it was.
        let before = std::fs::metadata("/etc/passwd").unwrap();
        assert_eq!(hand_over_at(&root.join("mine"), handing, true), Ok(0));
        let after = std::fs::metadata("/etc/passwd").unwrap();
        assert_eq!(
            (before.uid(), before.gid(), before.mode()),
            (after.uid(), after.gid(), after.mode())
        );
        // A folder that is not there holds nothing; a link where the folder should be is refused, not followed.
        assert_eq!(hand_over_at(&root.join("absent"), handing, true), Ok(0));
        assert!(hand_over_at(&root.join("mine/loop"), handing, true).is_err());
        // Somebody else's numbers: nothing here is theirs, so nothing is changed and nothing is left unchanged.
        let other = Handing {
            uid: 3_999_999_931,
            gid: 3_999_999_931,
            to_uid: me,
            to_gid: my_gid,
        };
        assert_eq!(hand_over_at(&root.join("mine"), other, false), Ok(0));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
