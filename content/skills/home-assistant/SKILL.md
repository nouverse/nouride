---
name: home-assistant
description: Control and read a smart home through Home Assistant. Turn lights (lampu), fans, air purifiers, AC (climate), robot vacuums, covers (tirai), TVs and media on or off, set brightness, colour, temperature, fan speed or mode, run scenes and scripts, read sensors (suhu, kelembapan, power), history, logbook, cameras. One helper finds devices by name or room in English or Indonesian. Use whenever someone asks to switch, set or check a device at home, or mentions Home Assistant.
requires: python3
needs_tools: exec, read
author: Nouride
---

# Home Assistant

Home Assistant (HA) already talks to the devices in the house. You talk to HA, over its API, with a token the person
makes once. So the job is always: **find the entity, read its state, call a service on it, read the state back.**
A helper script ships beside this file and does each step with one command, so you never hand-write `curl` with a
token in it.

Reaching HA from this machine at all (on the home network, through Tailscale, through a subnet router) is the
`network-reach` skill's job. This skill starts once HA answers. A device HA does not have yet, or a house with no HA:
`references/devices.md` beside this file.

## This machine

Light. The helper is standard-library Python, about 13 MB when it starts (measured on a Linux box); what it waits on
is Home Assistant, not this machine. It runs on a 512 MB board.

## Where the script is

The SKILLS list gave you this file's path, ending in `home-assistant/SKILL.md`. The script is `scripts/ha.py` in
that same directory. Below, `HA` stands for its full path. Write the full path in each command, e.g.
`python3 /srv/nouride/skills/home-assistant/scripts/ha.py ping`.

It needs only `python3` (standard library). It reads two environment variables:

| Variable | What | Default |
|---|---|---|
| `HA_URL` | where HA is: `http://homeassistant.local:8123`, `http://192.168.0.20:8123`, a Tailscale name, or a Nabu Casa address `https://xxxx.ui.nabu.casa` | `http://homeassistant.local:8123` |
| `HA_TOKEN` | a long-lived access token | none (required) |

Set `HA_URL` in the same command (`HA_URL=http://192.168.0.20:8123 python3 HA ping`), or give `--url`. For several
commands in one `exec`, set it once: `export HA_URL=http://192.168.0.20:8123; python3 HA find …; python3 HA call …`. A secret
stored under another name (`ha_rumah` → `$HA_RUMAH`) is picked with `--token-env HA_RUMAH`. The script never prints
the token. Exit codes: `0` done, `1` your arguments were wrong (the message says how), `2` HA refused or has no such
thing (the message says what it has), `3` HA cannot be reached or the token is missing.

## What the person does once

If `HA ping` says there is no token, send them this, in their language, and wait:

1. In Home Assistant, open **your profile** (your name, bottom left) → the **Security** tab → **Long-lived access
   tokens** → **Create token**, name it `Nouride`. The token is shown once, so copy it.
2. Give it to me as a secret: send `/secret set ha_token <the token>` in this chat (it is stored, not kept in the
   chat), or add `ha_token` on the dashboard's **Secrets** page.
3. Tell me the address you open Home Assistant at, if it is not `homeassistant.local:8123`.

If they paste the token into the chat instead, it reaches you as a `$TMP_SECRET_…` handle: keep it with
`secret_save` as `ha_token`. From then on every command of yours has it as `$HA_TOKEN`. **Never** write the token
into a file, your notes, a command line or a reply. Use `$HA_TOKEN`. The address is not a secret: put it in your
notes so you do not ask again.

The token acts as the person who made it. An administrator's token can do everything below; a non-admin user's token
can read and switch devices but gets `401`/`403` on templates, areas and the configuration APIs.

## Which command

