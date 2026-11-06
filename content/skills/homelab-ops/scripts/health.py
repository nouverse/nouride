#!/usr/bin/env python3
"""
health.py - one look at a home server's health: what is wrong first, each with the command that shows more.

    python3 health.py [--quiet] [--json] [--backup PATH[=HOURS]]... [--cert HOST[:PORT]]... [--ignore TEXT]...
    ssh HOST 'python3 - --quiet' < health.py          # the same, on another machine, without copying anything

Checks, each skipped with a reason when its tool or file is not there: disk space and inodes (and read-only
remounts), memory and swap, load, out-of-memory kills, failed systemd units, error lines in the journal, Docker and
Podman containers (restarting, unhealthy, exited with an error, restart counts), ZFS pools, btrfs device errors,
software RAID, SMART, temperatures, TLS certificates (Let's Encrypt and Caddy on disk, and any HOST:PORT given),
backup age (for each --backup), pending updates (apt, dnf, apk) and a pending reboot, clock sync, DNS, and what
listens on every interface.

Default thresholds (change with the options below): disk warn 85% / critical 95%; inodes warn 90%; memory available
warn under 10% / critical under 5%; swap used warn over 80%; 15-minute load warn over 1.5x the CPUs / critical over
3x; certificates warn within 21 days / critical within 7; backups warn when the newest file is older than 36 hours;
temperatures warn at the sensor's own "max" (else 85 C) / critical at its "crit" (else 95 C); ZFS pool warn at 80%.

Output: the problems ranked (CRIT, then WARN, then INFO), each with a `more:` command; then one line of what is fine;
then what could not be checked and why. --quiet prints nothing at all when there is no CRIT or WARN (for a scheduled
check that should speak only when something is wrong). --json prints everything as JSON.
It changes nothing on the machine, runs no package-index update, and never prints a password or token it may meet in
a log line (those are masked). Exit code: always 0 when it ran, so a scheduler does not count problems as its own
failure; 1 only for bad arguments.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import platform
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time

CRIT, WARN, INFO = 3, 2, 1
LEVEL = {CRIT: "CRIT", WARN: "WARN", INFO: "INFO"}

PSEUDO_FS = {
    "tmpfs", "devtmpfs", "overlay", "squashfs", "proc", "sysfs", "cgroup", "cgroup2", "devpts", "mqueue", "debugfs",
    "tracefs", "securityfs", "pstore", "bpf", "autofs", "fusectl", "configfs", "hugetlbfs", "binfmt_misc", "nsfs",
    "ramfs", "efivarfs", "fuse.lxcfs", "rpc_pipefs", "nfsd", "selinuxfs", "fuse.portal", "fuse.gvfsd-fuse", "iso9660",
    "devfs", "autofs", "nullfs", "fuse.snapfuse", "zram",
}
MAC_SKIP = ("/System/Volumes/VM", "/System/Volumes/Preboot", "/System/Volumes/Update", "/System/Volumes/xarts",
            "/System/Volumes/iSCPreboot", "/System/Volumes/Hardware", "/Volumes/Recovery", "/Library/Developer")


class Report:
    def __init__(self):
        self.findings = []   # (level, area, text, more)
        self.ok = []         # short phrases
        self.skipped = []    # (area, why)
        self.ignore = []

    def add(self, level, area, text, more=""):
        if any(i.lower() in text.lower() or i.lower() == area for i in self.ignore):
            return
        self.findings.append((level, area, scrub(text), more))

    def fine(self, text):
        self.ok.append(text)

    def skip(self, area, why):
        self.skipped.append((area, why))


SECRETISH = [
    (re.compile(r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|apikey|authorization|auth)\b(\s*[:=]\s*|\s+)(bearer\s+)?\S+"), r"\1\2***"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/-]+=*"), "Bearer ***"),
    (re.compile(r"\b[A-Za-z0-9+/_-]{40,}={0,2}\b"), "***"),
    (re.compile(r"://([^:/@\s]+):([^@\s]+)@"), r"://\1:***@"),
]


def scrub(text):
    for pat, rep in SECRETISH:
        text = pat.sub(rep, text)
    return text


def have(tool):
    return shutil.which(tool) is not None


def run(cmd, timeout=20, env=None):
    """(exit code, stdout, stderr); exit code None when the program is missing or timed out."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, errors="replace")
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return None, "", "not installed"
    except subprocess.TimeoutExpired:
        return None, "", f"timed out after {timeout}s"
    except OSError as e:
        return None, "", str(e)


def human(n):
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if abs(n) < 1024 or unit == "PB":
            return f"{n:.1f} {unit}" if unit not in ("B", "KB") else f"{n:.0f} {unit}"
        n /= 1024.0


def is_root():
    return hasattr(os, "geteuid") and os.geteuid() == 0


def sudo_hint(cmd):
    return cmd if is_root() else "sudo " + cmd


# ---------------------------------------------------------------- disk

