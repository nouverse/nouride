//! Agents' users and groups: made by this helper only, and only of the shape it makes.

use crate::request::user_of;
use std::ffi::{CStr, CString};
use std::path::Path;
use std::process::Command;

/// Every agent is in it: the shared workspace is its group's. Made by `install.sh`, which adds the service user too.
pub const AGENTS_GROUP: &str = "nr-agents";
/// The shared credentials directory's group: an agent in it reads the files `exec` uses by path. Optional.
pub const CREDS_GROUP: &str = "nr-creds";
/// The groups `op: groups` may hand out, beyond `nr-agents`, which every agent keeps.
const GRANTABLE: &[&str] = &[CREDS_GROUP];

pub struct User {
    pub uid: libc::uid_t,
    pub gid: libc::gid_t,
    pub gecos: String,
}

/// The marker a user this helper made carries, so one somebody else made under the same name is never run as.
pub fn marker(agent: &str) -> String {
    format!("nouride agent {agent}")
}

pub fn lookup_user(name: &str) -> Option<User> {
    let c = CString::new(name).ok()?;
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe { libc::getpwnam_r(c.as_ptr(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() {
        return None;
    }
    let gecos = if pwd.pw_gecos.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(pwd.pw_gecos) }.to_string_lossy().into_owned()
    };
    Some(User {
        uid: pwd.pw_uid,
        gid: pwd.pw_gid,
        gecos,
    })
}

pub fn lookup_group(name: &str) -> Option<libc::gid_t> {
    let c = CString::new(name).ok()?;
    let mut grp: libc::group = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 64 * 1024];
    let mut result: *mut libc::group = std::ptr::null_mut();
    let rc = unsafe { libc::getgrnam_r(c.as_ptr(), &mut grp, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() {
        return None;
    }
    Some(grp.gr_gid)
}

/// Every group `name` is in, its own first — what the drop sets, read from the system's files as root, before.
pub fn groups_of(name: &str, gid: libc::gid_t) -> Vec<libc::gid_t> {
    let c = match CString::new(name) {
        Ok(c) => c,
        Err(_) => return vec![gid],
    };
    let mut count: libc::c_int = 64;
    loop {
        let mut list = vec![0 as libc::gid_t; count as usize];
        let wanted = count;
        let rc = unsafe { libc::getgrouplist(c.as_ptr(), gid, list.as_mut_ptr(), &mut count) };
        if rc >= 0 {
            list.truncate(count as usize);
            return list;
        }
        if count <= wanted {
            count = wanted * 2;
        }
        if count > 65536 {
            return vec![gid];
        }
    }
}

/// A system program, run with nothing of this process's environment. Its failure is a reason.
fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let path = ["/usr/sbin", "/sbin", "/usr/bin", "/bin"]
        .iter()
        .map(|dir| format!("{dir}/{program}"))
        .find(|path| Path::new(path).exists());
    let Some(path) = path else {
        return Err(format!("{program} is not on this system"));
    };
    let output = Command::new(&path)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .output()
        .map_err(|err| format!("{program}: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{program} {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// The agent's user: found, and checked to be one this helper made — or made now. No login shell, no password, its
/// home its private folder, in `nr-agents` alone. `nr-creds` is the daemon's to grant where the agent's pack allows it
/// (`set_groups`): made in it, an agent kept out of the credentials read them until the grant was narrowed.
pub fn ensure_user(agent: &str, home: &Path) -> Result<User, String> {
    let name = user_of(agent);
    if let Some(user) = lookup_user(&name) {
        if user.gecos != marker(agent) {
            return Err(format!(
                "a user named {name} exists that nouride did not make — remove or rename it"
            ));
        }
        return Ok(user);
    }
    if lookup_group(AGENTS_GROUP).is_none() {
        return Err(format!(
            "this system has no {AGENTS_GROUP} group — run install.sh again"
        ));
    }
    let shell = ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"]
        .into_iter()
        .find(|path| Path::new(path).exists())
        .unwrap_or("/bin/false");
    let home = home.to_string_lossy().into_owned();
    let comment = marker(agent);
    let made = run(
        "useradd",
        &[
            "--system",
            "--no-create-home",
            // Not into lastlog and faillog: /var is read-only to the helper's unit, and an agent never logs in.
            "--no-log-init",
            "--home-dir",
            &home,
            "--shell",
            shell,
            "--comment",
            &comment,
            "--user-group",
            "--groups",
            AGENTS_GROUP,
            &name,
        ],
    );
    // Two first commands at once both find no user, and the second `useradd` fails on the one the first made.
    match (made, lookup_user(&name)) {
        (_, Some(user)) if user.gecos == comment => Ok(user),
        (Err(reason), _) => Err(reason),
        (Ok(()), _) => Err(format!("{name} was made and cannot be found")),
    }
}

/// The agent's groups: `nr-agents`, and of what may be granted, exactly `wanted`. Anything else asked for is refused —
/// the service group, root's, any group of the system's.
pub fn set_groups(agent: &str, wanted: &[String]) -> Result<(), String> {
    let name = user_of(agent);
    let user =
        lookup_user(&name).ok_or_else(|| format!("{name} does not exist yet — it is made at its first command"))?;
    if user.gecos != marker(agent) {
        return Err(format!("a user named {name} exists that nouride did not make"));
    }
    let mut groups = vec![AGENTS_GROUP.to_string()];
    for group in wanted {
        if group == AGENTS_GROUP {
            continue;
        }
        if !GRANTABLE.contains(&group.as_str()) {
            return Err(format!(
                "{group} is not a group this helper hands out — only {}",
                GRANTABLE.join(", ")
            ));
        }
        if lookup_group(group).is_none() {
            return Err(format!("this system has no {group} group — run install.sh again"));
        }
        groups.push(group.clone());
    }
    run("usermod", &["-G", &groups.join(","), &name])
}
