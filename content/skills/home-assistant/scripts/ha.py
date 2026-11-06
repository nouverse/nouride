#!/usr/bin/env python3
"""
ha.py - read and control a Home Assistant instance through its REST and WebSocket APIs.

    python3 ha.py ping
    python3 ha.py find WORDS... [--domain light] [--area NAME] [--limit 15]
    python3 ha.py state ENTITY_OR_NAME... [--all]
    python3 ha.py call DOMAIN.SERVICE [ENTITY_OR_NAME...] [key=value...] [--confirmed] [--response]
    python3 ha.py services [DOMAIN]
    python3 ha.py areas [AREA_NAME]
    python3 ha.py history ENTITY_OR_NAME [--hours 24]
    python3 ha.py logbook [ENTITY_OR_NAME] [--hours 24]
    python3 ha.py template 'JINJA' [--quiet]
    python3 ha.py say 'turn on the kitchen light' [--language en]
    python3 ha.py snapshot CAMERA [--out FILE]
    python3 ha.py config automation|script|scene ID [--put FILE.json | --delete] [--confirmed]
    python3 ha.py ws TYPE ['{"json": "fields"}'] [--out FILE]

Where Home Assistant is: $HA_URL (default http://homeassistant.local:8123), or --url.
The token: $HA_TOKEN (a long-lived access token), or the variable named by --token-env.
The token is only ever sent to Home Assistant; it is never printed.

Every command prints plain text a person can read; --json prints the raw answer instead.
Exit codes: 0 done; 1 bad arguments; 2 Home Assistant refused or does not have it (the message says
why); 3 Home Assistant cannot be reached or the token is missing. Never a traceback (HA_DEBUG=1 shows one).
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import difflib
import json
import os
import re
import socket
import ssl
import struct
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 15

# Calls that open a door, disarm an alarm or stop the house: the helper refuses them until the person has said yes,
# because a small mistake in an entity name here is a security problem, not an annoyance.
NEEDS_CONFIRMATION = {
    "lock.unlock", "lock.open", "alarm_control_panel.alarm_disarm", "cover.open_cover",
    "homeassistant.restart", "homeassistant.stop", "homeassistant.reload_all", "hassio.host_reboot",
    "hassio.host_shutdown", "automation.turn_off", "automation.reload", "script.reload",
    "recorder.purge", "recorder.purge_entities", "button.press",
}
# Garage doors and gates are covers too; a bedroom blind is not. Only these cover classes need the yes.
SENSITIVE_COVER_CLASSES = {"garage", "gate", "door"}

# Words people use for a kind of device, in English and Indonesian, mapped to what they also match.
SYNONYMS = {
    "lampu": ["light", "lamp"], "lamp": ["light", "lampu"], "light": ["lampu", "lamp"], "lights": ["light", "lampu"],
    "kipas": ["fan"], "fan": ["kipas"], "purifier": ["fan", "pembersih"], "pembersih": ["purifier", "fan"],
    "ac": ["climate", "air", "conditioner", "hvac", "aircon"], "aircon": ["climate", "ac"],
    "pendingin": ["climate", "ac"], "thermostat": ["climate"], "termostat": ["climate"], "heater": ["climate"],
    "vacuum": ["vacuum", "robot"], "robot": ["vacuum"], "vakum": ["vacuum"], "penyedot": ["vacuum"],
    "tirai": ["cover", "curtain", "blind"], "gorden": ["cover", "curtain"], "curtain": ["cover", "gorden"],
    "blind": ["cover"], "garasi": ["garage", "cover"], "garage": ["cover", "garasi"], "pintu": ["door", "lock", "cover"],
    "door": ["lock", "pintu"], "kunci": ["lock"], "gembok": ["lock"],
    "tv": ["media", "player", "television", "televisi"], "televisi": ["tv", "media"], "speaker": ["media", "player"],
    "musik": ["media", "music"], "colokan": ["switch", "plug", "outlet"], "stopkontak": ["switch", "plug"],
    "plug": ["switch", "outlet"], "saklar": ["switch"], "sakelar": ["switch"],
    "suhu": ["temperature", "temp"], "temperatur": ["temperature"], "temperature": ["suhu", "temp"],
    "kelembapan": ["humidity"], "kelembaban": ["humidity"], "humidity": ["kelembapan"],
    "listrik": ["power", "energy"], "daya": ["power"], "energi": ["energy"], "baterai": ["battery"],
    "kamera": ["camera"], "cctv": ["camera"], "sensor": ["sensor"], "pemandangan": ["scene"], "adegan": ["scene"],
    "kamar": ["bedroom", "room"], "tidur": ["bed", "bedroom"], "bedroom": ["kamar", "bed"],
    "tamu": ["living", "guest"], "keluarga": ["living", "family"], "dapur": ["kitchen"], "kitchen": ["dapur"],
    "mandi": ["bath", "bathroom"], "kantor": ["office"], "office": ["kantor"], "kerja": ["office", "study"],
    "teras": ["porch", "terrace", "front"], "depan": ["front", "entrance"], "belakang": ["back", "rear", "backyard"],
    "taman": ["garden", "yard"], "makan": ["dining"], "atas": ["upstairs"], "bawah": ["downstairs"],
    "lantai": ["floor"], "ruang": ["room"], "ruangan": ["room"], "luar": ["outside", "outdoor"], "dalam": ["inside", "indoor"],
    "lembap": ["humidity"], "cahaya": ["illuminance", "light"], "gerak": ["motion"], "jendela": ["window"], "anak": ["kids", "child"], "utama": ["master", "main"],
}
# A word that names a kind of device also matches every entity of that domain.
WORD_DOMAINS = {
    "lampu": "light", "lamp": "light", "light": "light", "lights": "light", "kipas": "fan", "fan": "fan",
    "purifier": "fan", "ac": "climate", "aircon": "climate", "pendingin": "climate", "thermostat": "climate",
    "termostat": "climate", "heater": "climate", "vacuum": "vacuum", "vakum": "vacuum", "robot": "vacuum",
    "tirai": "cover", "gorden": "cover", "curtain": "cover", "blind": "cover", "garasi": "cover",
    "kunci": "lock", "lock": "lock", "tv": "media_player", "televisi": "media_player", "speaker": "media_player",
    "kamera": "camera", "cctv": "camera", "camera": "camera", "scene": "scene", "adegan": "scene",
    "script": "script", "switch": "switch", "saklar": "switch", "sakelar": "switch", "colokan": "switch",
    "plug": "switch", "sensor": "sensor", "automation": "automation", "otomasi": "automation",
}
# Both ways: "kitchen" finds an area named "Dapur" as surely as "dapur" finds "Kitchen Lights".
for _word, _alts in list(SYNONYMS.items()):
    for _alt in _alts:
        SYNONYMS.setdefault(_alt, [])
        if _word not in SYNONYMS[_alt]:
            SYNONYMS[_alt].append(_word)
STOP = {"the", "a", "an", "di", "yang", "the", "of", "in", "my", "saya", "ku", "nya", "please", "tolong", "and", "dan"}


class Fail(Exception):
    def __init__(self, message, code=2):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- connection

def base_url(args):
    url = (args.url or os.environ.get("HA_URL") or "http://homeassistant.local:8123").strip().rstrip("/")
    if not re.match(r"^https?://", url):
        url = "http://" + url
    return re.sub(r"/api$", "", url)


def token(args):
    name = args.token_env or "HA_TOKEN"
    value = os.environ.get(name, "").strip()
    if not value:
        raise Fail(f"no token: ${name} is empty. The person makes a long-lived access token in Home Assistant "
                   f"(their profile -> Security -> Long-lived access tokens -> Create token) and stores it as a "
                   f"secret named {name.lower()} (`/secret set {name.lower()} <token>` in the chat, or the "
                   f"dashboard's Secrets page); it then reaches your commands as ${name}.", 3)
    return value


def ssl_context(args):
    if args.insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None


def request(args, method, path, body=None, raw=False, timeout=TIMEOUT):
    url = base_url(args) + path
    data = None
    headers = {"Authorization": "Bearer " + token(args), "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context(args)) as resp:
            payload = resp.read()
            ctype = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300].strip()
        if e.code == 401:
            raise Fail("401 Unauthorized: the token was refused - it is wrong, expired or was deleted in Home "
                       "Assistant. Ask the person for a new long-lived access token.", 2)
        if e.code == 403:
            raise Fail(f"403 Forbidden: this token's user may not do that (non-admin users cannot use some APIs). {detail}", 2)
        if e.code == 404:
            raise Fail(f"404 Not Found: {path} - no such entity, service or API here. {detail}", 2)
        if e.code == 400:
            raise Fail(f"400 Bad Request: Home Assistant rejected the data: {detail}", 2)
        raise Fail(f"HTTP {e.code} from {path}: {detail}", 2)
    except ssl.SSLError as e:
        raise Fail(f"TLS error talking to {base_url(args)}: {e}. A self-signed certificate needs --insecure "
                   f"(only on a network you trust).", 3)
    except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise Fail(f"cannot reach Home Assistant at {base_url(args)}: {reason}. Check $HA_URL (the address and the "
                   f"port, usually 8123), that it is running, and that this machine is on its network or tailnet "
                   f"(see the network-reach skill).", 3)
    if raw:
        return payload, ctype
    if not payload:
        return None
    try:
        return json.loads(payload)
    except ValueError:
        return payload.decode("utf-8", "replace")


# ---------------------------------------------------------------- websocket (stdlib, just enough for one command)

def ws_command(args, msg_type, fields=None):
    """Open the WebSocket API, authenticate, send one command, return its result."""
    parsed = urllib.parse.urlparse(base_url(args))
    secure = parsed.scheme == "https"
    host = parsed.hostname
    port = parsed.port or (443 if secure else 80)
    try:
        sock = socket.create_connection((host, port), timeout=TIMEOUT)
        if secure:
            ctx = ssl_context(args) or ssl.create_default_context()
            sock = ctx.wrap_socket(sock, server_hostname=host)
    except (OSError, ssl.SSLError) as e:
        raise Fail(f"cannot reach Home Assistant at {base_url(args)}: {e}", 3)
    key = base64.b64encode(os.urandom(16)).decode()
    path = (parsed.path.rstrip("/") or "") + "/api/websocket"
    sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {parsed.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(4096)
        if not chunk:
            raise Fail("the WebSocket handshake was cut off", 3)
        head += chunk
    status, _, rest = head.partition(b"\r\n\r\n")
    first = status.split(b"\r\n")[0].decode(errors="replace")
    if " 101 " not in first:
        raise Fail(f"WebSocket refused: {first}", 2)
    buf = bytearray(rest)

    def recv_exact(n):
        while len(buf) < n:
            chunk = sock.recv(65536)
            if not chunk:
                raise Fail("the WebSocket connection closed early", 3)
            buf.extend(chunk)
        out = bytes(buf[:n])
        del buf[:n]
        return out

    def recv_msg():
        parts = []
        while True:
            b1, b2 = recv_exact(2)
            fin, opcode, length = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", recv_exact(8))[0]
            mask = recv_exact(4) if b2 & 0x80 else None
            data = recv_exact(length)
            if mask:
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
            if opcode == 8:
                raise Fail("Home Assistant closed the WebSocket", 2)
            if opcode == 9:  # ping -> pong
                send(data, 0xA)
                continue
            if opcode in (1, 2, 0):
                parts.append(data)
                if fin:
                    return json.loads(b"".join(parts))

    def send(data, opcode=1):
        if isinstance(data, dict):
            data = json.dumps(data).encode()
        mask = os.urandom(4)
        n = len(data)
        header = bytes([0x80 | opcode])
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        sock.sendall(header + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(data)))

    try:
        sock.settimeout(TIMEOUT)
        hello = recv_msg()
        if hello.get("type") != "auth_required":
            raise Fail(f"unexpected WebSocket greeting: {hello}", 2)
        send({"type": "auth", "access_token": token(args)})
        auth = recv_msg()
        if auth.get("type") != "auth_ok":
            raise Fail("the token was refused on the WebSocket API: it is wrong or expired", 2)
        send(dict(fields or {}, id=1, type=msg_type))
        while True:
            msg = recv_msg()
            if msg.get("id") == 1 and msg.get("type") == "result":
                if not msg.get("success"):
                    err = msg.get("error") or {}
                    raise Fail(f"{msg_type} failed: {err.get('code')}: {err.get('message')}", 2)
                return msg.get("result")
    except socket.timeout:
        raise Fail(f"no answer to {msg_type} within {TIMEOUT}s", 3)
    finally:
        try:
            sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------- helpers

def norm(text):
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def words(text):
    return [w for w in norm(text).split() if w and w not in STOP]


def ha_tz(args, cache={}):
    if "tz" not in cache:
        tzname = None
        try:
            tzname = (request(args, "GET", "/api/config") or {}).get("time_zone")
        except Fail:
            pass
        cache["tz"] = None
        if tzname:
            try:
                from zoneinfo import ZoneInfo
                cache["tz"] = ZoneInfo(tzname)
            except Exception:
                cache["tz"] = None
    return cache["tz"]


def parse_time(value):
    if not value:
        return None
    value = value.replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(value)
    except ValueError:
        return None


def local(args, value):
    when = parse_time(value) if isinstance(value, str) else value
    if not when:
        return str(value)
    tz = ha_tz(args)
    if tz:
        when = when.astimezone(tz)
    return when.strftime("%Y-%m-%d %H:%M:%S")


def ago(value):
    when = parse_time(value)
    if not when:
        return ""
    secs = int((dt.datetime.now(dt.timezone.utc) - when).total_seconds())
    if secs < 90:
        return f"{secs}s ago"
    if secs < 5400:
        return f"{secs // 60}m ago"
    if secs < 172800:
        return f"{secs // 3600}h {secs % 3600 // 60}m ago"
    return f"{secs // 86400}d ago"


def span(seconds):
    seconds = int(seconds)
    h, m = seconds // 3600, seconds % 3600 // 60
    return f"{h}h {m:02d}m" if h else f"{m}m {seconds % 60:02d}s"


def match_area(query, rows):
    """The area a phrase names ("living room", "ruang tamu", "dapur"), or None."""
    q = words(query)
    best, pick = 0.0, None
    for _, name, _ in rows:
        aw = set(words(name))
        if norm(query) == norm(name):
            return name
        got = 0.0
        for w in q:
            alts = [w] + SYNONYMS.get(w, [])
            if any(a in aw for a in alts):
                got += 1
            elif any(difflib.SequenceMatcher(None, w, x).ratio() >= 0.8 for x in aw):
                got += 0.8
        sc = got / max(len(q), 1)
        if sc > best:
            best, pick = sc, name
    return pick if best >= 0.5 else None


def area_map(args):
    """entity_id -> area name, and area rows, through a template (works on any HA with templates; no WebSocket)."""
    tpl = ("{% for a in areas() %}{% set ns = namespace(e=area_entities(a)) %}"
           "{% for d in area_devices(a) %}{% set ns.e = ns.e + device_entities(d) %}{% endfor %}"
           "{{ a }}\t{{ area_name(a) }}\t{{ ns.e | unique | join(',') }}\n{% endfor %}")
    try:
        text = request(args, "POST", "/api/template", {"template": tpl})
    except Fail:
        return {}, []
    entity_area, rows = {}, []
    for line in str(text).splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        aid, name, ents = parts[0], parts[1], [e for e in parts[2].split(",") if e]
        rows.append((aid, name, ents))
        for e in ents:
            entity_area.setdefault(e, name)
    return entity_area, rows


def all_states(args):
    states = request(args, "GET", "/api/states") or []
    return {s["entity_id"]: s for s in states}


def score(query, state, area):
    eid = state["entity_id"]
    domain = eid.split(".", 1)[0]
    name = state.get("attributes", {}).get("friendly_name") or ""
    dclass = state.get("attributes", {}).get("device_class") or ""
    hay = set(words(name)) | set(words(eid.split(".", 1)[1])) | set(words(area or "")) | {domain} | set(words(dclass))
    hay |= set(words(domain.replace("_", " ")))
    total = 0.0
    for q in query:
        alts = [q] + SYNONYMS.get(q, [])
        best = 0.0
        if WORD_DOMAINS.get(q) == domain:
            best = 1.0
        for a in alts:
            for h in hay:
                if a == h:
                    best = max(best, 1.0 if a == q else 0.9)
                elif len(a) >= 3 and h.startswith(a):
                    best = max(best, 0.8)
                elif len(h) >= 3 and a.startswith(h):
                    best = max(best, 0.7)
                elif len(a) >= 4:
                    r = difflib.SequenceMatcher(None, a, h).ratio()
                    if r >= 0.8:
                        best = max(best, r * 0.75)
        total += best
    return total / max(len(query), 1)


def resolve(args, ref, states=None, areas=None, domain=None):
    """An entity id, or a name the person used: return the one entity it means, or fail listing the candidates."""
    states = states if states is not None else all_states(args)
    if ref in states:
        return ref
    if "." in ref and re.match(r"^[a-z_]+\.[a-z0-9_]+$", ref):
        near = difflib.get_close_matches(ref, list(states), n=5, cutoff=0.6)
        raise Fail(f"no entity {ref}." + (f" Close: {', '.join(near)}" if near else " Use `find` with words from its name."))
    if areas is None:
        areas, _ = area_map(args)
    q = words(ref)
    ranked = sorted(((score(q, s, areas.get(e)), e) for e, s in states.items()
                     if not domain or e.startswith(domain + ".")), reverse=True)
    ranked = [r for r in ranked if r[0] >= 0.6]
    hint = ""
    if domain and (not ranked or ranked[0][0] < 0.85):
        others = [e for e, s in states.items() if not e.startswith(domain + ".") and score(q, s, areas.get(e)) >= 0.85]
        if others:
            hint = (f" '{ref}' is {', '.join(others[:5])} - not a {domain}. Use that domain's service "
                    f"(e.g. {others[0].split('.')[0]}.turn_on), or `services {others[0].split('.')[0]}`.")
    if not ranked:
        raise Fail(f"no {domain or 'entity'} matches '{ref}'.{hint or ' Run `find` with other words, or `areas` to see the rooms.'}")
    # Only a name whose every word matched is taken on trust; a half match is a guess, and a guess here
    # switches the wrong device.
    if ranked[0][0] >= 0.85 and (len(ranked) == 1 or ranked[0][0] - ranked[1][0] >= 0.25):
        return ranked[0][1]
    top = [e for s, e in ranked[:8] if s >= ranked[0][0] - 0.25]
    lines = [f"  {e}  ({states[e].get('attributes', {}).get('friendly_name', '')}, {areas.get(e, 'no area')})" for e in top]
    if ranked[0][0] < 0.85:
        raise Fail(f"no {domain or 'entity'} matches all of '{ref}'.{hint} Nearest - use the entity id if one is "
                   f"right, or ask:\n" + "\n".join(lines))
    raise Fail(f"'{ref}' could mean more than one entity - use the entity id:\n" + "\n".join(lines))


# A field whose value must be one the entity lists, and the attribute that lists it.
VALUE_LISTS = {"preset_mode": "preset_modes", "hvac_mode": "hvac_modes", "fan_mode": "fan_modes",
               "swing_mode": "swing_modes", "fan_speed": "fan_speed_list", "source": "source_list",
               "sound_mode": "sound_mode_list", "effect": "effect_list", "option": "options", "mode": "available_modes",
               "operation_mode": "operation_list", "color_mode": "supported_color_modes"}
# A numeric field and its bounds: fixed, or read from the entity's own attributes.
RANGES = {"brightness_pct": (0, 100), "brightness": (0, 255), "percentage": (0, 100), "position": (0, 100),
          "tilt_position": (0, 100), "volume_level": (0, 1), "temperature": ("min_temp", "max_temp"),
          "target_temp_low": ("min_temp", "max_temp"), "target_temp_high": ("min_temp", "max_temp"),
          "humidity": ("min_humidity", "max_humidity"), "color_temp_kelvin": ("min_color_temp_kelvin", "max_color_temp_kelvin"),
          "value": ("min", "max")}


def check_values(data, ids, states):
    """HA answers an unsupported preset or an out-of-range number with a bare 500; say what is allowed instead.
    A value that differs from an allowed one only in case is corrected, since HA compares exactly."""
    notes = []
    for e in ids:
        attrs = (states.get(e) or {}).get("attributes", {})
        for field, listed in VALUE_LISTS.items():
            allowed = attrs.get(listed)
            if field not in data or not isinstance(allowed, list) or not allowed:
                continue
            if data[field] in allowed:
                continue
            same = [a for a in allowed if isinstance(a, str) and str(data[field]).lower() == a.lower()]
            if same:
                notes.append(f"{field}={data[field]} written as {same[0]}, the way {e} lists it")
                data[field] = same[0]
                continue
            raise Fail(f"{e} does not offer {field}={data[field]}. It offers: {', '.join(map(str, allowed))}", 1)
        for field, (lo, hi) in RANGES.items():
            if field not in data or not isinstance(data[field], (int, float)) or isinstance(data[field], bool):
                continue
            lo = attrs.get(lo) if isinstance(lo, str) else lo
            hi = attrs.get(hi) if isinstance(hi, str) else hi
            if isinstance(lo, (int, float)) and data[field] < lo or isinstance(hi, (int, float)) and data[field] > hi:
                raise Fail(f"{field}={data[field]} is outside what {e} takes ({lo} to {hi})", 1)
    return notes


def coerce(value):
    if value.lower() in ("true", "false"):
        return value.lower() == "true"
    try:
        return json.loads(value)
    except ValueError:
        return value


# Attributes worth showing for a device without --all (the rest is noise for a person).
USEFUL = ["friendly_name", "unit_of_measurement", "device_class", "brightness", "color_mode", "supported_color_modes",
          "rgb_color", "color_temp_kelvin", "min_color_temp_kelvin", "max_color_temp_kelvin", "effect", "effect_list",
          "hvac_modes", "hvac_action", "current_temperature", "temperature", "target_temp_low", "target_temp_high",
          "min_temp", "max_temp", "target_temp_step", "fan_mode", "fan_modes", "preset_mode", "preset_modes",
          "swing_mode", "humidity", "current_humidity", "percentage", "percentage_step", "oscillating", "direction",
          "battery_level", "fan_speed", "fan_speed_list", "status", "current_position", "current_tilt_position",
          "volume_level", "is_volume_muted", "media_title", "media_artist", "source", "source_list", "sound_mode",
          "entity_id", "last_triggered", "next_dawn", "elevation", "options", "min", "max", "step", "mode"]


def show_state(args, s, area=None, full=False):
    a = s.get("attributes", {})
    head = f"{s['entity_id']}: {s['state']}"
    if a.get("unit_of_measurement"):
        head += f" {a['unit_of_measurement']}"
    print(head)
    print(f"  name: {a.get('friendly_name', '')}" + (f"   area: {area}" if area else ""))
    print(f"  last changed: {local(args, s.get('last_changed'))} ({ago(s.get('last_changed'))})")
    if s["state"] in ("unavailable", "unknown"):
        print("  NOTE: Home Assistant cannot talk to this device right now (offline, unplugged, or its integration "
              "failed). Commands will not reach it.")
    keys = sorted(a) if full else [k for k in USEFUL if a.get(k) is not None and k not in ("friendly_name", "unit_of_measurement")]
    for k in keys:
        v = a[k]
        if k == "brightness" and isinstance(v, (int, float)):
            v = f"{v} of 255 (= {round(v / 2.55)}%)"
        print(f"  {k}: {json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v}")
    hidden = len(a) - len(keys) - (1 if "friendly_name" in a else 0)
    if not full and hidden > 0:
        print(f"  (+{hidden} more attributes: add --all)")


# ---------------------------------------------------------------- commands

def cmd_ping(args):
    api = request(args, "GET", "/api/")
    cfg = request(args, "GET", "/api/config") or {}
    if args.json:
        return print(json.dumps({"api": api, "config": cfg}, indent=1))
    print(f"OK: {base_url(args)} answered: {api.get('message') if isinstance(api, dict) else api}")
    print(f"  name: {cfg.get('location_name')}   version: {cfg.get('version')}   state: {cfg.get('state')}")
    print(f"  time zone: {cfg.get('time_zone')}   units: {(cfg.get('unit_system') or {}).get('temperature')}"
          f"   language: {cfg.get('language')}")
    print(f"  integrations loaded: {len(cfg.get('components') or [])}")


def cmd_find(args):
    states = all_states(args)
    areas, area_rows = area_map(args)
    q = words(" ".join(args.words)) if args.words else []
    want_area = norm(args.area) if args.area else None
    if want_area:
        match = match_area(args.area, area_rows)
        if not match:
            raise Fail(f"no area like '{args.area}'. Areas: {', '.join(n for _, n, _ in area_rows) or 'none defined'}")
        want_area = match
    found = []
    for eid, s in states.items():
        if args.domain and not eid.startswith(args.domain + "."):
            continue
        if want_area and areas.get(eid) != want_area:
            continue
        sc = score(q, s, areas.get(eid)) if q else 1.0
        if sc >= 0.5:
            found.append((sc, eid))
    found.sort(key=lambda x: (-x[0], x[1]))
    if found:
        # Hide the long tail that matched one word of several once something matched them all.
        cut = max(0.5, found[0][0] - 0.35)
        found = [f for f in found if f[0] >= cut]
    found = found[: args.limit]
    if args.json:
        return print(json.dumps([dict(states[e], area=areas.get(e), score=round(sc, 2)) for sc, e in found], indent=1))
    if not found:
        print("nothing matches. Try fewer or other words, --domain (light, fan, climate, ...), or `areas`.")
        return
    for sc, eid in found:
        s = states[eid]
        unit = s.get("attributes", {}).get("unit_of_measurement") or ""
        print(f"{eid}\t{s['state']}{(' ' + unit) if unit else ''}\t{s.get('attributes', {}).get('friendly_name', '')}"
              f"\t[{areas.get(eid, 'no area')}]\tmatch {sc:.2f}")
    if len(found) == args.limit:
        print(f"(first {args.limit}; add words or --domain/--area to narrow, or --limit)")


def cmd_state(args):
    states = all_states(args)
    areas, _ = area_map(args)
    out = []
    for ref in args.entities:
        eid = resolve(args, ref, states, areas)
        out.append(states[eid])
        if not args.json:
            show_state(args, states[eid], areas.get(eid), args.all)
    if args.json:
        print(json.dumps(out, indent=1))


def cmd_services(args):
    services = request(args, "GET", "/api/services") or []
    if args.domain:
        services = [d for d in services if d["domain"] == args.domain]
        if not services:
            raise Fail(f"no service domain '{args.domain}' (that integration is not loaded)")
    if args.json:
        return print(json.dumps(services, indent=1))
    for d in services:
        if not args.domain:
            print(f"{d['domain']}: {', '.join(sorted(d['services']))}")
            continue
        for name, spec in sorted(d["services"].items()):
            print(f"{d['domain']}.{name}" + (f" - {spec.get('description')}" if spec.get("description") else ""))
            for f, fs in (spec.get("fields") or {}).items():
                if not isinstance(fs, dict):
                    continue
                if "fields" in fs and isinstance(fs["fields"], dict):  # an "advanced" section groups fields
                    for f2, fs2 in fs["fields"].items():
                        print(f"    {f2}" + (f"  e.g. {fs2.get('example')}" if fs2.get("example") is not None else ""))
                    continue
                sel = list((fs.get("selector") or {}).keys())
                print(f"    {f}" + (f" ({sel[0]})" if sel else "") + (" required" if fs.get("required") else "")
                      + (f"  e.g. {fs.get('example')}" if fs.get("example") is not None else ""))


def cmd_call(args):
    if "." not in args.service:
        raise Fail("the service is DOMAIN.SERVICE, e.g. light.turn_on", 1)
    domain, service = args.service.split(".", 1)
    entities, data = [], {}
    for item in args.rest:
        if re.match(r"^[a-z_]+=", item):
            k, v = item.split("=", 1)
            data[k] = coerce(v)
        else:
            entities.append(item)
    states = all_states(args)
    areas, _ = area_map(args)
    target_domain = None if domain in ("homeassistant", "scene", "script", "notify", "tts", "persistent_notification") else domain
    ids = [resolve(args, e, states, areas, target_domain) for e in entities]
    # Known services and their fields, to catch a typo before Home Assistant does with a vaguer message.
    services = {d["domain"]: d["services"] for d in (request(args, "GET", "/api/services") or [])}
    if domain not in services or service not in services[domain]:
        avail = ", ".join(sorted(services.get(domain, {}))) or "none - that integration is not loaded"
        raise Fail(f"no service {args.service}. {domain} has: {avail}")
    spec = services[domain][service] or {}
    known = set()
    for f, fs in (spec.get("fields") or {}).items():
        if isinstance(fs, dict) and isinstance(fs.get("fields"), dict):
            known |= set(fs["fields"])  # a collapsible section ("advanced_fields"), not a field
        else:
            known.add(f)
    # The published field list is not the whole schema (play_media still takes media_content_id), so an unlisted
    # field is called anyway - but named, so a 400 that follows can be traced to it.
    unknown = [k for k in data if known and k not in known]
    notes = [f"{k} is not among {args.service}'s listed fields ({', '.join(sorted(known))}) - sent anyway"
             for k in unknown]
    notes += check_values(data, ids, states)
    sensitive = args.service in NEEDS_CONFIRMATION
    if domain == "cover" and service == "open_cover":
        sensitive = any(states[e].get("attributes", {}).get("device_class") in SENSITIVE_COVER_CLASSES for e in ids)
    if sensitive and not args.confirmed:
        raise Fail(f"{args.service} on {', '.join(ids) or 'everything'} acts on safety or on the house itself. Ask the "
                   f"person first; run it again with --confirmed only after they said yes in this conversation.", 2)
    if ids:
        data["entity_id"] = ids if len(ids) > 1 else ids[0]
    path = f"/api/services/{domain}/{service}" + ("?return_response" if args.response else "")
    for n in notes:
        print("note: " + n)
    try:
        result = request(args, "POST", path, data)
    except Fail as e:
        msg = str(e)
        if unknown:
            msg += f" - most likely the field{'s' if len(unknown) > 1 else ''} {', '.join(unknown)}; " \
                   f"{args.service} takes: {', '.join(sorted(known))}"
        elif msg.startswith("HTTP 500"):
            msg = (f"Home Assistant failed to run {args.service} {json.dumps(data)} (HTTP 500). Usually a value the "
                   f"device does not support, or the device/integration errored: read `state ENTITY --all` for what "
                   f"it accepts, and `logbook ENTITY`.")
        if args.service == "climate.set_temperature" and "hvac_mode" not in data:
            msg += " (A climate entity that is off may need hvac_mode=cool/heat/auto in the same call.)"
        raise Fail(msg, e.code)
    if args.json:
        return print(json.dumps(result, indent=1))
    print(f"called {args.service} " + json.dumps(data, ensure_ascii=False))
    if args.response:
        print(json.dumps(result.get("service_response") if isinstance(result, dict) else result, indent=1, ensure_ascii=False))
        return
    changed = result if isinstance(result, list) else (result or {}).get("changed_states", []) if isinstance(result, dict) else []
    if ids:
        # Read back what the device reports now: a call that HA accepted is not yet a light that is on.
        import time
        time.sleep(1.5)
        now = all_states(args)
        for e in ids:
            s = now.get(e)
            if s:
                show_state(args, s, areas.get(e))
        print("(the state above is read back after the call; a device that reports late can lag a few seconds - "
              "check again with `state` if it did not change)")
    elif changed:
        for s in changed[:20]:
            print(f"  now {s['entity_id']}: {s['state']}")


def cmd_areas(args):
    states = all_states(args)
    _, rows = area_map(args)
    if not rows:
        print("no areas defined in Home Assistant (or templates are not available). Use `find` by name instead.")
        return
    if args.name:
        name = match_area(args.name, rows)
        pick = [r for r in rows if r[1] == name]
        if not pick:
            raise Fail(f"no area like '{args.name}'. Areas: {', '.join(r[1] for r in rows)}")
        rows = pick
    if args.json:
        return print(json.dumps([{"area_id": a, "name": n, "entities": e} for a, n, e in rows], indent=1))
    for aid, name, ents in rows:
        print(f"{name} (area id {aid}): {len(ents)} entities")
        if args.name:
            for e in sorted(ents):
                s = states.get(e, {})
                print(f"  {e}\t{s.get('state', '?')}\t{s.get('attributes', {}).get('friendly_name', '')}")


def window(args):
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(hours=args.hours)
    return start, end


def cmd_history(args):
    eid = resolve(args, args.entity)
    start, end = window(args)
    q = urllib.parse.urlencode({"filter_entity_id": eid, "end_time": end.isoformat(), "minimal_response": "",
                                "no_attributes": ""})
    data = request(args, "GET", f"/api/history/period/{urllib.parse.quote(start.isoformat())}?{q}", timeout=60) or []
    rows = data[0] if data else []
    if args.json:
        return print(json.dumps(rows, indent=1))
    if not rows:
        print(f"{eid}: no history in the last {args.hours}h (the recorder may exclude it, or it did not exist yet)")
        return
    print(f"{eid}: {len(rows)} records over the last {args.hours}h ({local(args, start)} to {local(args, end)})")
    nums = []
    for r in rows:
        try:
            nums.append(float(r["state"]))
        except (ValueError, TypeError):
            pass
    if nums and len(nums) >= len(rows) * 0.8:
        print(f"  min {min(nums):g}   max {max(nums):g}   average {sum(nums) / len(nums):.2f} (of the recorded "
              f"values, not time-weighted)   last {rows[-1]['state']}")
        step = max(1, len(rows) // 12)
        for r in rows[::step]:
            print(f"  {local(args, r.get('last_changed'))}  {r['state']}")
        return
    # A state that switches: how long in each, and the changes themselves.
    totals = {}
    for i, r in enumerate(rows):
        t0 = max(parse_time(r.get("last_changed")) or start, start)
        t1 = parse_time(rows[i + 1].get("last_changed")) if i + 1 < len(rows) else end
        totals[r["state"]] = totals.get(r["state"], 0) + max((t1 - t0).total_seconds(), 0)
    print("  time in each state: " + ", ".join(f"{k} {span(v)}" for k, v in sorted(totals.items(), key=lambda x: -x[1])))
    shown = rows[-40:]
    if len(rows) > 40:
        print(f"  (last 40 of {len(rows)} changes)")
    for r in shown:
        print(f"  {local(args, r.get('last_changed'))}  {r['state']}")


def cmd_logbook(args):
    start, end = window(args)
    params = {"end_time": end.isoformat()}
    if args.entity:
        params["entity"] = resolve(args, args.entity)
    data = request(args, "GET", f"/api/logbook/{urllib.parse.quote(start.isoformat())}?{urllib.parse.urlencode(params)}",
                   timeout=60) or []
    if args.json:
        return print(json.dumps(data, indent=1))
    if not data:
        print(f"no logbook entries in the last {args.hours}h")
        return
    for e in data[-60:]:
        who = e.get("context_user_id") and " (by a user)" or ""
        st = e.get("state")
        if st and re.match(r"^\d{4}-\d\d-\d\dT", st):
            st = None  # a scene, script or button's state is when it last ran
            what = e.get("message") or "activated"
        else:
            what = e.get("message") or (f"turned {st}" if st else "")
        print(f"{local(args, e.get('when'))}  {e.get('name') or e.get('entity_id')}: {what}{who}")
    if len(data) > 60:
        print(f"(last 60 of {len(data)} entries)")


def cmd_template(args):
    out = request(args, "POST", "/api/template", {"template": args.template})
    if out in (None, "") or (args.quiet and not str(out).strip()):
        if not args.quiet:  # a scheduled check prints nothing when all is well, so nothing is delivered
            print("(the template rendered to nothing - an empty list, or no entity matched)")
        return
    print(out)


def cmd_say(args):
    body = {"text": args.text}
    if args.language:
        body["language"] = args.language
    data = request(args, "POST", "/api/conversation/process", body, timeout=30) or {}
    if args.json:
        return print(json.dumps(data, indent=1))
    resp = data.get("response") or {}
    speech = ((resp.get("speech") or {}).get("plain") or {}).get("speech")
    print(f"Assist answered ({resp.get('response_type')}): {speech}")
    for kind in ("success", "failed"):
        for t in (resp.get("data") or {}).get(kind) or []:
            print(f"  {kind}: {t.get('id')} ({t.get('name')})")


def cmd_snapshot(args):
    eid = resolve(args, args.camera, domain="camera")
    payload, ctype = request(args, "GET", f"/api/camera_proxy/{eid}", raw=True, timeout=30)
    ext = ".png" if "png" in ctype else ".svg" if "svg" in ctype else ".jpg"
    out = args.out or os.path.join(os.environ.get("TMPDIR", "/tmp"), f"{eid.replace('.', '_')}{ext}")
    with open(out, "wb") as f:
        f.write(payload)
    print(f"saved {out} ({len(payload)} bytes, {ctype}) - read it to see the picture")


def cmd_config(args):
    """Automations, scripts and scenes made in HA's UI live in automations.yaml / scripts.yaml / scenes.yaml, and
    the config API reads and writes them by their config id (the `id` attribute of an automation, the object id of
    a script). Writes and deletes reload them at once, so both need the person's yes."""
    ref = args.id
    if args.kind == "automation" and ref.startswith("automation."):
        st = request(args, "GET", f"/api/states/{ref}") or {}
        ref = (st.get("attributes") or {}).get("id") or ""
        if not ref:
            raise Fail(f"{args.id} has no config id: it is written in YAML by hand, not in the UI, so the config API "
                       f"cannot read or change it. The person edits it in their configuration files.")
    elif args.kind in ("script", "scene") and ref.startswith(args.kind + "."):
        ref = ref.split(".", 1)[1]
        if args.kind == "scene":
            st = request(args, "GET", f"/api/states/{args.id}") or {}
            ref = (st.get("attributes") or {}).get("id") or ref
    path = f"/api/config/{args.kind}/config/{urllib.parse.quote(ref)}"
    if args.put or args.delete:
        if not args.confirmed:
            raise Fail(f"writing or deleting {args.kind} {ref} changes how the house behaves. Show the person what "
                       f"it will do in plain words and run again with --confirmed only after they said yes.", 2)
        if args.delete:
            request(args, "DELETE", path)
            print(f"deleted {args.kind} {ref} (HA reloaded {args.kind}s)")
            return
        with open(args.put) as f:
            body = json.load(f)
        print(f"saved {args.kind} {ref}: {request(args, 'POST', path, body)} (HA reloaded {args.kind}s)")
        return
    print(json.dumps(request(args, "GET", path), indent=1, ensure_ascii=False))