def check_disk(r, a):
    mounts = []
    if os.path.exists("/proc/self/mounts"):
        seen = set()
        with open("/proc/self/mounts") as f:
            for line in f:
                dev, mnt, fstype, opts = line.split()[:4]
                mnt = mnt.replace("\\040", " ")
                if fstype in PSEUDO_FS or mnt.startswith(("/proc", "/sys", "/dev", "/run/user", "/snap/", "/var/lib/docker/")):
                    continue
                if mnt.startswith("/run") and fstype != "zfs":
                    continue
                key = dev if not dev.startswith(("rpool", "tank")) or fstype != "zfs" else mnt
                if key in seen and fstype not in ("zfs", "btrfs"):
                    continue
                seen.add(key)
                mounts.append((mnt, fstype, "ro" in opts.split(",")))
        for mnt, fstype, ro in mounts:
            try:
                st = os.statvfs(mnt)
            except OSError:
                continue
            if st.f_blocks == 0:
                continue
            used = (st.f_blocks - st.f_bfree) * st.f_frsize
            avail = st.f_bavail * st.f_frsize
            size = st.f_blocks * st.f_frsize
            pct = 100.0 * used / max(used + avail, 1)
            if not ro:
                disk_finding(r, a, mnt, pct, avail, size)
            if st.f_files and fstype not in ("zfs", "btrfs"):
                ipct = 100.0 * (st.f_files - st.f_ffree) / st.f_files
                if ipct >= 90:
                    r.add(WARN if ipct < 98 else CRIT, "disk",
                          f"{mnt} has used {ipct:.0f}% of its inodes (files), so new files fail even with space free",
                          f"find {mnt} -xdev -type f | cut -d/ -f2-3 | sort | uniq -c | sort -n | tail -15")
            if ro and fstype in ("ext4", "ext3", "xfs", "btrfs", "f2fs") and mnt in ("/", "/home", "/srv", "/var", "/data"):
                r.add(CRIT, "disk", f"{mnt} ({fstype}) is mounted read-only - often the kernel's answer to disk errors",
                      "dmesg | grep -iE 'error|remount|I/O' | tail -20")
        if mounts:
            r.fine(f"{len(mounts)} filesystems checked")
    elif have("df"):  # macOS and other BSDs
        rc, out, _ = run(["df", "-Pk", "-l"])
        # Mounted installer images are read-only and always "100% full"; nothing can or should be freed there.
        rc2, mout, _ = run(["mount"])
        readonly = {m.group(1) for m in re.finditer(r" on (.+?) \(([^)]*)\)", mout or "") if "read-only" in m.group(2)}
        n = 0
        for line in out.splitlines()[1:]:
            parts = line.split()
            if len(parts) < 6:
                continue
            mnt = " ".join(parts[5:])
            if parts[0] in ("devfs", "map") or mnt.startswith(MAC_SKIP) or mnt.startswith("/dev") or mnt in readonly:
                continue
            size, used, avail = int(parts[1]) * 1024, int(parts[2]) * 1024, int(parts[3]) * 1024
            if size == 0:
                continue
            pct = 100.0 * used / max(used + avail, 1)
            if platform.system() == "Darwin" and mnt == "/":
                # The sealed system volume shares space with the Data volume; Data is the one that fills.
                continue
            n += 1
            disk_finding(r, a, mnt, pct, avail, size)
        r.fine(f"{n} filesystems checked")
    else:
        r.skip("disk", "neither /proc/self/mounts nor df")


def disk_finding(r, a, mnt, pct, avail, size):
    q = "'" + mnt.replace("'", "'\\''") + "'"
    more = f"du -xh --max-depth=1 {q} 2>/dev/null | sort -h | tail -15"
    if platform.system() == "Darwin":
        more = f"du -xh -d 1 {q} 2>/dev/null | sort -h | tail -15"
    if have("docker") and mnt in ("/", "/var", "/var/lib", "/var/lib/docker"):
        more += "; docker system df"
    if have("journalctl") and mnt in ("/", "/var", "/var/log"):
        more += "; journalctl --disk-usage"
    if pct >= a.disk_crit:
        r.add(CRIT, "disk", f"{mnt} is {pct:.0f}% full: {human(avail)} free of {human(size)}", more)
    elif pct >= a.disk_warn:
        r.add(WARN, "disk", f"{mnt} is {pct:.0f}% full: {human(avail)} free of {human(size)}", more)


# ---------------------------------------------------------------- memory, load, uptime

def check_memory(r, a):
    if os.path.exists("/proc/meminfo"):
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0]) * 1024
        total = info.get("MemTotal", 0)
        availb = info.get("MemAvailable", info.get("MemFree", 0) + info.get("Cached", 0))
        if total:
            pct = 100.0 * availb / total
            more = "ps -eo pid,user,rss,comm --sort=-rss | head -15"
            if pct < 5:
                r.add(CRIT, "memory", f"only {human(availb)} of {human(total)} memory available ({pct:.0f}%)", more)
            elif pct < 10:
                r.add(WARN, "memory", f"only {human(availb)} of {human(total)} memory available ({pct:.0f}%)", more)
            else:
                r.fine(f"memory {human(availb)} available of {human(total)}")
        st, sf = info.get("SwapTotal", 0), info.get("SwapFree", 0)
        if st:
            spct = 100.0 * (st - sf) / st
            if spct > 80:
                r.add(WARN, "memory", f"swap {spct:.0f}% used ({human(st - sf)} of {human(st)}) - the machine is short of memory",
                      "for f in /proc/[0-9]*/status; do awk '/^Name|^VmSwap/{printf $2\" \"}END{print \"\"}' $f; done 2>/dev/null | sort -k2 -n | tail")
        else:
            r.fine("no swap")
    elif platform.system() == "Darwin":
        rc, out, _ = run(["memory_pressure", "-Q"], timeout=10)
        m = re.search(r"free percentage:\s*(\d+)%", out or "")
        if m:
            free = int(m.group(1))
            if free < 10:
                r.add(WARN, "memory", f"memory pressure high: {free}% free", "top -l 1 -o mem -n 15")
            else:
                r.fine(f"memory {free}% free (memory_pressure)")
        else:
            r.skip("memory", "memory_pressure gave nothing")
    else:
        r.skip("memory", "no /proc/meminfo")


