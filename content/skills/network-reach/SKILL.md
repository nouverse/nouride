---
name: network-reach
description: "Reach, check or control a device that is not this machine, at home or away through Tailscale: phone (Android, iPhone), computer, CCTV, NAS, router, TV, an air purifier, an AC, a robot vacuum, lights, smart-home gear. Read it whenever someone asks whether you can access or control a device of theirs ('can you access my phone / laptop / CCTV / air purifier?') or what is on the network: it gives the way in and what they must switch on."
needs_tools: exec
author: Nouride
---

# Reaching other machines and devices

What you can do on another device is decided by whether you can reach it. This skill is how you get
there on your own: find it, work out what kind of thing it is, connect, and leave a way back that
needs nothing next time. When something has to be switched on *on the device* (a setting only a
person can reach), send them a short, exact guide for that device, then carry on from here.

Stop at the first step that answers.

## This machine

The commands here are small, and run on a 512 MB board. The one that can be heavy is FFmpeg for a camera: take one
frame at a time, never record or transcode the stream here on a small machine.

## When someone asks "can you access my …?"

Never answer "no" because nothing is set up yet. That is the usual case, and this skill is how it gets set up. Answer
with the way in for that kind of device, what the person has to do on it, and offer to start; then go to step 1.

| They ask about | The way in | Away from this network |
|---|---|---|
| A computer (Linux, macOS, Windows) | ssh with your key (§3, §4) | Tailscale on it, then ssh by its MagicDNS name (§5) |
| An Android phone | `adb` over Wi-Fi, or ssh into Termux (§3) | the Tailscale app on the phone, then the same over its Tailscale address |
| An iPhone or iPad | nothing to log into; the phone sends to you instead (§ An iPhone or iPad, below) | the same, from anywhere it has the internet or Tailscale |
| CCTV, a camera, an NVR | its RTSP stream or web API, with its login as a secret (§3) | a subnet router at home (§5); cameras do not run Tailscale |
| An air purifier, AC, robot vacuum, lights, plugs, a TV, a speaker | Home Assistant if they have one (its token reaches everything it controls); else the device's own local protocol, for which a library usually exists (Xiaomi: `python-miio` with the device token; Tuya / Smart Life: `tinytuya` with the local key); else the maker's cloud app is the only way, and you say so | Home Assistant through a subnet router or its own Tailscale; a cloud-only device works from anywhere already |
| A NAS, a router, a printer | ssh or its web UI or API (§3) | a subnet router at home (§5) |

Away from this network, **Tailscale is the way**: never open a port on their router or put a device on the internet.
A device that can run Tailscale runs it; one that cannot is reached through one machine at home that runs it as a subnet
router (§5).

## 1. Already reachable?

```sh
grep -iE '^Host ' ~/.ssh/config 2>/dev/null; ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 <name> true && echo reachable
```

A `Host` entry that answers is the whole job. `BatchMode=yes` stops a password prompt hanging the call,
and `StrictHostKeyChecking=accept-new` records the host key on first contact without an interactive prompt.

## 2. Find it

On this network, in one command, on Linux:

```sh
ip -4 addr show | grep inet; ip neigh show | grep -v FAILED
command -v avahi-browse >/dev/null && timeout 8 avahi-browse -atrp 2>/dev/null | grep '^=' | cut -d';' -f4,7,8 | sort -u
```

macOS, which has no `ip`:

```sh
ifconfig | grep 'inet ' | grep -v 127.0.0.1; arp -an | grep -v incomplete
for t in _ssh._tcp _workstation._tcp _http._tcp _smb._tcp; do dns-sd -B $t local. & p=$!; sleep 3; kill $p; done 2>/dev/null | awk '/ Add /{$1=$2=$3=$4=$5=""; print}' | sort -u
```

The neighbour table (`ip neigh`, `arp -an`) lists what this machine has talked to lately; mDNS lists
what announces itself, by name. When neither shows it and `nmap` is there, sweep **this
machine's own subnet only**, and look at the ports to tell what each thing is. `<subnet>` is the
network of the `inet` line above: its address with the host part zeroed, so `inet 10.0.4.17/24` is
`10.0.4.0/24`.

```sh
nmap -sn --host-timeout 3s <subnet>
nmap -Pn --top-ports 30 --open <address>
```

Without `nmap`, one port at a time:

```sh
timeout 2 bash -c "</dev/tcp/<address>/<port>" 2>/dev/null && echo open || echo closed
```

On another network, through Tailscale (peers by MagicDNS name or `100.x` address):

