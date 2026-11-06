//! Directory work done as root, inside folders the service user can write.
//!
//! The service user owns the install, so it could put a symlink where this expects a directory and have root follow
//! it — `chown` landing on `/etc`. So nothing here takes a path whole: every component is opened with `O_NOFOLLOW`
//! from `/` down, and every change is made relative to the directory it is in, never by name from the top.

use std::ffi::{CStr, CString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};

pub fn cstr(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a NUL in a path"))
}

pub fn check(ret: libc::c_int) -> io::Result<libc::c_int> {
    if ret < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(ret)
    }
}

/// An absolute path's directory, opened one component at a time with no symlink followed — the path as it is, not as
/// a link would have it.
pub fn open_dir(path: &Path) -> io::Result<OwnedFd> {
    if !path.is_absolute() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not an absolute path"));
    }
    let root = unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    let mut dir = unsafe { OwnedFd::from_raw_fd(check(root)?) };
    for component in path.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(name) => dir = open_at(dir.as_raw_fd(), name.as_bytes())?,
            _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "a path with . or ..")),
        }
    }
    Ok(dir)
}

/// A directory in `dir`, by name, not followed if it is a link.
pub fn open_at(dir: RawFd, name: &[u8]) -> io::Result<OwnedFd> {
    let name = cstr(name)?;
    let fd = unsafe {
        libc::openat(
            dir,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    Ok(unsafe { OwnedFd::from_raw_fd(check(fd)?) })
}

/// What `name` in `dir` is, the link itself where it is one.
pub fn stat_at(dir: RawFd, name: &[u8]) -> io::Result<libc::stat> {
    let name = cstr(name)?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    check(unsafe { libc::fstatat(dir, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) })?;
    Ok(st)
}

pub fn is_dir(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFDIR
}

/// The agent's private folder, made or taken over: `uid`'s, the service group's, `2770` — the agent writes it, the
/// daemon reads it through its own group, no other agent reaches it.
///
/// A folder the service user made before the agent had a user of its own is taken over: what in it is the service
/// user's becomes the agent's. Nothing else changes hands — not root's, not another agent's — so a hard link planted
/// there to a file of the system's is left as it is.
pub fn ensure_private(
    private: &Path,
    agent: &str,
    uid: libc::uid_t,
    service_uid: libc::uid_t,
    service_gid: libc::gid_t,
) -> Result<(), String> {
    let parent = open_dir(private).map_err(|err| format!("{}: {err}", private.display()))?;
    let name = agent.as_bytes();
    match stat_at(parent.as_raw_fd(), name) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            let c = cstr(name).map_err(|e| e.to_string())?;
            check(unsafe { libc::mkdirat(parent.as_raw_fd(), c.as_ptr(), 0o700) })
                .map_err(|err| format!("making {agent}'s folder: {err}"))?;
        }
        Err(err) => return Err(format!("{agent}'s folder: {err}")),
        Ok(st) if !is_dir(&st) => return Err(format!("{agent}'s folder is not a directory")),
        Ok(st) if st.st_uid != uid && st.st_uid != service_uid => {
            return Err(format!(
                "{agent}'s folder belongs to uid {}, neither the agent's nor the service user's",
                st.st_uid
            ))
        }
        Ok(_) => {}
    }
    let folder = open_at(parent.as_raw_fd(), name).map_err(|err| format!("{agent}'s folder: {err}"))?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    check(unsafe { libc::fstat(folder.as_raw_fd(), &mut st) }).map_err(|e| e.to_string())?;
    if st.st_uid != uid {
        let skipped = adopt(folder.as_raw_fd(), service_uid, uid, 0);
        if skipped > 0 {
            eprintln!("nouride-run: handing {agent}'s folder over: {skipped} entries could not be changed and were left as they were");
        }
    }
    check(unsafe { libc::fchown(folder.as_raw_fd(), uid, service_gid) })
        .map_err(|err| format!("{agent}'s folder: {err}"))?;
    check(unsafe { libc::fchmod(folder.as_raw_fd(), 0o2770) }).map_err(|err| format!("{agent}'s folder: {err}"))?;
    ensure_scratchpad(folder.as_raw_fd(), uid, service_gid).map_err(|err| format!("{agent}'s scratchpad: {err}"))
}

/// The scratchpad its `TMPDIR` points at (`SCRATCHPAD_DIRNAME` in `packages/policy`), the agent's like the rest of
/// its folder. Made here rather than by the daemon, whose folder it could not write in. A name there that is not a
/// directory is the agent's own doing, and left alone.
fn ensure_scratchpad(folder: RawFd, uid: libc::uid_t, service_gid: libc::gid_t) -> io::Result<()> {
    const NAME: &[u8] = b".scratchpad";
    match stat_at(folder, NAME) {
        Ok(_) => return Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    let c = cstr(NAME)?;
    check(unsafe { libc::mkdirat(folder, c.as_ptr(), 0o700) })?;
    check(unsafe { libc::fchownat(folder, c.as_ptr(), uid, service_gid, libc::AT_SYMLINK_NOFOLLOW) })?;
    let made = open_at(folder, NAME)?;
    check(unsafe { libc::fchmod(made.as_raw_fd(), 0o2770) })?;
    Ok(())
}

/// Every entry under `dir` owned by `from` becomes `to`'s, links themselves rather than what they point at, and only
/// real directories descended into. Best effort, as `share::regroup` is: what cannot be changed is left and counted.
fn adopt(dir: RawFd, from: libc::uid_t, to: libc::uid_t, depth: u32) -> u64 {
    if depth > 64 {
        return 1;
    }
    let Ok(names) = entries(dir) else {
        return 1;
    };
    let mut skipped = 0;
    for name in names {
        let st = match stat_at(dir, &name) {
            Ok(st) => st,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if st.st_uid != from {
            continue;
        }
        let Ok(c) = cstr(&name) else {
            skipped += 1;
            continue;
        };
        if check(unsafe { libc::fchownat(dir, c.as_ptr(), to, libc::gid_t::MAX, libc::AT_SYMLINK_NOFOLLOW) }).is_err() {
            skipped += 1;
            continue;
        }
        if is_dir(&st) {
            match open_at(dir, &name) {
                Ok(child) => skipped += adopt(child.as_raw_fd(), from, to, depth + 1),
                Err(_) => skipped += 1,
            }
        }
    }
    skipped
}

/// The names in a directory, without `.` and `..`.
pub fn entries(dir: RawFd) -> io::Result<Vec<Vec<u8>>> {
    // `fdopendir` takes the descriptor over and `closedir` closes it, so it gets a copy.
    let copy = check(unsafe { libc::fcntl(dir, libc::F_DUPFD_CLOEXEC, 0) })?;
    let stream = unsafe { libc::fdopendir(copy) };
    if stream.is_null() {
        let err = io::Error::last_os_error();
        unsafe { libc::close(copy) };
        return Err(err);
    }
    let mut names = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes().to_vec();
        if name != b"." && name != b".." {
            names.push(name);
        }
    }
    unsafe { libc::closedir(stream) };
    Ok(names)
}