def cpus():
    try:
        return len(os.sched_getaffinity(0))  # what this container or cgroup may use, not the host's count
    except (AttributeError, OSError):
        return os.cpu_count() or 1


def check_load(r, a):
    try:
        l1, l5, l15 = os.getloadavg()
    except OSError:
        return r.skip("load", "no load average on this system")
    n = cpus()
    more = "top -b -n1 -o %CPU | head -20" if platform.system() == "Linux" else "top -l 1 -o cpu -n 15"
    if l15 > n * 3:
        r.add(CRIT, "load", f"15-minute load {l15:.1f} on {n} CPUs - far more work than the machine can do", more)
    elif l15 > n * 1.5:
        r.add(WARN, "load", f"15-minute load {l15:.1f} on {n} CPUs", more)
    else:
        r.fine(f"load {l1:.1f}/{l5:.1f}/{l15:.1f} on {n} CPUs")
    up = None
    if os.path.exists("/proc/uptime"):
        with open("/proc/uptime") as f:
            up = float(f.read().split()[0])
    elif have("sysctl"):
        rc, out, _ = run(["sysctl", "-n", "kern.boottime"])
        m = re.search(r"sec = (\d+)", out or "")
        if m:
            up = time.time() - int(m.group(1))
    if up is not None:
        if up < 3600:
            r.add(INFO, "uptime", f"started {int(up // 60)} minutes ago - if nobody restarted it, find out why",
                  "last -x | head -5; journalctl -b -1 -n 30 --no-pager")
        else:
            r.fine(f"up {int(up // 86400)}d {int(up % 86400 // 3600)}h")


# ---------------------------------------------------------------- systemd and the journal

def check_systemd(r, a):
    if not have("systemctl"):
        return r.skip("services", "no systemd")
    rc, out, err = run(["systemctl", "--failed", "--no-legend", "--plain", "--no-pager"])
    if rc is None:
        return r.skip("services", f"systemctl: {err.strip()}")
    failed = [l.split()[0] for l in out.splitlines() if l.strip()]
    for unit in failed:
        r.add(WARN, "services", f"{unit} has failed",
              f"systemctl status {unit} --no-pager; journalctl -u {unit} -b -n 50 --no-pager")
    # A unit with Restart=always that dies at once never shows as failed: it loops in auto-restart for ever.
    rc, out, _ = run(["systemctl", "list-units", "--type=service", "--all", "--state=auto-restart", "--no-legend", "--plain", "--no-pager"])
    looping = [l.split()[0] for l in (out or "").splitlines() if l.strip()]
    rc, out, _ = run(["systemctl", "list-units", "--type=service", "--state=running", "--no-legend", "--plain", "--no-pager"])
    running = [l.split()[0] for l in (out or "").splitlines() if l.strip()]
    counts = {}
    if looping + running:
        rc, out, _ = run(["systemctl", "show", "-p", "Id,NRestarts"] + looping + running[:200])
        for block in (out or "").split("\n\n"):  # one block per unit, properties in systemd's own order
            props = dict(l.split("=", 1) for l in block.splitlines() if "=" in l)
            if props.get("Id") and props.get("NRestarts", "").isdigit():
                counts[props["Id"]] = int(props["NRestarts"])
    for unit in looping:
        r.add(WARN, "services", f"{unit} is crash-looping: restarted {counts.get(unit, '?')} times and starting again",
              f"systemctl status {unit} --no-pager; journalctl -u {unit} -b -n 30 --no-pager")
    for unit in running:
        if counts.get(unit, 0) >= 5:
            r.add(WARN, "services", f"{unit} is running but has restarted {counts[unit]} times since it was started",
                  f"journalctl -u {unit} -b --no-pager | grep -iE 'error|fail|exit' | tail -20")
    if not failed and not looping:
        r.fine("no failed units")


def check_journal(r, a):
    if not have("journalctl"):
        return r.skip("journal", "no journalctl")
    since = f"-{int(a.hours)}h"
    rc, out, err = run(["journalctl", "-p", "err", "-q", "--no-pager", "--since", since, "-o", "json",
                        "--output-fields=SYSLOG_IDENTIFIER,_SYSTEMD_UNIT,_COMM,MESSAGE", "-n", "20000"], timeout=60)
    if rc is None or (rc != 0 and not out):
        return r.skip("journal", (err.strip() or "journalctl failed")[:120] + ("" if is_root() else " (try as root)"))
    by = {}
    total = 0
    for line in out.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        total += 1
        who = e.get("_SYSTEMD_UNIT") or e.get("SYSLOG_IDENTIFIER") or e.get("_COMM") or "?"
        msg = e.get("MESSAGE")
        if isinstance(msg, list):  # binary messages come as byte arrays
            msg = "(binary)"
        c, sample = by.get(who, (0, ""))
        by[who] = (c + 1, msg or sample)
    if not total:
        return r.fine(f"no error lines in the journal in the last {int(a.hours)}h")
    top = sorted(by.items(), key=lambda kv: -kv[1][0])[:3]
    detail = "; ".join(f"{who} x{c}: \"{(m or '')[:100]}\"" for who, (c, m) in top)
    capped = " (at least - only the last 20000 read)" if total >= 20000 else ""
    level = WARN if total >= 1000 else INFO
    r.add(level, "journal", f"{total}{capped} error lines in the last {int(a.hours)}h; most from {detail}",
          f"journalctl -p err --since {since} --no-pager -o short-iso | tail -50; "
          + (f"journalctl -u '{top[0][0]}' -n 30 --no-pager" if top[0][0].endswith((".service", ".scope", ".timer", ".socket"))
             else f"journalctl -t '{top[0][0]}' -n 30 --no-pager"))
    # Out-of-memory kills, which leave no failed unit when the process restarts by itself.
    rc, out, _ = run(["journalctl", "-q", "--no-pager", "--since", since, "-g",
                      "Out of memory|oom-kill|oom_reaper|Killed process", "-o", "short-iso"], timeout=60)
    kills = [l for l in (out or "").splitlines() if l.strip()]
    if kills:
        r.add(WARN, "memory", f"{len(kills)} out-of-memory lines in the last {int(a.hours)}h, last: {kills[-1][:160]}",
              f"journalctl --since {since} -g 'Out of memory|Killed process' --no-pager")


