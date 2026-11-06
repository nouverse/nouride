# Fixing what the health report found

One section per problem: how to find the cause, then the fix. Commands marked **ask** change something, so say what and
wait for a yes. Everything else only reads. Prefix `sudo` where you are not root and the command needs it.

## Disk full

Find what grew, one level at a time, staying on the one filesystem (`-x`):

```sh
du -xh --max-depth=1 /srv 2>/dev/null | sort -h | tail -15      # then go into the biggest and repeat
find /srv -xdev -type f -size +1G -printf '%s\t%TY-%Tm-%Td\t%p\n' 2>/dev/null | sort -n | tail -20 | numfmt --field=1 --to=iec
```

macOS has no `-printf`: `find /path -xdev -type f -size +1G -exec ls -lh {} + 2>/dev/null | sort -k5 -h | tail -20`.
If `ncdu` is installed, `ncdu -x /srv` is faster to read, but it is interactive and does not work from `exec`.

The usual causes, in order:

| Cause | See it | Free it |
|---|---|---|
| systemd journal | `journalctl --disk-usage` | **ask**: `journalctl --vacuum-size=500M` (keeps the newest 500 MB), and set `SystemMaxUse=500M` in `/etc/systemd/journald.conf` so it stays there |
| one runaway log file | `du -sh /var/log/* \| sort -h \| tail` | **ask**: `truncate -s 0 /var/log/x.log` (never `rm` a log a process has open: the space is not freed); then fix what logs so much |
| Docker images, build cache, stopped containers | `docker system df` | **ask**: `docker image prune` (dangling only), `docker builder prune`; `docker system prune` removes stopped containers and unused networks too. `-a` removes every image not in use by a running container and `--volumes` deletes data; only when the person names them |
| container logs | `du -sh /var/lib/docker/containers/*/*-json.log \| sort -h \| tail` | **ask**: set `"log-opts": {"max-size": "50m", "max-file": "3"}` in `/etc/docker/daemon.json` (applies to containers created after a docker restart) |
| package caches | `du -sh /var/cache/apt /var/cache/dnf 2>/dev/null` | `apt-get clean` (safe: only downloaded `.deb` files) |
| old kernels | `dpkg -l 'linux-image-*' \| grep ^ii` | **ask**: `apt autoremove --purge`, and read its list before saying yes |
| deleted files still open | `lsof +L1 2>/dev/null \| sort -k7 -n \| tail` (or `find /proc/*/fd -lname '*(deleted)' 2>/dev/null`) | the space returns when that process restarts; **ask** to restart it |
| ZFS snapshots | `zfs list -t snapshot -o name,used -s used \| tail -20` | **ask**: `zfs destroy pool/ds@snap` one by one, by name |
| Proxmox backups | `ls -lh /var/lib/vz/dump/` | set a retention in the backup job (*Datacenter → Backup → Retention*); **ask** before deleting dumps |
| downloads, media, a sync folder | `du` shows it | the person's data: list it, they choose |

Inodes full (the report says so) means millions of small files, usually a cache, a mail queue or session files:
`for d in /var/* /srv/*; do echo "$(find "$d" -xdev | wc -l) $d"; done 2>/dev/null | sort -n | tail`.

## Memory and swap

```sh
ps -eo pid,user,rss,etime,comm --sort=-rss | head -15          # RSS is in KB
free -h; cat /proc/pressure/memory 2>/dev/null                   # "some avg60" over 10 means it is waiting on memory
journalctl -k -b -g 'Out of memory|Killed process' --no-pager   # what the kernel killed
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}' 2>/dev/null
```

Linux uses free memory for cache; "available" is the number that matters, not "free". Fixes are the person's call:
restart the leaking service (**ask**), set a memory limit on it (`MemoryMax=` in a systemd drop-in, `mem_limit:` in
compose), or add swap (**ask**):

