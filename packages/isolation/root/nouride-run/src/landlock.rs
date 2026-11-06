//! Landlock, on top of the agent's user (the RFC's §5): where a command may change files, by path, whatever the files'
//! own modes would let its user do.
//!
//! The ruleset takes away changing files — writing, truncating, making, removing, renaming across folders — and gives
//! it back under the folders the agent writes: `shared/`, its own folder, its declared roots, the temporary folders,
//! and file writes alone under `/dev` and `/proc` (`/dev/null`, a terminal, `choom`). Reading and running stay with the
//! files' modes: the user already decides those, and a ruleset that listed every place a command may read is one that
//! breaks ordinary commands.
//!
//! A layer, not the wall. Off at boot on a Proxmox host's kernel and not built into Raspberry Pi OS's (measured
//! 2026-10): `auto` applies it where the kernel has it, `require` runs nothing where it does not.

use std::ffi::CString;
use std::io;

const SYS_CREATE_RULESET: libc::c_long = 444;
const SYS_ADD_RULE: libc::c_long = 445;
const SYS_RESTRICT_SELF: libc::c_long = 446;
const CREATE_RULESET_VERSION: libc::c_uint = 1;
const RULE_PATH_BENEATH: libc::c_uint = 1;

const WRITE_FILE: u64 = 1 << 1;
const REMOVE_DIR: u64 = 1 << 4;
const REMOVE_FILE: u64 = 1 << 5;
const MAKE_CHAR: u64 = 1 << 6;
const MAKE_DIR: u64 = 1 << 7;
const MAKE_REG: u64 = 1 << 8;
const MAKE_SOCK: u64 = 1 << 9;
const MAKE_FIFO: u64 = 1 << 10;
const MAKE_BLOCK: u64 = 1 << 11;
const MAKE_SYM: u64 = 1 << 12;
/// ABI 2: linking or renaming a file into another folder.
const REFER: u64 = 1 << 13;
/// ABI 3.
const TRUNCATE: u64 = 1 << 14;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Off,
    /// Where the kernel has it.
    Auto,
    /// Nothing runs where the kernel has none.
    Require,
}

impl Mode {
    pub fn parse(text: &[u8]) -> Option<Mode> {
        match text {
            b"off" => Some(Mode::Off),
            b"auto" => Some(Mode::Auto),
            b"require" => Some(Mode::Require),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Auto => "auto",
            Mode::Require => "require",
        }
    }
}

/// What a folder gives back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gives {
    /// Every change: a folder the agent writes.
    Everything,
    /// Writing to files that are there — devices, `/proc` — and nothing made or removed.
    FileWrites,
}

/// The rights this ABI knows that the ruleset takes away.
fn changes(abi: i64) -> u64 {
    let mut rights = WRITE_FILE
        | REMOVE_DIR
        | REMOVE_FILE
        | MAKE_CHAR
        | MAKE_DIR
        | MAKE_REG
        | MAKE_SOCK
        | MAKE_FIFO
        | MAKE_BLOCK
        | MAKE_SYM;
    if abi >= 2 {
        rights |= REFER;
    }
    if abi >= 3 {
        rights |= TRUNCATE;
    }
    rights
}

/// The kernel's Landlock ABI, or why it has none — for `info`, so boot and `doctor` can say.
pub fn abi() -> Result<i64, &'static str> {
    let version = unsafe {
        libc::syscall(
            SYS_CREATE_RULESET,
            std::ptr::null::<u8>(),
            0usize,
            CREATE_RULESET_VERSION,
        )
    };
    if version >= 0 {
        return Ok(version);
    }
    Err(match io::Error::last_os_error().raw_os_error() {
        Some(libc::ENOSYS) => "not built into this kernel",
        Some(libc::EOPNOTSUPP) => "built in but off at boot (add landlock to the kernel's lsm= list)",
        _ => "unavailable",
    })
}

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
}

#[repr(C, packed)]
struct PathBeneath {
    allowed_access: u64,
    parent_fd: i32,
}

/// The ruleset a command gets, prepared in the parent; built in the child, inside the daemon's mount namespace, where
/// its paths mean what the command will see.
#[derive(Debug, Default)]
pub struct Plan {
    pub mode: Mode,
    pub folders: Vec<(CString, Gives)>,
}

impl Plan {
    /// The ruleset, its rules added, or None where there is none to apply. A folder that is not there is skipped.
    ///
    /// # Safety
    /// Called in the child after `fork`: system calls only.
    pub unsafe fn build(&self) -> io::Result<Option<i32>> {
        if self.mode == Mode::Off {
            return Ok(None);
        }
        let abi = libc::syscall(
            SYS_CREATE_RULESET,
            std::ptr::null::<u8>(),
            0usize,
            CREATE_RULESET_VERSION,
        );
        if abi < 0 {
            return if self.mode == Mode::Require {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Landlock is required ([security.exec] landlock) and this kernel has none",
                ))
            } else {
                Ok(None)
            };
        }
        let handled = changes(abi);
        let attr = RulesetAttr {
            handled_access_fs: handled,
        };
        let ruleset = libc::syscall(
            SYS_CREATE_RULESET,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0 as libc::c_uint,
        );
        if ruleset < 0 {
            return Err(io::Error::last_os_error());
        }
        let ruleset = ruleset as i32;
        for (path, gives) in &self.folders {
            let fd = libc::open(path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC | libc::O_DIRECTORY);
            if fd < 0 {
                continue;
            }
            let allowed = match gives {
                Gives::Everything => handled,
                Gives::FileWrites => handled & (WRITE_FILE | TRUNCATE),
            };
            let rule = PathBeneath {
                allowed_access: allowed,
                parent_fd: fd,
            };
            let added = libc::syscall(
                SYS_ADD_RULE,
                ruleset,
                RULE_PATH_BENEATH,
                &rule as *const PathBeneath,
                0 as libc::c_uint,
            );
            libc::close(fd);
            if added < 0 {
                let err = io::Error::last_os_error();
                libc::close(ruleset);
                return Err(err);
            }
        }
        Ok(Some(ruleset))
    }
}

/// Confine this process, and everything it starts, to the ruleset. After `no_new_privs`, which the kernel requires.
///
/// # Safety
/// Called in the child after `fork`: system calls only.
pub unsafe fn restrict(ruleset: i32) -> io::Result<()> {
    let done = libc::syscall(SYS_RESTRICT_SELF, ruleset, 0 as libc::c_uint);
    libc::close(ruleset);
    if done < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_taken_away_grows_with_the_abi_and_never_includes_reading_or_running() {
        assert_eq!(changes(1) & (REFER | TRUNCATE), 0);
        assert_eq!(changes(2) & REFER, REFER);
        assert_eq!(changes(3) & TRUNCATE, TRUNCATE);
        let read_file = 1 << 2;
        let read_dir = 1 << 3;
        let execute = 1 << 0;
        assert_eq!(changes(6) & (read_file | read_dir | execute), 0);
    }

    #[test]
    fn a_mode_is_one_of_three_words() {
        assert_eq!(Mode::parse(b"auto"), Some(Mode::Auto));
        assert_eq!(Mode::parse(b"require"), Some(Mode::Require));
        assert_eq!(Mode::parse(b"off"), Some(Mode::Off));
        assert_eq!(Mode::parse(b"on"), None);
    }
}