# ---------------------------------------------------------------- containers

def check_containers(r, a):
    found = False
    for tool in ("docker", "podman"):
        if not have(tool):
            continue
        found = True
        rc, out, err = run([tool, "ps", "-a", "--format", "{{json .}}"], timeout=30)
        if rc != 0:
            why = (err or "").strip().splitlines()[-1:] or ["failed"]
            r.skip(tool, why[0][:140] + ("" if is_root() else f" - run as root or a user in the {tool} group"))
            continue
        rows = [json.loads(l) for l in out.splitlines() if l.strip().startswith("{")]
        ids = [x.get("ID") or x.get("Id") for x in rows]
        restarts = {}
        if ids:
            rc2, out2, _ = run([tool, "inspect", "--format",
                                "{{.Name}}|{{.RestartCount}}|{{.HostConfig.RestartPolicy.Name}}"] + ids, timeout=30)
            for line in (out2 or "").splitlines():
                parts = line.strip().lstrip("/").split("|")
                if len(parts) == 3:
                    restarts[parts[0]] = (int(parts[1] or 0) if parts[1].isdigit() else 0, parts[2])
        bad = 0
        for x in rows:
            name = x.get("Names") or x.get("Name") or "?"
            if isinstance(name, list):
                name = name[0]
            status = str(x.get("Status", ""))
            state = str(x.get("State", "")).lower()
            more = f"{tool} logs --tail 50 {name}; {tool} inspect {name} --format '{{{{json .State}}}}'"
            count, policy = restarts.get(name, (0, ""))
            if state == "restarting" or status.startswith("Restarting"):
                r.add(CRIT, tool, f"container {name} is restarting over and over ({status})", more); bad += 1
            elif "unhealthy" in status:
                r.add(WARN, tool, f"container {name} is running but unhealthy ({status})", more); bad += 1
            elif state == "exited" and not re.search(r"Exited \(0\)", status):
                lvl = WARN if policy and policy != "no" or count else INFO
                code = re.search(r"Exited \((\d+)\)", status)
                why = {"137": " - 137 means killed: by `stop` after its timeout, or out of memory",
                       "143": " - 143 means it was told to stop (SIGTERM) and did",
                       "139": " - 139 means it crashed (segmentation fault)"}.get(code.group(1) if code else "", "")
                r.add(lvl, tool, f"container {name} stopped with an error: {status}{why}", more); bad += 1
            elif count >= 3:
                r.add(WARN, tool, f"container {name} has restarted {count} times ({status})", more); bad += 1
        running = sum(1 for x in rows if str(x.get("State", "")).lower() == "running")
        if not bad:
            r.fine(f"{tool}: {running} running, {len(rows)} in all, none failing")
    if not found:
        r.skip("containers", "no docker or podman")


# ---------------------------------------------------------------- storage health: ZFS, btrfs, RAID, SMART