```sh
command -v tailscale >/dev/null && tailscale status --peers 2>/dev/null | head -40
```

Never scan a network this machine is not on, and never invent an address or a tailnet name.

A machine that answered before and is silent now may be asleep. If it has Wake-on-LAN on, wake it
before you give up on it: send a magic packet to its MAC address (from `ip neigh` or `arp -an` while it
was up, written without the colons as `<mac>`) and try step 1 again a minute later. The packet is a
broadcast, so it reaches this network only.

```sh
python3 -c "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1); s.sendto(bytes.fromhex('FF'*6 + '<mac>'*16), ('255.255.255.255', 9))"
```

## 3. What it is, and how in

Identify it from its name, its ports and what its web page says (`curl -sS --max-time 5
http://<address>/ | head -40`), then take the row that fits. **If a row says the person has to do
something, send them its guide in plain words, wait for them to say it is done, then continue.**

| Device | What answers | How you get in | What the person does |
|---|---|---|---|
| Linux, Raspberry Pi | 22 | ssh with your key (step 4) | add your public key, or tell you a user you may log in as |
| macOS | 22 when enabled | ssh | **System Settings → General → Sharing → Remote Login: on** (allow their user), then add your key |
| Windows 10/11 | 22 when enabled, 3389 (RDP), 5985 (WinRM) | ssh, then PowerShell (step 4) | **Settings → System → Optional features → Add a feature → OpenSSH Server → Install**, then in an admin PowerShell `Start-Service sshd; Set-Service sshd -StartupType Automatic`, and add your key to `C:\Users\<them>\.ssh\authorized_keys`. An administrator's key goes in `C:\ProgramData\ssh\administrators_authorized_keys` instead, which sshd reads only once `icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"` has run |
| Android | 5555 or a pairing port once enabled; 8022 with Termux | `adb` over Wi-Fi (`adb pair`, `adb connect`), or ssh into Termux | **Settings → About phone → tap Build number 7 times → Developer options → Wireless debugging: on → Pair device with pairing code**, and send you the code and address. For a shell instead: install **Termux**, run `pkg install openssh && sshd`, and add your key there |
| iPhone, iPad | nothing to log into | through what it shares (Shortcuts, iCloud, an app's own API) | nothing to switch on remotely; say what is and is not possible |
| Camera, CCTV, NVR | 554 (RTSP), 80/443 (web), 8000/37777 (vendor), ONVIF | the stream (`rtsp://user:pass@<address>:554/…`) or its web API | its login stored as a secret (below), and **enable RTSP/ONVIF** in the camera's settings if it is off |
| NAS | 22, 5000/5001 (Synology), 8080 (QNAP), 80/443 | ssh, or its web API | **enable SSH** in its control panel (Synology: *Control Panel → Terminal & SNMP*), then add your key |
| Router, access point | 80/443, sometimes 22 | its web UI or API with the admin login | its admin login stored as a secret; never change its settings without being asked |
| Smart TV, speakers, plugs, lights | 8008/8009 (Cast), 1400 (Sonos), 8123 (Home Assistant), vendor ports | their local API, or Home Assistant | a Home Assistant **long-lived access token** (*Profile → Security*), stored as a secret, reaches everything it already controls |
| Printer | 631 (IPP), 9100 | `lp -d` / `lpstat`, or its web page | nothing, usually |

A password or token for a device is a secret. If the person sends it here, it reaches you as a
`$TMP_SECRET_…` handle: keep it with `secret_save` as `cam_front` (as their `/secret set cam_front <password>`
in the chat would), and every command of yours gets it as `$CAM_FRONT`. Or they add `cam_front` on the
dashboard's Secrets page or with `nouride secret set cam_front --stdin` on this machine, and bind it to the
command that uses it under `[security.exec_secrets]` in your config.toml. Use it from there, never in a file,
your notes or a reply.

## 4. ssh, once

When a device takes ssh and you have no way in, make a key and let the person authorize it:

```sh
k=~/.ssh/nouride_ed25519; [ -f "$k" ] || ssh-keygen -t ed25519 -N '' -C "nouride@$(hostname)" -f "$k" -q; cat "$k.pub"
```

Send them the public key line with where it goes for that device (the table says). The public key is
safe to share; the private key never leaves this machine and is never printed. Then write an entry,
so every later connection is only its name:

```sh
mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/config <<'EOF'
Host nas
    HostName <address>
    User <user>
    IdentityFile ${HOME}/.ssh/nouride_ed25519
    IdentitiesOnly yes
    ConnectTimeout 5
    StrictHostKeyChecking accept-new
EOF
chmod 600 ~/.ssh/config && ssh -o BatchMode=yes nas true && echo connected
```

Write `${HOME}`, not `~`, for a path inside the config: there `~` is the account's home in `/etc/passwd`, which on a
service is not your `HOME`, and the key would not be found.

Use the name from then on, `ssh nas '…'`, never `ssh -i <path>`: a key path in a command asks for
approval every time, the name does not. Add entries rather than editing ones the person wrote.

A Windows host answers ssh with `cmd` unless it was set to PowerShell. Name PowerShell in the command,
with no profile and no prompts, and the same line works either way: single quotes outside for your shell,
double quotes inside for Windows:

```sh
ssh win-host 'powershell -NoProfile -NonInteractive -Command "& { Get-Process | Select-Object -First 5 }"'
```

## 5. Another network

Tailscale is the way to a device somewhere else. If it is not installed, or not logged in, offer to
set it up; installing it and `tailscale up` change this machine's networking, so they are the
person's call, and `tailscale up` prints a login link only they can open. The other device needs the
Tailscale app too (every platform above has one), signed in to the same account. Once both are in,
the device is reached by its MagicDNS name exactly as on the local network.

A device that runs Tailscale SSH (`tailscale up --ssh` on it) needs no key of yours:
`ssh <user>@<magicdns-name>` gets in when the tailnet's access rules let this machine.

A device that cannot run Tailscale (a camera, an air purifier, a printer, a router) is reached through one machine on
its network that does: a computer, a Raspberry Pi, a NAS, or Home Assistant's Tailscale add-on. That machine advertises
the home network, the person approves the route once in the Tailscale admin console (*Machines → the machine → Edit
route settings*), and the device's own address then answers from anywhere:

```sh
sudo tailscale up --advertise-routes=<home subnet>   # on the machine at home, e.g. the subnet of its own inet line
```

Never port-forward on the router instead: that puts the device on the internet for everyone.

## An iPhone or iPad

iOS lets nothing log into it: no shell, no ssh, no `adb`. Say so plainly, then offer the ways that do work (the phone
sends to you, or you reach what it syncs to):

- **A Shortcut that calls a webhook.** You make the webhook (`nouride webhook add --name <name> --agent <you>
  --gateway <gateway> --chat <chat> --message "<what to do with what arrives>"`) and give the person its URL. They make
  a Shortcut with *Get Contents of URL* (method POST, the URL, a JSON body: battery, location, a photo, text) and, if
  they want it on its own, an *Automation* that runs it (every morning, on arriving home, when charging). What it sends
  reaches you as untrusted data, after your message. From outside the home network the URL must be one the phone can
  reach: `[dashboard] public_url`, or the box's Tailscale name with Tailscale on the phone.
- **A Shortcut that runs a command here.** *Run Script over SSH* runs a command on this machine with a user and key
  the person sets in the Shortcut, for when the phone should start something rather than send something.
- **What it syncs to iCloud, through a Mac.** With a Mac on the same Apple ID reachable by ssh, Notes, Reminders,
  Calendar, Photos and Messages are read there (`osascript`, or the app's files), never by logging into iCloud with
  their password.
- **Home and HomeKit.** What the Home app controls is reached through Home Assistant, not through the phone.
- **A cable.** Plugged into this machine and trusted on the phone, `libimobiledevice` (`ideviceinfo`, `idevicebackup2`)
  reads its details and makes a backup, when the person asks for exactly that.

Tailscale on an iPhone lets the phone reach home from anywhere; it does not let you into the phone.

## Working on the far side

- Chain what you run there into one call: `ssh nas 'df -h && uptime'`.
- Give every network command a timeout (`ConnectTimeout`, `curl --max-time`).
- A camera frame to look at: `ffmpeg -rtsp_transport tcp -i "rtsp://admin:$CAM_FRONT@<address>:554/…" -frames:v 1 "$TMPDIR/frame.jpg"`,
  then read the image. `ffmpeg` is often not installed, and the one a Remotion project bundles cannot read RTSP. If
  `command -v ffmpeg` finds nothing, put a static build (about 80 MB) into the bin directory your instructions name,
  from inside it:

  ```sh
  a=$(uname -m); case "$a" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; esac
  curl -fsSL --max-time 300 "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-$a-static.tar.xz" \
    | tar -xJ --strip-components=1 --wildcards '*/ffmpeg' '*/ffprobe' && ./ffmpeg -hide_banner -version | head -1
  ```
- What you change on another device is as real as what you change here, and a delete there asks the
  same as a delete here.