| You want to | Run |
|---|---|
| check the address and token work | `python3 HA ping` |
| find a device by what the person called it | `python3 HA find lampu dapur` · `find air purifier` · `find --domain climate` · `find --area "kamar tidur"` |
| see the rooms, or what is in one | `python3 HA areas` · `python3 HA areas "living room"` |
| read a device or sensor | `python3 HA state light.kitchen_lights` (or a name: `state "suhu luar"`; `--all` for every attribute) |
| switch or set something | `python3 HA call light.turn_on light.kitchen_lights brightness_pct=60` |
| know which fields a service takes | `python3 HA services fan` (one domain; with no domain, every domain's service names) |
| how it changed: on for how long, min/max | `python3 HA history sensor.bedroom_temperature --hours 24` |
| what happened, and who did it | `python3 HA logbook light.porch --hours 12` (or no entity: everything) |
| a count or a computed answer | `python3 HA template '{{ states.light | selectattr("state","eq","on") | list | count }}'` |
| hand a whole sentence to HA's own voice assistant | `python3 HA say "matikan lampu dapur" --language id` |
| a camera picture | `python3 HA snapshot camera.front_door`, then `read` the file it names |
| read, write or delete a UI automation, script or scene | `python3 HA config automation automation.night_purifier` (`--put FILE.json` / `--delete`, after a yes) |
| a registry, statistics, anything only the WebSocket API has | `python3 HA ws config/device_registry/list --out "$TMPDIR/devices.json"` |

`--json` before the command (`python3 HA --json state light.x`) prints HA's raw answer instead of the summary.

## The loop, every time

**1. Find the entity.** An entity id is `domain.object_id`: `light.kitchen_lights`, `fan.bedroom_purifier`,
`climate.living_room_ac`, `sensor.outside_temperature`. People say "lampu kamar", "AC ruang tamu", "the purifier".
Run `find` with their words. It matches the friendly name, the id, the room (area) and the kind of device, in English
and Indonesian (`lampu`=light, `kipas`=fan, `AC`=climate, `tirai`/`gorden`=cover, `kamar tidur`=bedroom, `dapur`=
kitchen, `ruang tamu`=living room, `suhu`=temperature, `kelembapan`=humidity, ...), and tolerates typos.

- One clear match → use that id.
- Several → if the request was about all of them ("matikan semua lampu"), use them all; if it was about one, ask which,
  naming the candidates by their friendly names and rooms. Never pick one at random.
- None → try other words, `--domain`, or `areas`. Still none → say what you searched for; the device may not be in HA.

`state`, `call` and `history` also take a name instead of an id. They take it only when every word matched one entity
clearly; otherwise they stop and list the candidates. They never guess, because a guess switches the wrong device.

**2. Read before you act.** `state` shows what the device can do: `supported_color_modes` (a light with only `onoff`
has no brightness), `hvac_modes`, `min_temp`/`max_temp`, `preset_modes`, `fan_speed_list`, `source_list`. Use only
values from those lists. A state of `unavailable` or `unknown` means HA cannot reach the device (offline, unplugged,
battery dead); say so instead of calling a service that will do nothing.

**3. Call the service.** `call DOMAIN.SERVICE ENTITY... key=value...`. Values are read as JSON when they parse:
`brightness_pct=60`, `rgb_color=[255,0,0]`, `oscillating=true`, `hvac_mode=cool`. Quote names with spaces.
Before calling, the script checks the service exists, checks a mode, preset, speed or source against the list the
entity itself gives (and fixes upper/lower case: `preset_mode=auto` becomes `Auto` if that is how the device writes
it), and checks numbers against the entity's range, because HA answers those mistakes with a bare `500`. A field
name it does not know is sent anyway with a `note:` line, and named again if HA then refuses. `services DOMAIN`
lists the fields with examples.

**4. Read it back.** `call` prints the state after the call. Report *that*, not what you asked for: "Lampu dapur
sudah menyala, 60%". A device that answers slowly (IR air conditioners, cloud devices, covers that take 20 seconds)
may still show the old state, so check again with `state` a little later before saying it failed. A cloud-polled
device can take up to a minute to report.

## Common requests

The full set, by domain, with every field that matters, is in `references/services.md` beside this file. Read it
before setting colours, climate modes, fan presets, vacuum rooms, media or covers you have not set before.

```sh
python3 HA call light.turn_on light.bed_light brightness_pct=40 color_temp_kelvin=2700   # warm, dim
python3 HA call light.turn_on light.office rgb_color=[0,120,255]                         # or color_name=blue
python3 HA call light.turn_off light.kitchen_lights light.living_room_lights
python3 HA call climate.set_temperature climate.living_room_ac temperature=24 hvac_mode=cool
python3 HA call climate.set_hvac_mode climate.living_room_ac hvac_mode=off
python3 HA call fan.set_percentage fan.bedroom_fan percentage=50
python3 HA call fan.set_preset_mode fan.air_purifier preset_mode=Auto          # a value from its preset_modes
python3 HA call vacuum.start vacuum.robot      # vacuum.return_to_base to send it home
python3 HA call cover.set_cover_position cover.living_room_curtain position=50   # 0 closed, 100 open
python3 HA call media_player.volume_set media_player.tv volume_level=0.25          # 0 to 1
python3 HA call scene.turn_on scene.movie_night
python3 HA call script.turn_on script.goodnight
python3 HA call notify.mobile_app_budi_phone message="Pintu garasi masih terbuka"   # a push to their phone
```

"All the lights in the kitchen": `find --area dapur --domain light`, then one `call` with every id.
"Turn everything off": confirm what "everything" covers first (`find --domain light`, and say how many).

A whole sentence can go to HA's own Assist: `say "turn off the kitchen lights"`. It works when the person's HA has the
names and aliases set up; it is a fallback, not a replacement for `find` + `call`, because when it misunderstands it
says so only in its own words.

## Ask first

Switching lights, fans, the AC, media, the vacuum and scenes when the person asked is the job. Do it. These change
something they care about more; **say exactly what you will do and wait for a yes**, even when the request sounds
direct, unless they named that exact action and device in this conversation:

| Action | Why |
|---|---|
| unlocking a lock, opening a garage door or gate, disarming an alarm | it opens the house |
| turning off or disabling an automation, editing or deleting one, a script or a scene | it changes how the house behaves when nobody is watching |
| restarting or stopping HA, reloading its configuration, updates, backups | everything stops for a while; a bad config may not come back |
| pressing a `button.*` entity | buttons restart routers, reboot devices, ring sirens; read its name first |
| anything to every device in a domain (`entity_id=all`) | "all" is more than they pictured |
| turning off a fridge, freezer, aquarium, server or network plug | things spoil or stop |

For the first four rows the script refuses (exit 2) until you add `--confirmed`. Add it **only after the person said
yes in this conversation**, never to get past the refusal on your own. Never read a camera, a lock state or presence
("is anyone home?") for someone other than the person who owns this HA without their say-so.

## History, logbook, numbers

- `history ENTITY --hours N`: for a switch or light, the time spent in each state and the changes; for a sensor, min, max,
  average of the recorded values, and a sample. HA keeps detailed history for 10 days by default (`recorder:
  purge_keep_days`); older than that is gone unless the sensor has long-term statistics (below).
- `logbook [ENTITY] --hours N`: events in words, with "(by a user)" when a person or token did it rather than an
  automation.
- Long-term statistics (hourly/daily mean, min, max, energy sums, kept for years) are over the WebSocket API:

  ```sh
  python3 HA ws recorder/statistics_during_period '{"start_time":"2026-10-01T00:00:00Z","statistic_ids":["sensor.power"],"period":"day","types":["mean","min","max","sum"]}'
  ```

  Times in the result are milliseconds since 1970 (UTC). Energy questions ("how much electricity this month") use
  `"types":["change"]` on the energy sensor.
- Templates answer most "how many / which / since when" questions in one call. They are rendered in HA's own time
  zone. A few that help:

  ```sh
  python3 HA template '{{ states.light | selectattr("state","eq","on") | map(attribute="name") | join(", ") }}'
  python3 HA template '{{ area_entities("Dapur") }}'
  python3 HA template '{% for s in states.sensor if s.attributes.device_class == "battery" and s.state | is_number and s.state | float < 20 %}{{ s.name }}: {{ s.state }}%
  {% endfor %}'
  python3 HA template '{{ relative_time(states.binary_sensor.front_door.last_changed) }}'
  ```

  States are strings: compare numbers only after `is_number` and `| float`, as above, because `"9" < "20"` is false as text.

## Automations, scripts, and HA telling you things

Reading, writing and deleting automations and scripts through the config API, the YAML shape HA expects, and how to
make HA wake you through a Nouride webhook when something happens (a door opens, the PM2.5 rises) are in
`references/automations.md`. Every write there is an "ask first" change: show the person the automation in plain words
(when / if / then) and wait for yes.

## When something fails

| Message | What it means | What to do |
|---|---|---|
| `cannot reach Home Assistant at ...` | wrong address, HA down, or this machine is not on its network | `homeassistant.local` does not resolve on many Linux boxes, so ask for the IP; away from home, the `network-reach` skill (Tailscale) |
| `401 Unauthorized` | token wrong, expired or deleted | ask for a new one. Do not retry in a loop: if their HA sets `login_attempts_threshold`, repeated failures ban this machine's IP (they unban it by removing it from `ip_bans.yaml`) |
| `403 Forbidden` | a non-admin user's token | the read/switch commands still work; for the rest they make the token as an administrator |
| `TLS error` | a self-signed certificate on `https://` | add `--insecure` only for an address on their own network |
| `no service X. domain has: ...` | the integration is not loaded, or the name is wrong | pick one from the list |
| `does not offer preset_mode=...` / `is outside what ... takes` | a value the device does not list | use one the message lists |
| `400 Bad Request ... most likely the field X` | a field name typo | the message lists the fields |
| `HTTP 500` | HA or the device's integration failed on that call | `state ENTITY --all` for what it accepts, `logbook ENTITY`; tell the person if it persists |
| state stays the same | slow device, or the integration lost it | `state` again after 10–30 s; then `logbook` for that entity; then tell the person |

## What is not possible this way

- A device HA does not have (`find` does not show it, or there is no HA at all): **`references/devices.md`**. One
  question (brand, model, app, HA or not), finding it on the network, the integration that brings it into HA (Xiaomi
  Home, Tuya, TP-Link, LG ThinQ, Matter …), and the direct route without HA.
- Apple Home / HomeKit-only devices: through HA's HomeKit Controller integration once they are paired to HA, not
  through an iPhone.
- An IR-only air conditioner or TV (no network) needs an IR blaster in HA (Broadlink, SmartIR). Its state is HA's
  guess of the last command, not what the device really did.
- Waiting for something to happen inside one command (a doorbell): HA calls you instead (`references/automations.md`).
- Adding integrations, pairing Zigbee/Z-Wave devices, and logging in to vendor clouds are done by the person in HA's
  UI; you can tell them where to click.