def check_storage(r, a):
    if have("zpool"):
        rc, out, err = run(["zpool", "status", "-x"], timeout=30)
        if rc is not None and out.strip() and "all pools are healthy" not in out and "no pools available" not in out:
            first = " ".join(l.strip() for l in out.splitlines()[:6] if l.strip())
            r.add(CRIT, "zfs", f"a ZFS pool is not healthy: {first[:220]}", "zpool status -v")
        elif rc is not None and "all pools are healthy" in out:
            r.fine("ZFS pools healthy")
        rc, out, _ = run(["zpool", "list", "-H", "-o", "name,cap,health"], timeout=30)
        for line in (out or "").splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[1].rstrip("%").isdigit():
                cap = int(parts[1].rstrip("%"))
                if cap >= 90:
                    r.add(CRIT, "zfs", f"ZFS pool {parts[0]} is {cap}% full - ZFS slows sharply and can fail writes", "zfs list -o space -S used | head -20")
                elif cap >= 80:
                    r.add(WARN, "zfs", f"ZFS pool {parts[0]} is {cap}% full", "zfs list -o space -S used | head -20")
        rc, out, _ = run(["zpool", "status"], timeout=30)
        for pool, when in re.findall(r"pool: (\S+)[\s\S]*?scan: scrub repaired .*? on (.+)", out or ""):
            try:
                age = (dt.datetime.now() - dt.datetime.strptime(when.strip(), "%a %b %d %H:%M:%S %Y")).days
                if age > 40:
                    r.add(INFO, "zfs", f"ZFS pool {pool} last scrubbed {age} days ago", f"zpool scrub {pool}   # reads every disk; ask first")
            except ValueError:
                pass
    if os.path.exists("/proc/mdstat"):
        with open("/proc/mdstat") as f:
            md = f.read()
        for name, status in re.findall(r"^(md\d+) : .*?\n.*?\[([U_]+)\]", md, re.M):
            if "_" in status:
                r.add(CRIT, "raid", f"RAID {name} is degraded ([{status}]): a disk has dropped out", f"cat /proc/mdstat; mdadm --detail /dev/{name}")
        if re.search(r"(resync|recovery|reshape)", md):
            r.add(INFO, "raid", "a RAID array is rebuilding", "cat /proc/mdstat")
    if have("btrfs") and os.path.exists("/proc/self/mounts"):
        with open("/proc/self/mounts") as f:
            bmounts = sorted({l.split()[1] for l in f if l.split()[2] == "btrfs"})
        for m in bmounts[:8]:
            rc, out, err = run(["btrfs", "device", "stats", m], timeout=20)
            bad = [l for l in (out or "").splitlines() if l.split() and l.split()[-1].isdigit() and int(l.split()[-1]) > 0]
            if bad:
                r.add(WARN, "btrfs", f"btrfs on {m} has recorded device errors: {'; '.join(bad[:3])}", f"btrfs device stats {m}; btrfs scrub status {m}")
            elif rc not in (0,) and not is_root():
                r.skip("btrfs", "btrfs device stats needs root")
                break
    if not have("smartctl"):
        r.skip("smart", "smartctl not installed (Debian/Ubuntu: apt install smartmontools; macOS: brew install smartmontools)")
        return
    rc, out, err = run(["smartctl", "--scan"], timeout=20)
    devs = [l.split()[0] for l in (out or "").splitlines() if l.startswith("/dev/")]
    if not devs:
        why = "no disks visible" + (" - this is a container or VM; check SMART on the host" if in_container() else "")
        if not is_root():
            why = "smartctl needs root to see disks"
        r.skip("smart", why)
        return
    for dev in devs[:16]:
        rc, out, err = run(["smartctl", "-H", "-A", "-j", dev], timeout=30)
        try:
            j = json.loads(out)
        except ValueError:
            r.skip("smart", f"{dev}: {(err or out).strip()[:100]}")
            continue
        more = f"{sudo_hint('smartctl -a ' + dev)}"
        model = j.get("model_name") or dev
        passed = (j.get("smart_status") or {}).get("passed")
        if passed is False or (rc is not None and rc & 8):
            r.add(CRIT, "smart", f"{dev} ({model}) reports it is FAILING - back up what is on it now", more)
            continue
        nv = j.get("nvme_smart_health_information_log") or {}
        if nv.get("critical_warning"):
            r.add(CRIT, "smart", f"{dev} ({model}) NVMe critical warning {nv['critical_warning']}", more)
        if nv.get("percentage_used", 0) >= 90:
            r.add(WARN, "smart", f"{dev} ({model}) has used {nv['percentage_used']}% of its rated write endurance", more)
        if nv.get("media_errors"):
            r.add(WARN, "smart", f"{dev} ({model}) has {nv['media_errors']} media errors", more)
        for attr in (j.get("ata_smart_attributes") or {}).get("table", []):
            if attr.get("id") in (5, 197, 198) and (attr.get("raw") or {}).get("value", 0) > 0:
                r.add(WARN, "smart", f"{dev} ({model}) {attr.get('name')} = {attr['raw']['value']} - the disk is wearing out", more)
        temp = (j.get("temperature") or {}).get("current")
        if temp and temp >= 60:
            r.add(WARN, "temperature", f"{dev} ({model}) is at {temp} C", more)
    r.fine(f"SMART read on {len(devs)} disk(s)")


def in_container():
    if os.path.exists("/run/systemd/container") or os.path.exists("/.dockerenv"):
        return True
    try:
        with open("/proc/1/environ", "rb") as f:
            return b"container=" in f.read()
    except OSError:
        return False


# ---------------------------------------------------------------- temperatures

def check_temps(r, a):
    readings = []
    for hw in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
        try:
            name = open(os.path.join(hw, "name")).read().strip()
        except OSError:
            name = os.path.basename(hw)
        for inp in sorted(glob.glob(os.path.join(hw, "temp*_input"))):
            base = inp[:-len("_input")]
            try:
                val = int(open(inp).read().strip()) / 1000.0
            except (OSError, ValueError):
                continue
            def rd(suffix):
                try:
                    v = int(open(base + suffix).read().strip()) / 1000.0
                    return v if 0 < v < 150 else None
                except (OSError, ValueError):
                    return None
            try:
                label = open(base + "_label").read().strip()
            except OSError:
                label = os.path.basename(base)
            if val <= 0 or val > 150:
                continue
            readings.append((f"{name} {label}", val, rd("_max"), rd("_crit")))
    if not readings:
        for tz in sorted(glob.glob("/sys/class/thermal/thermal_zone*")):
            try:
                val = int(open(os.path.join(tz, "temp")).read().strip()) / 1000.0
                kind = open(os.path.join(tz, "type")).read().strip()
            except (OSError, ValueError):
                continue
            if 0 < val < 150:
                readings.append((kind, val, None, None))
    if not readings:
        return r.skip("temperature", "no sensors readable here" + (" (a container or VM - the host has them)" if in_container() else ""))
    more = "sensors" if have("sensors") else "grep . /sys/class/hwmon/hwmon*/temp*_input"
    hot = False
    for label, val, mx, cr in readings:
        crit_at = cr or 95.0
        warn_at = mx or min(85.0, crit_at - 5)
        if val >= crit_at:
            r.add(CRIT, "temperature", f"{label} at {val:.0f} C (critical {crit_at:.0f})", more); hot = True
        elif val >= warn_at:
            r.add(WARN, "temperature", f"{label} at {val:.0f} C (high {warn_at:.0f})", more); hot = True
    if not hot:
        top = max(readings, key=lambda x: x[1])
        r.fine(f"temperatures fine (hottest {top[0]} {top[1]:.0f} C)" + (" - host sensors, seen from a container" if in_container() else ""))


