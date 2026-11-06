//! Becoming the agent: everything after the fork, in the child, in an order that matters.
//!
//! Prepared in the parent — every string and list allocated there — so the child, born of a process that may have
//! threads, only makes system calls. And everything the agent's rights should decide is done after the drop: the
//! working directory, the program's lookup on `PATH`, whatever it opens. A check made as root is one a symlink can get
//! around.

use crate::landlock::{self, Plan};
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};

pub struct Becoming {
    pub uid: libc::uid_t,
    pub gid: libc::gid_t,
    pub groups: Vec<libc::gid_t>,
    /// `/sys/fs/cgroup/…/cgroup.procs` of the daemon's commands, where this command belongs — or none.
    pub cgroup_procs: Option<CString>,
    /// The daemon's mount namespace, entered before the drop so the command sees the files the daemon's commands always
    /// saw — its private `/tmp`, what its unit makes read-only — no more and no less. None where it is this one's.
    pub mount_ns: Option<OwnedFd>,
    pub cwd: Option<CString>,
    pub argv: Vec<CString>,
    pub envp: Vec<CString>,
    /// Each directory to look the program up in when it names no `/`: the request's `PATH`, or the usual one.
    pub path: Vec<CString>,
    /// Where it may change files, beyond what its user may (`landlock.rs`).
    pub landlock: Plan,
}

const DEFAULT_PATH: &[u8] = b"/usr/local/bin:/usr/bin:/bin";