def cmd_ws(args):
    fields = json.loads(args.fields) if args.fields else {}
    result = ws_command(args, args.type, fields)
    text = json.dumps(result, indent=1, ensure_ascii=False)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
        n = len(result) if isinstance(result, list) else 1
        print(f"wrote {args.out} ({n} items, {len(text)} bytes) - grep or read it")
        return
    if len(text) > 20000:
        print(text[:20000])
        print(f"... cut at 20000 of {len(text)} characters: run again with --out FILE and grep it")
    else:
        print(text)


def main(argv=None):
    p = argparse.ArgumentParser(prog="ha.py", description=__doc__.split("\n\n")[0].strip(),
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    p.add_argument("--url", help="Home Assistant base URL (default $HA_URL, then http://homeassistant.local:8123)")
    p.add_argument("--token-env", help="the environment variable holding the token (default HA_TOKEN)")
    p.add_argument("--insecure", action="store_true", help="accept a self-signed certificate")
    p.add_argument("--json", action="store_true", help="print the raw JSON answer")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ping", help="check the URL and the token; show version and time zone")
    s = sub.add_parser("find", help="find entities by words in their name, id or area (English or Indonesian)")
    s.add_argument("words", nargs="*")
    s.add_argument("--domain", help="only this domain: light, fan, climate, vacuum, cover, media_player, sensor, ...")
    s.add_argument("--area", help="only entities in this area")
    s.add_argument("--limit", type=int, default=15)
    s = sub.add_parser("state", help="the state and useful attributes of entities (id or a name)")
    s.add_argument("entities", nargs="+")
    s.add_argument("--all", action="store_true", help="every attribute")
    s = sub.add_parser("call", help="call a service: call light.turn_on light.kitchen brightness_pct=60")
    s.add_argument("service")
    s.add_argument("rest", nargs="*", help="entity ids or names, then key=value fields (values are JSON if they parse)")
    s.add_argument("--confirmed", action="store_true", help="the person said yes to this exact action")
    s.add_argument("--response", action="store_true", help="the service returns data (e.g. weather.get_forecasts)")
    s = sub.add_parser("services", help="list service domains, or one domain's services and their fields")
    s.add_argument("domain", nargs="?")
    s = sub.add_parser("areas", help="list areas, or the entities in one")
    s.add_argument("name", nargs="?")
    for name, helptext in (("history", "how an entity's state changed over time"), ("logbook", "what happened, as HA's logbook says")):
        s = sub.add_parser(name, help=helptext)
        s.add_argument("entity", nargs="?" if name == "logbook" else None)
        s.add_argument("--hours", type=float, default=24)
    s = sub.add_parser("template", help="render a Jinja template on Home Assistant")
    s.add_argument("template")
    s.add_argument("--quiet", action="store_true", help="print nothing when it renders empty (for scheduled checks)")
    s = sub.add_parser("say", help="hand a sentence to Home Assistant's own Assist")
    s.add_argument("text")
    s.add_argument("--language")
    s = sub.add_parser("snapshot", help="save a camera picture to a file")
    s.add_argument("camera")
    s.add_argument("--out")
    s = sub.add_parser("config", help="read, write (--put FILE.json) or --delete a UI automation, script or scene")
    s.add_argument("kind", choices=["automation", "script", "scene"])
    s.add_argument("id", help="automation.x / its config id; script.x; scene.x")
    s.add_argument("--put", metavar="FILE", help="a JSON file with the whole definition")
    s.add_argument("--delete", action="store_true")
    s.add_argument("--confirmed", action="store_true", help="the person said yes to this exact change")
    s = sub.add_parser("ws", help="one WebSocket API command, e.g. config/entity_registry/list")
    s.add_argument("type")
    s.add_argument("fields", nargs="?", help="extra fields as a JSON object")
    s.add_argument("--out")

    args = p.parse_args(argv)
    handlers = {"ping": cmd_ping, "find": cmd_find, "state": cmd_state, "call": cmd_call, "services": cmd_services,
                "areas": cmd_areas, "history": cmd_history, "logbook": cmd_logbook, "template": cmd_template,
                "say": cmd_say, "snapshot": cmd_snapshot, "config": cmd_config, "ws": cmd_ws}
    try:
        handlers[args.cmd](args)
    except Fail as e:
        print(f"error: {e}", file=sys.stderr)
        return e.code
    except KeyboardInterrupt:
        return 130
    except Exception as e:  # never a traceback for the model to puzzle over
        if os.environ.get("HA_DEBUG"):
            raise
        print(f"error: {type(e).__name__}: {e} (set HA_DEBUG=1 for the traceback)", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
