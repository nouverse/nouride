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

/// What `remove` did, said back to the daemon in one line.
#[derive(Debug, PartialEq, Eq)]
pub enum Removed {
    /// No user of that name: nothing was there to remove.
    Absent,
    /// The user is gone. `left`: entries of its own in the workspace that could not be handed to the service user.
    Gone { left: u64 },
}

/// Whether the user found under an agent's name is this helper's to remove: its uid where it is, None where there is no
/// such user, and a refusal for one that does not carry this helper's mark, or is root or the service user under any
/// mark. A name is not proof: `nr-<agent>` made by an administrator is somebody's account.
fn removable(agent: &str, found: Option<&User>, service_uid: libc::uid_t) -> Result<Option<libc::uid_t>, String> {
    let name = user_of(agent);
    let Some(user) = found else {
        return Ok(None);
    };
    if user.gecos != marker(agent) {
        return Err(format!(
            "a user named {name} exists that nouride did not make, so it is left as it is"
        ));
    }
    if user.uid == 0 || user.uid == service_uid {
        return Err(format!("{name} is uid {}, which this helper never removes", user.uid));
    }
    Ok(Some(user.uid))
}

/// Another account under the same number: `useradd -o` makes one, and everything done to the number is done to it.
fn shares_uid(name: &str, uid: libc::uid_t) -> Option<String> {
    let mut other = None;
    unsafe {
        libc::setpwent();
        loop {
            let entry = libc::getpwent();
            if entry.is_null() {
                break;
            }
            let theirs = CStr::from_ptr((*entry).pw_name).to_string_lossy().into_owned();
            if (*entry).pw_uid == uid && theirs != name {
                other = Some(theirs);
                break;
            }
        }
        libc::endpwent();
    }
    other
}

/// Where `remove` works, and for whom: fixed by the unit and the connection, never taken from the request.
pub struct Removal<'a> {
    pub workspace: &'a Path,
    /// The folders the daemon keeps per agent (`--reads`): `<root>/<agent>` carries the agent's group.
    pub reads: &'a [std::path::PathBuf],
    pub service_uid: libc::uid_t,
    pub service_gid: libc::gid_t,
    /// The daemon's cgroup, where the helper is not in it: the agent's commands run there and nowhere else.
    pub daemon_cgroup: Option<String>,
}

/// The temporary folders an agent's commands may write in (`serve::landlock_plan`): what it left there is handed over
/// too, its own entries and what is under its own folders.
const TEMPORARY: &[&str] = &["/tmp", "/var/tmp", "/dev/shm"];

/// The agent's user removed, for an agent the daemon has deleted. Only a user this helper made (`removable`), under a
/// number no other account and no process outside the daemon holds. Its processes are ended first (`leave`). Then
/// what is its own, or its own group's, is handed to the service user: in `shared/`, in what is left of its private
/// folder, in the folders the daemon keeps for it, and in the machine's temporary folders, so that a user made later
/// under the same numbers reaches none of it, and an agent made again under the id is given its folder as any folder
/// of the daemon's is (`fsafe::ensure_private`). Then `userdel` takes the user and its own group. Nothing is deleted
/// here: what goes of its files is the daemon's to delete.
pub fn remove_user(agent: &str, at: &Removal) -> Result<Removed, String> {
    use crate::leave::{self, Handing};
    let name = user_of(agent);
    let found = lookup_user(&name);
    let Some(uid) = removable(agent, found.as_ref(), at.service_uid)? else {
        return Ok(Removed::Absent);
    };
    let gid = found.map_or(libc::gid_t::MAX, |user| user.gid);
    if let Some(other) = shares_uid(&name, uid) {
        return Err(format!("{name} shares uid {uid} with {other}, so it is left as it is"));
    }
    if let Some(pid) = leave::stranger(uid, at.daemon_cgroup.as_deref()) {
        return Err(format!(
            "process {pid} runs as uid {uid} outside Nouride, so {name} is left as it is"
        ));
    }
    leave::end_processes(uid)?;
    let handing = Handing {
        uid,
        gid,
        to_uid: at.service_uid,
        to_gid: at.service_gid,
    };
    let mut left = leave::hand_over_at(&at.workspace.join("shared"), handing, true)?;
    left += leave::hand_over_at(&at.workspace.join("private").join(agent), handing, true)?;
    for root in at.reads {
        left += leave::hand_over_at(&root.join(agent), handing, true)?;
    }
    for dir in TEMPORARY {
        // Best effort: a machine without one of them, or with a link there, has nothing of the agent's to hand over.
        left += leave::hand_over_at(Path::new(dir), handing, false).unwrap_or(0);
    }
    // A process just killed may not be reaped yet, and `userdel` then says the user is busy: asked again, shortly.
    let mut gone = run("userdel", &[&name]);
    for _ in 0..5 {
        if gone.is_ok() || lookup_user(&name).is_none() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        gone = run("userdel", &[&name]);
    }
    if lookup_user(&name).is_some() {
        return Err(gone
            .err()
            .unwrap_or_else(|| format!("{name} was removed and is still there")));
    }
    Ok(Removed::Gone { left })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn user(uid: libc::uid_t, gecos: &str) -> User {
        User {
            uid,
            gid: uid,
            gecos: gecos.into(),
        }
    }

    #[test]
    fn only_a_user_this_helper_made_is_removed() {
        const SERVICE: libc::uid_t = 990;
        // Its own: the mark it writes at `useradd`, for this agent.
        assert_eq!(
            removable("nouva", Some(&user(1001, "nouride agent nouva")), SERVICE),
            Ok(Some(1001))
        );
        // Nobody of that name: nothing to remove, and not a refusal.
        assert_eq!(removable("nouva", None, SERVICE), Ok(None));
        // Somebody else's account under the agent's name: no mark, another agent's mark, a mark with more after it.
        for gecos in [
            "",
            "Nouva,,,",
            "nouride agent nix",
            "nouride agent nouva2",
            "x nouride agent nouva",
        ] {
            let refused = removable("nouva", Some(&user(1001, gecos)), SERVICE).unwrap_err();
            assert_eq!(
                refused,
                "a user named nr-nouva exists that nouride did not make, so it is left as it is"
            );
        }
        // Root and the service user, whatever their comment says.
        assert_eq!(
            removable("nouva", Some(&user(0, "nouride agent nouva")), SERVICE).unwrap_err(),
            "nr-nouva is uid 0, which this helper never removes"
        );
        assert_eq!(
            removable("nouva", Some(&user(SERVICE, "nouride agent nouva")), SERVICE).unwrap_err(),
            "nr-nouva is uid 990, which this helper never removes"
        );
    }

    #[test]
    fn an_agent_with_no_user_is_absent_and_nothing_is_touched() {
        // No such user on any machine these tests run on: found absent before a process or a file is looked at.
        let at = Removal {
            workspace: Path::new("/nonexistent/nouride-run-test/workspace"),
            reads: &[],
            service_uid: 990,
            service_gid: 990,
            daemon_cgroup: None,
        };
        assert_eq!(remove_user("zz-no-such-agent-0841", &at), Ok(Removed::Absent));
    }
}