# ---------------------------------------------------------------- certificates

def cert_dates_from_file(path):
    try:
        info = ssl._ssl._test_decode_cert(path)  # standard library, undocumented but stable since Python 3.3
        return ssl.cert_time_to_seconds(info["notAfter"]), info
    except Exception:
        pass
    if have("openssl"):
        rc, out, _ = run(["openssl", "x509", "-enddate", "-noout", "-in", path])
        m = re.search(r"notAfter=(.+)", out or "")
        if m:
            try:
                return ssl.cert_time_to_seconds(m.group(1).strip()), {}
            except ValueError:
                pass
    return None, {}


def cert_finding(r, a, what, expires, more):
    days = (expires - time.time()) / 86400
    when = dt.datetime.fromtimestamp(expires).strftime("%Y-%m-%d")
    if days < 0:
        r.add(CRIT, "certificate", f"{what} EXPIRED on {when}", more)
    elif days < a.cert_crit:
        r.add(CRIT, "certificate", f"{what} expires in {days:.0f} days ({when})", more)
    elif days < a.cert_warn:
        r.add(WARN, "certificate", f"{what} expires in {days:.0f} days ({when}) - automatic renewal should have run by now", more)
    return days


def check_certs(r, a):
    files = sorted(glob.glob("/etc/letsencrypt/live/*/cert.pem"))
    caddy = []
    for root in ("/var/lib/caddy/.local/share/caddy", "/root/.local/share/caddy", os.path.expanduser("~/.local/share/caddy"),
                 "/data/caddy"):
        caddy += glob.glob(os.path.join(root, "certificates", "*", "*", "*.crt"))
    checked, soonest = 0, None
    renew = "certbot certificates; certbot renew --dry-run; systemctl list-timers 'certbot*' --no-pager"
    for path in files + sorted(set(caddy)):
        expires, info = cert_dates_from_file(path)
        if expires is None:
            continue
        name = os.path.basename(os.path.dirname(path)) if path.startswith("/etc/letsencrypt") else os.path.basename(path)[:-4]
        if path.startswith("/etc/letsencrypt"):
            renewal = f"/etc/letsencrypt/renewal/{name}.conf"
            if not os.path.exists(renewal):
                continue  # a leftover live dir with no renewal config is not served or renewed
        d = cert_finding(r, a, f"certificate {name}", expires, renew if "letsencrypt" in path else "journalctl -u caddy --since -2d | grep -i -E 'certificate|acme|error' | tail")
        soonest = d if soonest is None or (d >= 0 and (soonest < 0 or d < soonest)) else soonest
        checked += 1
    if os.path.isdir("/etc/letsencrypt/live") and not files and not is_root():
        r.skip("certificate", "/etc/letsencrypt/live is readable by root only")
    for target in a.cert:
        host, _, port = target.partition(":")
        port = int(port or 443)
        expires, err = remote_cert(host, port)
        if expires is None:
            r.add(WARN, "certificate", f"{host}:{port} - {err}", f"openssl s_client -connect {host}:{port} -servername {host} </dev/null 2>/dev/null | openssl x509 -noout -dates -subject")
            continue
        d = cert_finding(r, a, f"{host}:{port}", expires, f"openssl s_client -connect {host}:{port} -servername {host} </dev/null 2>/dev/null | openssl x509 -noout -dates")
        if err:
            r.add(WARN, "certificate", f"{host}:{port} certificate does not verify: {err}", f"curl -vI https://{host}:{port}/ 2>&1 | grep -iE 'expire|issuer|subject|verify'")
        soonest = d if soonest is None or (d >= 0 and (soonest < 0 or d < soonest)) else soonest
        checked += 1
    if checked and soonest is not None and soonest >= 0:
        r.fine(f"{checked} certificate(s), soonest valid one expires in {soonest:.0f} days")
    elif not a.cert and not os.path.isdir("/etc/letsencrypt/live"):
        r.skip("certificate", "no Let's Encrypt or Caddy certificates on disk; give --cert HOST[:PORT] to check a site")


def remote_cert(host, port):
    """(expiry as epoch seconds, a verification problem or '') - read even when the certificate does not verify."""
    err = ""
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=8) as s, ctx.wrap_socket(s, server_hostname=host) as t:
            return ssl.cert_time_to_seconds(t.getpeercert()["notAfter"]), ""
    except ssl.SSLCertVerificationError as e:
        err = e.verify_message or str(e)
    except (OSError, ssl.SSLError) as e:
        return None, f"no TLS answer: {e}"
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((host, port), timeout=8) as s, ctx.wrap_socket(s, server_hostname=host) as t:
            der = t.getpeercert(binary_form=True)
        with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as f:
            f.write(ssl.DER_cert_to_PEM_cert(der))
            name = f.name
        try:
            expires, _ = cert_dates_from_file(name)
        finally:
            os.unlink(name)
        return expires, err
    except (OSError, ssl.SSLError) as e:
        return None, f"{err}; and could not read it: {e}"


# ---------------------------------------------------------------- backups

