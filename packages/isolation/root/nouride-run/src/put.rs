//! `put`: stdin into a file, as whoever runs it — the daemon's file tools writing into an agent's folders, run through
//! the helper as the agent, so the file is the agent's own (the RFC's §3: a script made with `write` is one its agent's
//! command can `chmod +x`, and `ssh` reads a config its user owns).
//!
//! Whole or not at all: written beside the file under a name of its own and renamed over it, so a reader never sees
//! half, and a write that failed leaves the file as it was. A file that was there keeps its mode — an executable stays
//! one — but not setuid or setgid; a new one takes the umask's, `0664` from the helper.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub fn put(to: &Path) -> i32 {
    match write(to) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("nouride-run: {}: {err}", to.display());
            1
        }
    }
}

fn umask() -> u32 {
    let mask = unsafe { libc::umask(0o022) };
    unsafe { libc::umask(mask) };
    mask as u32
}

fn write(to: &Path) -> io::Result<()> {
    let (Some(parent), Some(name)) = (to.parent(), to.file_name()) else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a file's path"));
    };
    fs::create_dir_all(parent)?;
    let mode = match fs::symlink_metadata(to) {
        Ok(meta) if meta.is_file() => meta.permissions().mode() & 0o1777,
        _ => 0o666 & !umask(),
    };
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(name);
    temp_name.push(format!(".put-{}", std::process::id()));
    let temp = parent.join(temp_name);
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temp)?;
        io::copy(&mut io::stdin().lock(), &mut file)?;
        file.flush()?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
        fs::rename(&temp, to)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}