```sh
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

(ZFS and btrfs need a different swap setup; do not put a swap file on them without reading their documentation.)
In an LXC container the memory limit is the host's setting for the container (*Proxmox → the container → Resources*).

## Slow

```sh
uptime; top -b -n1 -o %CPU | head -20
cat /proc/pressure/cpu /proc/pressure/io 2>/dev/null     # pressure: who waits on what
vmstat 1 5                                               # "wa" column high = waiting on disk
iostat -xz 1 3 2>/dev/null                               # %util near 100 on one disk = that disk is the bottleneck (sysstat package)
```

A load far above the CPU count with low CPU use means processes are waiting on disk or a network mount. Look at `D`
state processes: `ps -eo state,pid,comm | awk '$1=="D"'`. A hung NFS/SMB mount causes exactly this. A disk with SMART
errors becomes slow before it fails.

## A service is down or crash-looping

```sh
systemctl status UNIT --no-pager
journalctl -u UNIT -b -n 50 --no-pager            # the last lines before each exit say why
systemctl cat UNIT                                # what it runs, as which user, in which directory
```

Common causes and what the log says: a missing file or directory (`Failed at step CHDIR`, `No such file`), a port
already taken (`address already in use` → `ss -ltnp | grep :PORT`), a permission (`Permission denied`), a bad config
after an upgrade, a dependency (database, mount) not up yet. Fix the cause, then **ask** and `systemctl restart UNIT`.
A unit that should no longer exist: **ask**, then `systemctl disable --now UNIT`. `systemctl reset-failed UNIT` only
clears the failed mark.

A service is "up" only when it answers: `curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:PORT/`
(`200`/`302`/`401` = answering).

## Containers

```sh
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
docker logs --tail 50 NAME                                   # why it exits
docker inspect NAME --format '{{json .State}}'               # ExitCode, OOMKilled, Error, Health
docker compose -f /path/to/compose.yml ps                    # for a compose stack (find it: docker inspect NAME --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
```

Exit `137` with `"OOMKilled": true` is out of memory; without it, it was killed by `docker stop` or the host. Exit `1`
is the program's own error; the log says which. `unhealthy` means its own health check fails; the check is in
`docker inspect NAME --format '{{json .Config.Healthcheck}}'`. **Ask** before `docker restart NAME` or
`docker compose up -d` (which recreates containers whose config changed). Podman takes the same commands with `podman`.
Updating images (`docker compose pull && docker compose up -d`) is an upgrade: **ask**, and say which images.

## Disks: SMART, ZFS, RAID, btrfs

```sh
smartctl -a /dev/sda          # look at: SMART overall-health, Reallocated_Sector_Ct, Current_Pending_Sector, Offline_Uncorrectable, (NVMe) Percentage Used, Media and Data Integrity Errors
smartctl -t short /dev/sda    # ask: a 2-minute self-test, results in smartctl -a after
zpool status -v               # DEGRADED/FAULTED, and which disk; READ/WRITE/CKSUM error counts
cat /proc/mdstat; mdadm --detail /dev/md0
btrfs device stats /mnt/pool; btrfs scrub status /mnt/pool
```

A disk that SMART calls failing, or with growing reallocated/pending sectors, needs a **backup now** and a
replacement. Tell the person the same day, with the disk's model and serial (`smartctl -i`). Replacing a disk in a
pool or array (`zpool replace`, `mdadm --add`) is done with the person, step by step, never by you alone. `zpool scrub`
reads every disk for hours: **ask**, and do not start one during a resilver.

No `smartctl`: `apt install smartmontools` (**ask**). In an LXC container or a VM there are no real disks to read;
SMART is the host's job.

## Temperatures

`sensors` (package `lm-sensors`) or the report's `grep` over `/sys/class/hwmon`. CPUs throttle themselves near their
limit; sustained heat shortens disks' lives (drives are happiest under about 50 C; check the drive's data sheet).
Causes are physical: dust, a dead fan, a closed cupboard, a hot room. Say what to check; nothing to run.

## Certificates

```sh
certbot certificates                                       # every Let's Encrypt certificate and its expiry
certbot renew --dry-run                                    # tries renewal against the test server: says what would fail
systemctl list-timers 'certbot*' --no-pager                # is the renewal timer there and running?
journalctl -u certbot -n 50 --no-pager; tail -50 /var/log/letsencrypt/letsencrypt.log
```

Certbot renews when 30 days are left, so a certificate under 21 days means renewal has been failing. Usual causes: port
80 not reachable (HTTP challenge), a DNS API token expired (DNS challenge: `/etc/letsencrypt/*.ini`; never print it),
the timer disabled. After fixing: **ask**, `certbot renew`, and reload the web server if certbot's hook does not. Caddy
and Traefik renew on their own; their logs say why not (`journalctl -u caddy`, `docker logs traefik`).

## Backups

Age is only half: a backup that runs but fails, or writes an empty file, is worse than none because everybody
believes in it. After the report:

```sh
ls -lt /mnt/backup | head                   # newest files, sizes - a 0-byte or much smaller newest file is a failure
systemctl list-timers --all --no-pager | grep -iE 'backup|restic|borg|vzdump|rsync'
restic -r REPO snapshots --latest 3         # restic (needs RESTIC_PASSWORD from the secret store)
borg list --last 3 REPO                     # borg
cat /var/log/vzdump/*.log | tail             # Proxmox; or Datacenter → Backup in the UI
```

A mount that dropped (a USB disk, an NFS share) makes a backup write into the empty mount-point directory on the
system disk, which fills the system disk instead. `findmnt /mnt/backup` says whether it is mounted. Restoring a test
file now and then is the only proof a backup works; offer to do one (into `$TMPDIR`, never over the original).

## Updates

```sh
apt list --upgradable 2>/dev/null           # Debian, Ubuntu, Proxmox (refresh with `apt update` - that only updates the lists, safe)
dnf check-update                            # Fedora, RHEL family
cat /var/run/reboot-required.pkgs 2>/dev/null
```

Installing is always **ask**: say how many, which security ones, and whether a reboot will follow. On Proxmox use
`apt dist-upgrade` (Proxmox's own instruction), never plain `apt upgrade`. Upgrade one machine at a time and check
its services after (`python3 HEALTH` again). A reboot of the machine Nouride runs on is the person's to do, because you
will be gone until it is back. Unattended security upgrades (`apt install unattended-upgrades`) are a good suggestion
for a box nobody watches; **ask**.

## Clock and DNS

In `timedatectl status`, `System clock synchronized: no` is fixed by **ask** `timedatectl set-ntp true` (or starting
`chrony`/`systemd-timesyncd`); in an LXC container the host's clock rules. DNS: `cat /etc/resolv.conf`,
`resolvectl status`, `getent hosts deb.debian.org`; a Pi-hole or AdGuard on the network that is down takes every
machine's DNS with it.

## Ports open on every interface

Not a problem by itself; it is the list of what other machines on the network can reach. Worth a sentence when
something listens that the person did not expect (a database on `0.0.0.0`), or when the machine is directly on the
internet. Closing a port means changing the service's bind address or a firewall rule: **ask**, and never touch the
rule that lets ssh in.

## Proxmox hosts

```sh
pveversion; pvesm status                    # storages and how full they are
pct list; qm list                           # containers and VMs, running or not
zpool status -x; zfs list -o space | head
journalctl -u pve-cluster -u pvedaemon -b -p warning --no-pager | tail -30
```

Run the health script on the host for SMART, temperatures and ZFS, and inside each guest for its services. Starting,
stopping or migrating a guest (`pct start`, `qm shutdown`) is **ask**.