def check_backups(r, a):
    if not a.backup:
        return r.skip("backup", "no --backup PATH given, so backup age was not checked")
    for spec in a.backup:
        path, _, hours = spec.partition("=")
        limit = float(hours) if hours else a.backup_hours
        if not os.path.exists(path):
            r.add(WARN, "backup", f"backup location {path} does not exist (not mounted?)", f"ls -la {os.path.dirname(path.rstrip('/')) or '/'}; mount | grep -i backup")
            continue
        newest, name, n = 0.0, "", 0
        base_depth = path.rstrip("/").count("/")
        if os.path.isfile(path):
            newest, name, n = os.path.getmtime(path), path, 1
        for root, dirs, fs in os.walk(path):
            if root.count("/") - base_depth >= 4:
                dirs[:] = []
            for f in fs:
                n += 1
                try:
                    m = os.path.getmtime(os.path.join(root, f))
                except OSError:
                    continue
                if m > newest:
                    newest, name = m, os.path.join(root, f)
            if n > 50000:
                break
        if not n:
            r.add(WARN, "backup", f"backup location {path} is empty", f"ls -la {path}")
            continue
        age = (time.time() - newest) / 3600
        when = dt.datetime.fromtimestamp(newest).strftime("%Y-%m-%d %H:%M")
        if age > limit:
            r.add(WARN if age < limit * 3 else CRIT, "backup",
                  f"newest file in {path} is {age:.0f}h old ({when}, {os.path.basename(name)}) - the backup has stopped",
                  f"ls -lt {path} | head; systemctl list-timers --all --no-pager | grep -iE 'backup|restic|borg|vzdump'")
        else:
            r.fine(f"backup {path} newest {age:.0f}h ago")


# ---------------------------------------------------------------- updates, reboot, clock, DNS, ports

def check_updates(r, a):
    if os.path.exists("/var/run/reboot-required"):
        pkgs = ""
        try:
            pkgs = ", ".join(open("/var/run/reboot-required.pkgs").read().split()[:6])
        except OSError:
            pass
        age = (time.time() - os.path.getmtime("/var/run/reboot-required")) / 86400
        r.add(WARN if age > 7 else INFO, "updates", f"a reboot is pending for {age:.0f} days" + (f" ({pkgs})" if pkgs else ""),
              "cat /var/run/reboot-required.pkgs   # rebooting is the person's call")
    if have("apt-get"):
        lists = glob.glob("/var/lib/apt/lists/*_Packages") or glob.glob("/var/lib/apt/lists/*")
        lists_age = (time.time() - max(os.path.getmtime(p) for p in lists)) / 86400 if lists else None
        env = dict(os.environ, LC_ALL="C")
        rc, out, err = run(["apt-get", "-s", "-o", "Debug::NoLocking=1", "dist-upgrade"], timeout=90, env=env)
        if rc is None or rc != 0:
            return r.skip("updates", f"apt-get -s: {(err or 'failed').strip()[:120]}")
        inst = [l for l in out.splitlines() if l.startswith("Inst ")]
        sec = [l for l in inst if re.search(r"securi", l, re.I)]
        stale = f" (package lists are {lists_age:.0f} days old: `apt update` would find more)" if lists_age and lists_age > 7 else ""
        if sec:
            names = ", ".join(l.split()[1] for l in sec[:8])
            r.add(WARN, "updates", f"{len(sec)} security updates pending ({names}{'...' if len(sec) > 8 else ''}), {len(inst)} updates in all{stale}",
                  "apt list --upgradable 2>/dev/null | head -40   # installing is the person's call")
        elif inst:
            r.add(INFO, "updates", f"{len(inst)} updates pending, none marked security{stale}", "apt list --upgradable 2>/dev/null | head -40")
        else:
            r.fine("no updates pending" + stale)
    elif have("dnf"):
        rc, out, err = run(["dnf", "-C", "-q", "check-update"], timeout=90)
        if rc == 100:
            n = len([l for l in out.splitlines() if l.strip() and not l.startswith(("Obsoleting", " "))])
            rc2, out2, _ = run(["dnf", "-C", "-q", "updateinfo", "list", "--security"], timeout=90)
            nsec = len([l for l in (out2 or "").splitlines() if l.strip()])
            r.add(WARN if nsec else INFO, "updates", f"{n} updates pending, {nsec} security (from the cached metadata)", "dnf check-update")
        elif rc == 0:
            r.fine("no updates pending (cached metadata)")
        else:
            r.skip("updates", f"dnf: {(err or 'failed').strip()[:120]}")
    elif have("apk"):
        rc, out, err = run(["apk", "-u", "list"], timeout=60)
        n = len([l for l in (out or "").splitlines() if "upgradable" in l])
        (r.add(INFO, "updates", f"{n} updates pending", "apk -u list") if n else r.fine("no updates pending"))
    else:
        r.skip("updates", "no apt, dnf or apk" + (" (macOS: softwareupdate -l and brew outdated, slow and online)" if platform.system() == "Darwin" else ""))


def check_clock(r, a):
    if not have("timedatectl"):
        return
    rc, out, _ = run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"], timeout=10)
    if rc == 0 and out.strip() == "no":
        r.add(WARN, "clock", "the clock is not synchronised - TLS, logs and one-time codes go wrong when it drifts",
              "timedatectl status; systemctl status systemd-timesyncd chrony --no-pager")
    elif rc == 0:
        r.fine("clock synchronised")


def check_dns(r, a):
    result = {}

    def look():
        try:
            socket.getaddrinfo(a.dns_name, 443)
            result["ok"] = True
        except OSError as e:
            result["err"] = str(e)

    t = threading.Thread(target=look, daemon=True)
    t.start()
    t.join(6)
    if result.get("ok"):
        r.fine("DNS resolves")
    elif t.is_alive():
        r.add(WARN, "network", f"DNS lookup of {a.dns_name} took over 6s", "cat /etc/resolv.conf; resolvectl status 2>/dev/null | head -20")
    else:
        r.add(WARN, "network", f"cannot resolve {a.dns_name}: {result.get('err')}", "cat /etc/resolv.conf; ip route; ping -c2 1.1.1.1")