impl Becoming {
    pub fn new(
        uid: libc::uid_t,
        gid: libc::gid_t,
        groups: Vec<libc::gid_t>,
        cgroup_procs: Option<String>,
        cwd: Option<Vec<u8>>,
        argv: &[Vec<u8>],
        env: &[Vec<u8>],
    ) -> io::Result<Becoming> {
        let invalid = |_| io::Error::new(io::ErrorKind::InvalidInput, "a NUL byte");
        let argv0 = argv
            .first()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "nothing to run"))?;
        let path_value = env
            .iter()
            .find_map(|pair| pair.strip_prefix(b"PATH="))
            .unwrap_or(DEFAULT_PATH);
        let path = if argv0.contains(&b'/') {
            vec![CString::new(argv0.clone()).map_err(invalid)?]
        } else {
            path_value
                .split(|b| *b == b':')
                .map(|dir| if dir.is_empty() { b".".as_slice() } else { dir })
                .map(|dir| {
                    let mut full = dir.to_vec();
                    full.push(b'/');
                    full.extend_from_slice(argv0);
                    CString::new(full).map_err(invalid)
                })
                .collect::<io::Result<_>>()?
        };
        Ok(Becoming {
            uid,
            gid,
            groups,
            cgroup_procs: cgroup_procs.map(CString::new).transpose().map_err(invalid)?,
            mount_ns: None,
            cwd: cwd.map(CString::new).transpose().map_err(invalid)?,
            argv: argv
                .iter()
                .map(|arg| CString::new(arg.clone()).map_err(invalid))
                .collect::<io::Result<_>>()?,
            envp: env
                .iter()
                .map(|pair| CString::new(pair.clone()).map_err(invalid))
                .collect::<io::Result<_>>()?,
            path,
            landlock: Plan::default(),
        })
    }

    /// Become the agent and `exec` the command. Returns only when that failed, with why.
    ///
    /// # Safety
    /// Called in a child after `fork`, before anything else runs there.
    pub unsafe fn become_and_exec(&self) -> io::Error {
        let fail = || io::Error::last_os_error();
        // Its own session and process group: closing the connection stops it, and whatever it starts, as one. Already
        // leading one is the same: `--local` runs here in the client, which the daemon starts through `setsid(1)`.
        if libc::setsid() < 0 {
            let err = fail();
            if err.raw_os_error() != Some(libc::EPERM) || libc::getsid(0) != libc::getpid() {
                return err;
            }
        }
        // Into the daemon's commands — before the drop, the one step that needs root — so the memory limit holds and
        // stopping the daemon stops this too.
        if let Some(procs) = &self.cgroup_procs {
            let fd = libc::open(procs.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
            if fd < 0 {
                return fail();
            }
            let mut digits = [0u8; 20];
            let text = format_pid(libc::getpid(), &mut digits);
            let written = libc::write(fd, text.as_ptr().cast(), text.len());
            libc::close(fd);
            if written < 0 {
                return fail();
            }
        }
        // The daemon's view of the files, before the drop: entering a namespace needs root. The working directory is
        // the new namespace's root now, and set as the agent below.
        if let Some(ns) = &self.mount_ns {
            if libc::setns(ns.as_raw_fd(), libc::CLONE_NEWNS) < 0 {
                return fail();
            }
        }
        // Built in the daemon's view, where its folders are the ones the command will see; applied after the drop.
        let ruleset = match self.landlock.build() {
            Ok(ruleset) => ruleset,
            Err(err) => return err,
        };
        // Groups, then the group, then the user: each needs root, and the last gives it up.
        if libc::setgroups(self.groups.len(), self.groups.as_ptr()) < 0 {
            return fail();
        }
        if libc::setresgid(self.gid, self.gid, self.gid) < 0 {
            return fail();
        }
        if libc::setresuid(self.uid, self.uid, self.uid) < 0 {
            return fail();
        }
        // Proved, not assumed: a drop that did not happen must not run the command.
        if libc::getuid() != self.uid || libc::geteuid() != self.uid || libc::setuid(0) == 0 {
            return io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the drop to the agent's user did not hold",
            );
        }
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 {
            return fail();
        }
        if let Some(ruleset) = ruleset {
            if let Err(err) = landlock::restrict(ruleset) {
                return err;
            }
        }
        // Group-writable: in `shared/` another agent edits what this one made.
        libc::umask(0o002);
        if let Some(cwd) = &self.cwd {
            if libc::chdir(cwd.as_ptr()) < 0 {
                return fail();
            }
        }
        let mut argv: Vec<*const libc::c_char> = self.argv.iter().map(|arg| arg.as_ptr()).collect();
        argv.push(std::ptr::null());
        let mut envp: Vec<*const libc::c_char> = self.envp.iter().map(|pair| pair.as_ptr()).collect();
        envp.push(std::ptr::null());
        // The lookup `execvp` does, as the agent: the first candidate it may run, and `ENOENT` only if none exists.
        let mut last = io::Error::from_raw_os_error(libc::ENOENT);
        for candidate in &self.path {
            libc::execve(candidate.as_ptr(), argv.as_ptr(), envp.as_ptr());
            let err = fail();
            if err.raw_os_error() != Some(libc::ENOENT) && err.raw_os_error() != Some(libc::ENOTDIR) {
                last = err;
            }
        }
        last
    }
}

/// A pid as decimal text, into a buffer the child already has.
fn format_pid(pid: libc::pid_t, buf: &mut [u8; 20]) -> &[u8] {
    let mut n = pid as u64;
    let mut at = buf.len();
    loop {
        at -= 1;
        buf[at] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    &buf[at..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pid_is_written_as_its_digits() {
        let mut buf = [0u8; 20];
        assert_eq!(format_pid(4321, &mut buf), b"4321");
        assert_eq!(format_pid(7, &mut buf), b"7");
    }

    #[test]
    fn a_bare_name_is_looked_up_on_the_requests_path_and_a_path_is_taken_as_given() {
        let bare = Becoming::new(
            1,
            1,
            vec![],
            None,
            None,
            &[b"ls".to_vec()],
            &[b"PATH=/opt/bin:/usr/bin".to_vec()],
        )
        .unwrap();
        assert_eq!(
            bare.path,
            vec![
                CString::new("/opt/bin/ls").unwrap(),
                CString::new("/usr/bin/ls").unwrap()
            ]
        );
        let given = Becoming::new(1, 1, vec![], None, None, &[b"./run.sh".to_vec()], &[]).unwrap();
        assert_eq!(given.path, vec![CString::new("./run.sh").unwrap()]);
    }
}