def check_ports(r, a):
    if have("ss"):
        rc, out, _ = run(["ss", "-H", "-ltnup"], timeout=10)
        seen = {}
        for line in (out or "").splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            proto, local = parts[0], parts[4]
            addr, _, port = local.rpartition(":")
            if addr.split("%")[0] not in ("0.0.0.0", "[::]", "*", "[::ffff:0.0.0.0]"):
                continue
            m = re.search(r'users:\(\("([^"]+)"', line)
            seen.setdefault(f"{port}/{proto}", m.group(1) if m else "?")
        if seen:
            listing = ", ".join(f"{p} {n}" for p, n in sorted(seen.items(), key=lambda kv: int(kv[0].split('/')[0]) if kv[0].split('/')[0].isdigit() else 0))
            r.add(INFO, "ports", f"listening on every interface: {listing}", "ss -ltnup")
    elif have("netstat"):
        rc, out, _ = run(["netstat", "-an", "-p", "tcp"], timeout=10)
        ports = sorted({l.split()[3].rsplit(".", 1)[-1] for l in (out or "").splitlines()
                        if "LISTEN" in l and l.split()[3].startswith(("*.", "0.0.0.0"))}, key=lambda p: int(p) if p.isdigit() else 0)
        if ports:
            r.add(INFO, "ports", f"listening on every interface: {', '.join(ports)}", "lsof -nP -iTCP -sTCP:LISTEN")
    else:
        r.skip("ports", "no ss or netstat")


# ---------------------------------------------------------------- main

CHECKS = [check_disk, check_memory, check_load, check_systemd, check_journal, check_containers, check_storage,
          check_temps, check_certs, check_backups, check_updates, check_clock, check_dns, check_ports]


def main(argv=None):
    p = argparse.ArgumentParser(prog="health.py", description=__doc__.split("\n\n")[0].strip(),
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    p.add_argument("--quiet", action="store_true", help="print nothing unless there is a WARN or CRIT")
    p.add_argument("--json", action="store_true")
    p.add_argument("--backup", action="append", default=[], metavar="PATH[=HOURS]",
                   help="a backup directory or file; warn when its newest file is older than HOURS (default --backup-hours)")
    p.add_argument("--backup-hours", type=float, default=36)
    p.add_argument("--cert", action="append", default=[], metavar="HOST[:PORT]", help="also check this site's certificate")
    p.add_argument("--ignore", action="append", default=[], metavar="TEXT",
                   help="drop findings containing TEXT, or a whole area (disk, services, journal, docker, updates, ports, ...)")
    p.add_argument("--hours", type=float, default=24, help="how far back to read the journal (default 24)")
    p.add_argument("--disk-warn", type=float, default=85)
    p.add_argument("--disk-crit", type=float, default=95)
    p.add_argument("--cert-warn", type=float, default=21)
    p.add_argument("--cert-crit", type=float, default=7)
    p.add_argument("--dns-name", default="deb.debian.org", help="a name to resolve for the DNS check")
    p.add_argument("--only", help="comma list of checks to run: disk,memory,load,systemd,journal,containers,storage,temps,certs,backups,updates,clock,dns,ports")
    a = p.parse_args(argv)

    r = Report()
    r.ignore = a.ignore
    only = set((a.only or "").split(",")) - {""}
    started = time.time()
    for check in CHECKS:
        if only and check.__name__[len("check_"):] not in only:
            continue
        try:
            check(r, a)
        except Exception as e:  # one broken check must not hide the others
            if os.environ.get("HEALTH_DEBUG"):
                raise
            r.skip(check.__name__[len("check_"):], f"the check itself failed: {type(e).__name__}: {e}")

    r.findings.sort(key=lambda f: -f[0])
    host = socket.gethostname()
    osname = platform.system()
    if os.path.exists("/etc/os-release"):
        m = re.search(r'^PRETTY_NAME="?([^"\n]+)', open("/etc/os-release").read(), re.M)
        osname = m.group(1) if m else osname
    elif osname == "Darwin":
        osname = "macOS " + platform.mac_ver()[0]
    serious = [f for f in r.findings if f[0] >= WARN]
    if a.json:
        print(json.dumps({"host": host, "os": osname, "container": in_container(), "checked_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                          "problems": [{"level": LEVEL[l], "area": ar, "text": t, "more": m} for l, ar, t, m in r.findings],
                          "ok": r.ok, "not_checked": [{"area": ar, "why": w} for ar, w in r.skipped]}, indent=1))
        return 0
    if a.quiet and not serious:
        return 0
    counts = {CRIT: 0, WARN: 0, INFO: 0}
    for f in r.findings:
        counts[f[0]] += 1
    where = osname + (", in a container" if in_container() else "")
    print(f"health of {host} ({where}) at {dt.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %z')}: "
          f"{counts[CRIT]} critical, {counts[WARN]} warnings, {counts[INFO]} notes ({time.time() - started:.0f}s)")
    for level, area, text, more in (serious if a.quiet else r.findings):
        print(f"{LEVEL[level]}  {area}: {text}")
        if more:
            print(f"      more: {more}")
    if not a.quiet:
        if r.ok:
            print("fine: " + "; ".join(r.ok))
        if r.skipped:
            print("not checked: " + "; ".join(f"{ar} ({w})" for ar, w in r.skipped))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
