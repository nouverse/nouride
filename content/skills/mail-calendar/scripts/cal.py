#!/usr/bin/env python3
"""
cal.py - read and add calendar events over CalDAV, and read ICS files and feeds, with the standard library only.

    python3 cal.py calendars
    python3 cal.py events [--from today] [--to +7d] [--calendar NAME] [--search TEXT] [--ics URL_OR_FILE]...
    python3 cal.py add --title T --start "2026-11-03 14:00" (--end "15:30" | --duration 90m) [--location L]
                       [--description D] [--alarm 15m] [--calendar NAME] [--attendee a@b.c]... [--confirm]
                       [--all-day] [--ics-out FILE]
    python3 cal.py delete UID [--calendar NAME] --confirm

Dates: 2026-11-03, "2026-11-03 14:00", today, tomorrow, yesterday, +3d, -2d, hari ini, besok, kemarin, lusa, and any
of those with a time ("besok 19:00", "+2d 09:30"); for --end a
time alone ("15:30") means that day. --to is inclusive: --from today --to today is all of today.
Times are shown and read in --tz (default $CAL_TZ, then this machine's zone) - give the person's zone, e.g. Asia/Jakarta.

The account comes from environment variables the person stores as secrets:
    CALDAV_URL       the server, e.g. https://caldav.icloud.com, https://caldav.fastmail.com/dav/,
                     https://cloud.example.com/remote.php/dav (Nextcloud), or one calendar's own URL
    CALDAV_USER, CALDAV_PASSWORD    the login (an app password for iCloud and Fastmail)
    CALDAV_CALENDAR  optional: the calendar `add` writes to when --calendar is not given
    CAL_ICS_URL      optional: a read-only calendar feed (Google's "secret address in iCal format", Outlook's
                     published ICS link); read when --ics is not given and there is no CALDAV_URL
--account NAME reads CALDAV_NAME_URL etc. instead.

`add` with --attendee needs --confirm: the server may email invitations. `delete` always needs --confirm.
`add --ics-out FILE` writes an .ics file and touches no server - send it, or attach it to a mail, where there is no
CalDAV (Google, Outlook).
Exit codes: 0 done; 1 bad arguments; 2 the server refused or has no such thing; 3 cannot connect or no credentials.
Never a traceback (CAL_DEBUG=1 shows one). Never prints the password or a secret feed URL.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

TIMEOUT = 30
NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav", "a": "http://apple.com/ns/ical/", "cs": "http://calendarserver.org/ns/"}
WINDOWS_TZ = {  # Outlook writes Windows zone names; the common ones for this audience
    "SE Asia Standard Time": "Asia/Jakarta", "Singapore Standard Time": "Asia/Singapore",
    "Tokyo Standard Time": "Asia/Tokyo", "China Standard Time": "Asia/Shanghai", "India Standard Time": "Asia/Kolkata",
    "W. Australia Standard Time": "Australia/Perth", "AUS Eastern Standard Time": "Australia/Sydney",
    "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin",
    "Romance Standard Time": "Europe/Paris", "Central Europe Standard Time": "Europe/Budapest",
    "Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago",
    "Mountain Standard Time": "America/Denver", "Pacific Standard Time": "America/Los_Angeles",
    "UTC": "UTC", "Coordinated Universal Time": "UTC", "Arab Standard Time": "Asia/Riyadh",
    "Korea Standard Time": "Asia/Seoul", "Taipei Standard Time": "Asia/Taipei", "Malay Peninsula Standard Time": "Asia/Kuala_Lumpur",
}
DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


class Fail(Exception):
    def __init__(self, message, code=2):
        super().__init__(message)
        self.code = code


try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None


def zone(name):
    if not name:
        return None
    name = WINDOWS_TZ.get(name.strip('"'), name.strip('"'))
    if ZoneInfo is None:
        return None
    try:
        return ZoneInfo(name)
    except Exception:
        m = re.search(r"([A-Z][a-z]+/[A-Za-z_]+)", name)  # "/mozilla.org/.../Asia/Jakarta" style
        if m:
            try:
                return ZoneInfo(m.group(1))
            except Exception:
                return None
        return None


def local_zone(args):
    name = args.tz or os.environ.get("CAL_TZ") or os.environ.get("TZ", "").lstrip(":")
    if name:
        z = zone(name)
        if z is None:
            raise Fail(f"unknown time zone '{name}': use an IANA name such as Asia/Jakarta", 1)
        return z
    for path in ("/etc/timezone",):
        try:
            z = zone(open(path).read().strip())
            if z:
                return z
        except OSError:
            pass
    try:
        link = os.readlink("/etc/localtime")
        m = re.search(r"zoneinfo/(.+)$", link)
        if m and zone(m.group(1)):
            return zone(m.group(1))
    except OSError:
        pass
    return dt.datetime.now().astimezone().tzinfo


# ---------------------------------------------------------------- dates from the command line

def parse_when(text, tz, base=None, end_of_day=False):
    """Returns (datetime aware, is_date_only)."""
    v = re.sub(r"\s+", " ", text.strip().lower())
    today = dt.datetime.now(tz).date()
    m = re.fullmatch(r"(.+?)\s+(?:jam |pukul |at )?(\d{1,2})[:.](\d{2})", v)
    if m and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", m.group(1)):
        day_part, _ = parse_when(m.group(1), tz)
        return dt.datetime.combine(day_part.date(), dt.time(int(m.group(2)), int(m.group(3))), tz), False
    words = {"today": 0, "hari ini": 0, "tomorrow": 1, "besok": 1, "yesterday": -1, "kemarin": -1, "lusa": 2}
    day = None
    if v in words:
        day = today + dt.timedelta(days=words[v])
    m = re.fullmatch(r"([+-]\d+)\s*([dw])", v)
    if m:
        n = int(m.group(1)) * (7 if m.group(2) == "w" else 1)
        day = today + dt.timedelta(days=n)
    if day is not None:
        t = dt.time(23, 59, 59) if end_of_day else dt.time(0, 0)
        return dt.datetime.combine(day, t, tz), True
    m = re.fullmatch(r"(\d{1,2})[:.](\d{2})", v)
    if m and base is not None:
        return dt.datetime.combine(base.date(), dt.time(int(m.group(1)), int(m.group(2))), tz), False
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H.%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return dt.datetime.strptime(text.strip(), fmt).replace(tzinfo=tz), False
        except ValueError:
            pass
    try:
        d = dt.date.fromisoformat(text.strip())
        t = dt.time(23, 59, 59) if end_of_day else dt.time(0, 0)
        return dt.datetime.combine(d, t, tz), True
    except ValueError:
        raise Fail(f"cannot read the date '{text}': use 2026-11-03, \"2026-11-03 14:00\", today, tomorrow, +3d", 1)


def parse_duration(text):
    m = re.fullmatch(r"\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*", text.lower())
    if not m or not (m.group(1) or m.group(2)):
        m2 = re.fullmatch(r"\s*(\d+)\s*d\s*", text.lower())
        if m2:
            return dt.timedelta(days=int(m2.group(1)))
        raise Fail(f"cannot read the duration '{text}': use 30m, 1h, 1h30m, 2d", 1)
    return dt.timedelta(hours=int(m.group(1) or 0), minutes=int(m.group(2) or 0))


# ---------------------------------------------------------------- iCalendar

def unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text).replace("\r\n", "\n").replace("\r", "\n").split("\n")


def unescape(v):
    return re.sub(r"\\([nN,;\\])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), v)


def parse_line(line):
    # NAME;PARAM=VAL;PARAM="A:B":VALUE - the first colon outside quotes ends the parameters.
    inq, i = False, 0
    for i, ch in enumerate(line):
        if ch == '"':
            inq = not inq
        elif ch == ":" and not inq:
            break
    else:
        return None
    head, value = line[:i], line[i + 1:]
    parts = re.findall(r'(?:[^;"]|"[^"]*")+', head)
    name = parts[0].upper() if parts else ""
    params = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.strip('"')
    return name, params, value


def parse_ics(text):
    """-> list of VEVENT dicts: {prop: [(params, value), ...]}, plus the VTIMEZONE offsets seen."""
    events, stack, tz_offsets, cur_tz = [], [], {}, None
    for line in unfold(text):
        if not line.strip():
            continue
        parsed = parse_line(line)
        if not parsed:
            continue
        name, params, value = parsed
        if name == "BEGIN":
            stack.append({"_type": value.upper()})
            if value.upper() == "VTIMEZONE":
                cur_tz = None
            continue
        if name == "END":
            comp = stack.pop() if stack else {}
            if comp.get("_type") == "VEVENT" and not any(s.get("_type") == "VEVENT" for s in stack):
                events.append(comp)
            elif comp.get("_type") == "VALARM" and stack and stack[-1].get("_type") == "VEVENT":
                stack[-1].setdefault("_alarms", []).append(comp)
            elif comp.get("_type") == "STANDARD" and cur_tz and "TZOFFSETTO" in comp:
                tz_offsets[cur_tz] = comp["TZOFFSETTO"][0][1]
            continue
        if stack:
            stack[-1].setdefault(name, []).append((params, value))
            if stack[-1].get("_type") == "VTIMEZONE" and name == "TZID":
                cur_tz = value
    return events, tz_offsets


def ics_time(params, value, offsets, floating_tz):
    """-> (aware datetime, all_day)."""
    value = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        d = dt.datetime.strptime(value[:8], "%Y%m%d")
        return d.replace(tzinfo=floating_tz), True
    base = dt.datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
    if value.endswith("Z"):
        return base.replace(tzinfo=dt.timezone.utc), False
    tzid = params.get("TZID")
    if tzid:
        z = zone(tzid)
        if z is None and tzid in offsets:
            off = offsets[tzid]
            sign = -1 if off.startswith("-") else 1
            z = dt.timezone(sign * dt.timedelta(hours=int(off[1:3]), minutes=int(off[3:5] or 0)))
        if z is not None:
            return base.replace(tzinfo=z), False
    return base.replace(tzinfo=floating_tz), False


def first(ev, key, default=""):
    v = ev.get(key)
    return unescape(v[0][1]) if v else default


def expand(ev, start, end, offsets, ftz):
    """Every occurrence of the event that overlaps [start, end), as (begin, finish, all_day, note)."""
    if "DTSTART" not in ev:
        return []
    s0, all_day = ics_time(*ev["DTSTART"][0], offsets, ftz)
    if "DTEND" in ev:
        e0, _ = ics_time(*ev["DTEND"][0], offsets, ftz)
        length = e0 - s0
    elif "DURATION" in ev:
        length = ical_duration(ev["DURATION"][0][1])
    else:
        length = dt.timedelta(days=1) if all_day else dt.timedelta(0)
    exdates = set()
    for params, value in ev.get("EXDATE", []):
        for v in value.split(","):
            try:
                exdates.add(ics_time(params, v, offsets, ftz)[0])
            except ValueError:
                pass
    rrule = ev.get("RRULE")
    note = ""
    starts = [s0]
    if rrule:
        starts, note = rrule_starts(rrule[0][1], s0, end, length, start)
    for params, value in ev.get("RDATE", []):
        for v in value.split(","):
            try:
                starts.append(ics_time(params, v, offsets, ftz)[0])
            except ValueError:
                pass
    out = []
    for s in sorted(set(starts)):
        if s in exdates:
            continue
        f = s + length
        if s < end and (f > start or (f == s and s >= start)):
            out.append((s, f, all_day, note))
    return out


def ical_duration(v):
    m = re.fullmatch(r"([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", v.strip())
    if not m:
        return dt.timedelta(0)
    sign = -1 if m.group(1) == "-" else 1
    w, d, h, mi, s = (int(x or 0) for x in m.groups()[1:])
    return sign * dt.timedelta(weeks=w, days=d, hours=h, minutes=mi, seconds=s)


def rrule_starts(rule, s0, end, length, win_start=None):
    """Expand an RRULE in the event's own wall-clock time (so 09:00 stays 09:00 across DST). Covers FREQ DAILY,
    WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (with ordinals), BYMONTHDAY, BYMONTH. Anything else
    is reported, not guessed."""
    parts = dict(p.split("=", 1) for p in rule.upper().split(";") if "=" in p)
    freq = parts.get("FREQ")
    interval = int(parts.get("INTERVAL", "1") or 1)
    count = int(parts["COUNT"]) if parts.get("COUNT", "").isdigit() else None
    until = None
    if "UNTIL" in parts:
        u = parts["UNTIL"]
        try:
            until = (dt.datetime.strptime(u[:15], "%Y%m%dT%H%M%S").replace(tzinfo=dt.timezone.utc) if "T" in u and u.endswith("Z")
                     else dt.datetime.strptime(u[:15], "%Y%m%dT%H%M%S").replace(tzinfo=s0.tzinfo) if "T" in u
                     else dt.datetime.strptime(u[:8], "%Y%m%d").replace(hour=23, minute=59, second=59, tzinfo=s0.tzinfo))
        except ValueError:
            until = None
    unsupported = [k for k in parts if k in ("BYSETPOS", "BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE", "BYSECOND")]
    if freq not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY") or unsupported:
        return [s0], f"repeats ({rule}) in a way this helper does not expand - only the first time is listed"
    byday = [d for d in parts.get("BYDAY", "").split(",") if d]
    bymonthday = [int(x) for x in parts.get("BYMONTHDAY", "").split(",") if x.lstrip("-").isdigit()]
    bymonth = [int(x) for x in parts.get("BYMONTH", "").split(",") if x.isdigit()]
    tz = s0.tzinfo
    naive = s0.replace(tzinfo=None)
    t = naive.time()
    out, n = [], 0
    limit_end = end + length

    def month_days(y, m):
        days = []
        last = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)).day
        if bymonthday:
            for md in bymonthday:
                dd = md if md > 0 else last + 1 + md
                if 1 <= dd <= last:
                    days.append(dt.date(y, m, dd))
        if byday:
            for spec in byday:
                mm = re.fullmatch(r"([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)", spec)
                if not mm:
                    continue
                wd = DAYS.index(mm.group(2))
                all_wd = [dt.date(y, m, d) for d in range(1, last + 1) if dt.date(y, m, d).weekday() == wd]
                if mm.group(1):
                    k = int(mm.group(1))
                    if -len(all_wd) <= k <= len(all_wd) and k != 0:
                        days.append(all_wd[k - 1] if k > 0 else all_wd[k])
                else:
                    days += all_wd
        if not bymonthday and not byday:
            if naive.day <= last:
                days.append(dt.date(y, m, naive.day))
        return sorted(set(days))

    first_i = 0
    if count is None and win_start is not None and win_start > s0:
        # Skip whole periods before the window, so a daily event begun years ago is still found.
        gap = (win_start.astimezone(tz).replace(tzinfo=None) - naive).days
        per = {"DAILY": 1, "WEEKLY": 7, "MONTHLY": 28, "YEARLY": 365}[freq] * interval
        first_i = max(0, gap // per - 2)
        if freq == "MONTHLY":
            first_i = max(0, (gap // 31) // interval - 1)
    for i in range(first_i, first_i + 5000):
        if freq == "DAILY":
            d = naive.date() + dt.timedelta(days=i * interval)
            cands = [d] if (not byday or DAYS[d.weekday()] in [b[-2:] for b in byday]) and (not bymonth or d.month in bymonth) else []
        elif freq == "WEEKLY":
            week0 = naive.date() - dt.timedelta(days=naive.weekday()) + dt.timedelta(weeks=i * interval)
            wds = [DAYS.index(b[-2:]) for b in byday] if byday else [naive.weekday()]
            cands = sorted(week0 + dt.timedelta(days=w) for w in wds)
        elif freq == "MONTHLY":
            mi = naive.month - 1 + i * interval
            y, m = naive.year + mi // 12, mi % 12 + 1
            cands = month_days(y, m) if (not bymonth or m in bymonth) else []
        else:  # YEARLY
            y = naive.year + i * interval
            cands = []
            for m in (bymonth or [naive.month]):
                if byday or bymonthday:
                    cands += month_days(y, m)
                else:
                    try:
                        cands.append(dt.date(y, m, naive.day))
                    except ValueError:
                        pass
        stop = False
        for d in sorted(cands):
            cand = dt.datetime.combine(d, t)
            if cand < naive:
                continue
            aware = cand.replace(tzinfo=tz)
            if until and aware > until:
                stop = True
                break
            n += 1
            if count and n > count:
                stop = True
                break
            if aware >= limit_end:
                stop = True
                break
            out.append(aware)
        if stop:
            break
    return out, ""


def occurrences(text, start, end, ftz, source):
    events, offsets = parse_ics(text)
    overrides = {}
    for ev in events:
        if "RECURRENCE-ID" in ev:
            rid, _ = ics_time(*ev["RECURRENCE-ID"][0], offsets, ftz)
            overrides[(first(ev, "UID"), rid)] = ev
    out = []
    for ev in events:
        if "RECURRENCE-ID" in ev:
            continue
        uid = first(ev, "UID")
        for s, f, all_day, note in expand(ev, start, end, offsets, ftz):
            use = overrides.pop((uid, s), ev)
            if use is not ev:
                s2, ad2 = ics_time(*use["DTSTART"][0], offsets, ftz)
                f2 = ics_time(*use["DTEND"][0], offsets, ftz)[0] if "DTEND" in use else s2 + (f - s)
                s, f, all_day = s2, f2, ad2
            if first(use, "STATUS").upper() == "CANCELLED":
                continue
            out.append(row(use, s, f, all_day, note, source))
    for (uid, rid), ev in overrides.items():  # a moved instance whose original is outside the window
        if first(ev, "STATUS").upper() == "CANCELLED":
            continue
        s, ad = ics_time(*ev["DTSTART"][0], offsets, ftz)
        f = ics_time(*ev["DTEND"][0], offsets, ftz)[0] if "DTEND" in ev else s
        if s < end and f > start:
            out.append(row(ev, s, f, ad, "", source))
    return out


def row(ev, s, f, all_day, note, source):
    attendees = [v.replace("mailto:", "").replace("MAILTO:", "") for _, v in ev.get("ATTENDEE", [])]
    return {"uid": first(ev, "UID"), "title": first(ev, "SUMMARY", "(no title)"), "start": s, "end": f,
            "all_day": all_day, "location": first(ev, "LOCATION"), "description": first(ev, "DESCRIPTION"),
            "organizer": first(ev, "ORGANIZER").replace("mailto:", ""), "attendees": attendees,
            "url": first(ev, "URL"), "calendar": source, "note": note, "status": first(ev, "STATUS")}


# ---------------------------------------------------------------- CalDAV over HTTP

def creds(args):
    prefix = f"CALDAV_{args.account.upper()}_" if args.account else "CALDAV_"
    get = lambda k: os.environ.get(prefix + k) or ""
    return prefix, get("URL"), get("USER"), get("PASSWORD"), get("CALENDAR")


def mask_url(url):
    p = urllib.parse.urlsplit(url)
    return f"{p.scheme}://{p.hostname}/..." if p.path and len(p.path) > 1 else f"{p.scheme}://{p.hostname}"


def http(method, url, user, password, body=None, headers=None, depth=None, redirects=5, secret_url=False):
    h = {"User-Agent": "nouride-cal/1"}
    if user or password:
        h["Authorization"] = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
    if body is not None:
        h["Content-Type"] = "application/xml; charset=utf-8"
    if depth is not None:
        h["Depth"] = str(depth)
    h.update(headers or {})
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    shown = mask_url(url) if secret_url else url
    ctx = ssl.create_default_context()
    if os.environ.get("CALDAV_INSECURE") in ("1", "true", "yes"):
        ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))
    try:
        with opener.open(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.read(), dict(resp.headers), url
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308) and redirects and e.headers.get("Location"):
            nxt = urllib.parse.urljoin(url, e.headers["Location"])
            return http(method, nxt, user, password, body, headers, depth, redirects - 1, secret_url)
        detail = e.read()[:300].decode(errors="replace")
        if e.code == 401:
            raise Fail(f"401 from {shown}: the user name or password was refused (iCloud and Fastmail need an app "
                       f"password; Google refuses passwords on CalDAV altogether).", 2)
        if e.code == 403:
            raise Fail(f"403 from {shown}: not allowed (a read-only or shared calendar?). {detail}", 2)
        return e.code, detail.encode(), dict(e.headers or {}), url
    except ssl.SSLCertVerificationError as e:
        raise Fail(f"the certificate of {mask_url(url)} does not verify ({e.verify_message}); for a server on your own "
                   f"network only: CALDAV_INSECURE=1", 3)
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        raise Fail(f"cannot reach {mask_url(url)}: {getattr(e, 'reason', e)}", 3)


def propfind(url, user, pw, props, depth):
    body = ('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" '
            'xmlns:a="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/"><d:prop>' + props +
            "</d:prop></d:propfind>")
    status, data, headers, final = http("PROPFIND", url, user, pw, body, depth=depth)
    if status == 404:
        return None, final
    if status not in (207, 200):
        raise Fail(f"PROPFIND {url} answered {status}: {data[:200].decode(errors='replace')}", 2)
    try:
        return ET.fromstring(data), final
    except ET.ParseError as e:
        raise Fail(f"the server's answer is not XML ({e}); is CALDAV_URL a CalDAV address?", 2)


def href_of(el, base):
    h = el.find(".//d:href", NS)
    return urllib.parse.urljoin(base, h.text.strip()) if h is not None and h.text else None


def discover(args):
    prefix, url, user, pw, default_cal = creds(args)
    if not url:
        raise Fail(f"no ${prefix}URL. The person stores the server address and login as secrets - e.g. "
                   f"`/secret set {prefix.lower()}url https://caldav.icloud.com`, `{prefix.lower()}user`, "
                   f"`{prefix.lower()}password` (an app password) - or, for a read-only feed, CAL_ICS_URL.", 3)
    if not user or not pw:
        raise Fail(f"${prefix}USER or ${prefix}PASSWORD is empty", 3)
    url = url if url.endswith("/") else url + "/"
    props = "<d:current-user-principal/><d:resourcetype/><d:displayname/><c:calendar-home-set/>"
    root, final = propfind(url, user, pw, props, 0)
    if root is None:
        wk = urllib.parse.urljoin(url, "/.well-known/caldav")
        root, final = propfind(wk, user, pw, props, 0)
        if root is None:
            raise Fail(f"{url} is not a CalDAV address (404, and /.well-known/caldav too). Check the URL for the provider.", 2)
    if root.find(".//d:resourcetype/c:calendar", NS) is not None:
        return [calendar_info(root.find("d:response", NS), final)], user, pw, default_cal
    home = root.find(".//c:calendar-home-set", NS)
    if home is None or home.find("d:href", NS) is None:
        pr = root.find(".//d:current-user-principal", NS)
        if pr is None or pr.find("d:href", NS) is None:
            raise Fail(f"{final} gave no principal and no calendar home; give the calendar's own URL as CALDAV_URL", 2)
        principal = href_of(pr, final)
        proot, pfinal = propfind(principal, user, pw, "<c:calendar-home-set/>", 0)
        home = proot.find(".//c:calendar-home-set", NS) if proot is not None else None
        final = pfinal
        if home is None or home.find("d:href", NS) is None:
            raise Fail("the server gave no calendar-home-set for this user", 2)
    home_url = href_of(home, final)
    root, hfinal = propfind(home_url, user, pw, "<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>"
                            "<a:calendar-color/><d:current-user-privilege-set/><cs:getctag/>", 1)
    cals = []
    for resp in (root.findall("d:response", NS) if root is not None else []):
        if resp.find(".//d:resourcetype/c:calendar", NS) is None:
            continue
        cals.append(calendar_info(resp, hfinal))
    if not cals:
        raise Fail("no calendars found under the calendar home", 2)
    return cals, user, pw, default_cal


def calendar_info(resp, base):
    href = href_of(resp, base)
    name = (resp.findtext(".//d:displayname", default="", namespaces=NS) or "").strip() or href.rstrip("/").rsplit("/", 1)[-1]
    comps = [c.get("name") for c in resp.findall(".//c:supported-calendar-component-set/c:comp", NS)]
    privs = resp.find(".//d:current-user-privilege-set", NS)
    writable = True
    if privs is not None:
        names = {p.tag.split("}")[-1] for p in privs.iter()}
        writable = bool(names & {"write", "write-content", "all", "bind"})
    return {"name": name, "url": href, "components": comps or ["VEVENT"], "writable": writable,
            "color": resp.findtext(".//a:calendar-color", default="", namespaces=NS)}


def pick_calendars(cals, wanted, for_write=False):
    events = [c for c in cals if "VEVENT" in c["components"]]
    if wanted:
        w = wanted.lower()
        hit = [c for c in events if c["name"].lower() == w] or [c for c in events if w in c["name"].lower()]
        if not hit:
            raise Fail(f"no calendar '{wanted}'. Calendars: {', '.join(c['name'] for c in events)}", 2)
        return hit[:1] if for_write else hit
    if for_write:
        writable = [c for c in events if c["writable"]]
        if not writable:
            raise Fail("no calendar here accepts new events", 2)
        return writable[:1]
    return events


def utc(d):
    return d.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def report(cal, user, pw, start, end, uid=None):
    filt = (f'<c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">{uid}'
            f'</c:text-match></c:prop-filter></c:comp-filter>' if uid else
            f'<c:comp-filter name="VEVENT"><c:time-range start="{utc(start)}" end="{utc(end)}"/></c:comp-filter>')
    body = ('<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            '<d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR">' + filt +
            "</c:comp-filter></c:filter></c:calendar-query>")
    status, data, _, final = http("REPORT", cal["url"], user, pw, body, depth=1)
    if status not in (207, 200):
        raise Fail(f"REPORT on {cal['name']} answered {status}: {data[:200].decode(errors='replace')}", 2)
    root = ET.fromstring(data)
    out = []
    for resp in root.findall("d:response", NS):
        text = resp.findtext(".//c:calendar-data", default="", namespaces=NS)
        if text:
            out.append((href_of(resp, final), resp.findtext(".//d:getetag", default="", namespaces=NS), text))
    return out


# ---------------------------------------------------------------- commands

def cmd_calendars(args):
    cals, *_ = discover(args)
    if args.json:
        return print(json.dumps(cals, indent=1, ensure_ascii=False))
    for c in cals:
        kinds = ",".join(c["components"])
        print(f"{c['name']}\t{kinds}\t{'writable' if c['writable'] else 'read-only'}\t{c['url']}")


def fmt_rows(rows, tz):
    rows.sort(key=lambda r: (r["start"].astimezone(tz) if not r["all_day"] else r["start"].replace(tzinfo=tz), r["title"]))
    day = None
    for r in rows:
        s = r["start"] if r["all_day"] else r["start"].astimezone(tz)
        f = r["end"] if r["all_day"] else r["end"].astimezone(tz)
        d = s.date()
        if d != day:
            print(f"{s.strftime('%a %Y-%m-%d')}")
            day = d
        if r["all_day"]:
            days = max(1, (f.date() - s.date()).days)
            when = "all day" + (f" ({days} days, to {(f - dt.timedelta(days=1)).strftime('%Y-%m-%d')})" if days > 1 else "")
        else:
            when = f"{s.strftime('%H:%M')}-{f.strftime('%H:%M')}" + (f" (ends {f.strftime('%Y-%m-%d')})" if f.date() != s.date() else "")
        line = f"  {when}  {r['title']}"
        if r["location"]:
            line += f"  @ {r['location']}"
        line += f"  [{r['calendar']}]"
        print(line)
        extra = []
        if r["attendees"]:
            extra.append("with " + ", ".join(r["attendees"][:6]))
        if r["status"] and r["status"].upper() == "TENTATIVE":
            extra.append("tentative")
        if r["note"]:
            extra.append(r["note"])
        extra.append(f"uid {r['uid']}")
        print("      " + "; ".join(extra))


def window(args, tz):
    start, _ = parse_when(args.from_ or "today", tz)
    end, date_only = parse_when(args.to or "+7d", tz, end_of_day=True)
    if end <= start:
        raise Fail("--to is before --from", 1)
    return start, end


def cmd_events(args):
    tz = local_zone(args)
    start, end = window(args, tz)
    rows, sources = [], list(args.ics or [])
    prefix, url, *_ = creds(args)
    if not sources and not url and os.environ.get("CAL_ICS_URL"):
        sources = [os.environ["CAL_ICS_URL"]]
    if url and not args.ics:
        cals, user, pw, _ = discover(args)
        for c in pick_calendars(cals, args.calendar):
            for href, etag, text in report(c, user, pw, start, end):
                rows += occurrences(text, start, end, tz, c["name"])
    for src in sources:
        if re.match(r"^(https?|webcal)://", src):
            src_url = re.sub(r"^webcal://", "https://", src)
            status, data, _, _ = http("GET", src_url, "", "", secret_url=True)
            if status != 200:
                raise Fail(f"the feed {mask_url(src_url)} answered {status}", 2)
            text, name = data.decode("utf-8", errors="replace"), "feed " + (urllib.parse.urlsplit(src_url).hostname or "")
        else:
            if not os.path.isfile(src):
                raise Fail(f"no such file: {src}", 1)
            text, name = open(src, encoding="utf-8", errors="replace").read(), os.path.basename(src)
        if "BEGIN:VCALENDAR" not in text:
            raise Fail(f"{name} is not an iCalendar file (no BEGIN:VCALENDAR)", 2)
        rows += occurrences(text, start, end, tz, name)
    if not url and not sources:
        discover(args)  # no account and no feed: this raises the explanation of what to set
    if args.search:
        q = args.search.lower()
        rows = [r for r in rows if q in (r["title"] + " " + r["location"] + " " + r["description"]).lower()]
    if args.json:
        return print(json.dumps([dict(r, start=r["start"].isoformat(), end=r["end"].isoformat()) for r in rows], indent=1, ensure_ascii=False))
    span = f"{start.strftime('%Y-%m-%d')} to {end.strftime('%Y-%m-%d')} ({tz})"
    if not rows:
        print(f"no events {span}")
        return
    print(f"{len(rows)} events {span}:")
    fmt_rows(rows, tz)


def ical_text(v):
    return v.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def fold(line):
    out, b = [], line.encode()
    while len(b) > 75:
        cut = 75
        while (b[cut] & 0xC0) == 0x80:  # never split a UTF-8 character
            cut -= 1
        out.append(b[:cut].decode())
        b = b" " + b[cut:]
    out.append(b.decode())
    return "\r\n".join(out)


def build_event(args, tz):
    start, date_only = parse_when(args.start, tz)
    all_day = args.all_day or date_only
    if args.end:
        end, _ = parse_when(args.end, tz, base=start, end_of_day=False)
        if all_day and re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.end.strip()):
            end = end + dt.timedelta(days=1)  # the person's "to Friday" includes Friday
    else:
        end = start + (parse_duration(args.duration) if args.duration else (dt.timedelta(days=1) if all_day else dt.timedelta(hours=1)))
    if end <= start:
        raise Fail("the end is not after the start", 1)
    uid = f"{uuid.uuid4()}@nouride"
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nouride//cal.py//EN", "CALSCALE:GREGORIAN"]
    if args.ics_out:
        # REQUEST makes a mail client show it as an invitation to answer; PUBLISH as an event to add.
        lines.append("METHOD:REQUEST" if args.attendee else "METHOD:PUBLISH")
    lines += ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{utc(dt.datetime.now(dt.timezone.utc))}"]
    if all_day:
        lines += [f"DTSTART;VALUE=DATE:{start.strftime('%Y%m%d')}", f"DTEND;VALUE=DATE:{end.strftime('%Y%m%d')}"]
    else:
        # UTC needs no VTIMEZONE block and means the same instant to every server and app; they show it in local time.
        lines += [f"DTSTART:{utc(start)}", f"DTEND:{utc(end)}"]
    lines.append(f"SUMMARY:{ical_text(args.title)}")
    if args.location:
        lines.append(f"LOCATION:{ical_text(args.location)}")
    if args.description:
        lines.append(f"DESCRIPTION:{ical_text(args.description)}")
    for a in args.attendee or []:
        lines.append(f"ATTENDEE;RSVP=TRUE;ROLE=REQ-PARTICIPANT:mailto:{a}")
    if args.attendee:
        prefix, _, user, _, _ = creds(args)
        org = os.environ.get("MAIL_FROM") or os.environ.get("MAIL_USER") or user
        if org and "@" in org:
            lines.append(f"ORGANIZER:mailto:{org}")
    if args.alarm:
        lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{ical_text(args.title)}",
                  f"TRIGGER:-PT{int(parse_duration(args.alarm).total_seconds() // 60)}M", "END:VALARM"]
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(fold(l) for l in lines) + "\r\n", uid, start, end, all_day


def cmd_add(args):
    tz = local_zone(args)
    text, uid, start, end, all_day = build_event(args, tz)
    when = (f"{start.strftime('%a %Y-%m-%d')} all day" if all_day else
            f"{start.astimezone(tz).strftime('%a %Y-%m-%d %H:%M')}-{end.astimezone(tz).strftime('%H:%M')} ({tz})")
    if args.ics_out:
        with open(args.ics_out, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        print(f"wrote {args.ics_out}: {args.title}, {when}. Send it (send_file, or attach it to a mail) - opening it "
              f"offers to add it to the person's calendar. No server was touched.")
        return
    if args.attendee and not args.confirm:
        raise Fail(f"an event with attendees ({', '.join(args.attendee)}) may email them invitations. Tell the person "
                   f"exactly what will be sent and run again with --confirm after they agree.", 2)
    cals, user, pw, default_cal = discover(args)
    cal = pick_calendars(cals, args.calendar or default_cal, for_write=True)[0]
    clashes = []
    try:
        for href, etag, other in report(cal, user, pw, start, end):
            for r in occurrences(other, start, end, tz, cal["name"]):
                if not r["all_day"] or all_day:
                    clashes.append(r)
    except Fail:
        pass
    target = cal["url"].rstrip("/") + "/" + urllib.parse.quote(uid) + ".ics"
    status, data, headers, _ = http("PUT", target, user, pw, text, headers={"Content-Type": "text/calendar; charset=utf-8",
                                                                          "If-None-Match": "*"})
    if status not in (200, 201, 204):
        raise Fail(f"the server did not save the event ({status}): {data[:200].decode(errors='replace')}", 2)
    print(f"added to {cal['name']}: {args.title}, {when}" + (f" @ {args.location}" if args.location else ""))
    print(f"  uid {uid}")
    for r in clashes:
        s = r["start"].astimezone(tz)
        print(f"  note: overlaps '{r['title']}' at {s.strftime('%H:%M')} - tell the person")


def cmd_delete(args):
    if not args.confirm:
        raise Fail("deleting an event needs the person's yes: name it (title, date, time) and run again with --confirm", 2)
    cals, user, pw, _ = discover(args)
    for cal in pick_calendars(cals, args.calendar):
        found = report(cal, user, pw, None, None, uid=args.uid)
        for href, etag, text in found:
            h = {"If-Match": etag} if etag else {}
            status, data, _, _ = http("DELETE", href, user, pw, headers=h)
            if status not in (200, 204):
                raise Fail(f"the server did not delete it ({status}): {data[:200].decode(errors='replace')}", 2)
            events, _ = parse_ics(text)
            title = first(events[0], "SUMMARY") if events else ""
            print(f"deleted '{title}' (uid {args.uid}) from {cal['name']}")
            return
    raise Fail(f"no event with uid {args.uid} (uids come from `events`)", 2)


def main(argv=None):
    p = argparse.ArgumentParser(prog="cal.py", description=__doc__.split("\n\n")[0].strip(),
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    p.add_argument("--account", help="read CALDAV_<ACCOUNT>_URL etc. (a second calendar account)")
    p.add_argument("--tz", help="the person's time zone, e.g. Asia/Jakarta (default $CAL_TZ, then this machine's)")
    p.add_argument("--json", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("calendars", help="list the calendars on the CalDAV account")
    s = sub.add_parser("events", help="events in a time window, recurring ones expanded")
    s.add_argument("--from", dest="from_", help="default today")
    s.add_argument("--to", help="default +7d; inclusive")
    s.add_argument("--calendar", help="only this calendar (name)")
    s.add_argument("--search", help="only events whose title, place or notes contain this")
    s.add_argument("--ics", action="append", help="an .ics file or a feed URL to read instead of CalDAV")
    s = sub.add_parser("add", help="add an event")
    s.add_argument("--title", required=True)
    s.add_argument("--start", required=True)
    s.add_argument("--end")
    s.add_argument("--duration", help="30m, 1h, 1h30m, 2d (default 1h, or 1 day for an all-day event)")
    s.add_argument("--all-day", action="store_true")
    s.add_argument("--location")
    s.add_argument("--description")
    s.add_argument("--alarm", help="a reminder this long before, e.g. 15m, 1h")
    s.add_argument("--attendee", action="append", help="an invitee's address (needs --confirm)")
    s.add_argument("--calendar")
    s.add_argument("--confirm", action="store_true")
    s.add_argument("--ics-out", metavar="FILE", help="write an .ics file instead of saving to a server")
    s = sub.add_parser("delete", help="delete an event by uid (after the person's yes)")
    s.add_argument("uid")
    s.add_argument("--calendar")
    s.add_argument("--confirm", action="store_true")
    args = p.parse_args(argv)
    handlers = {"calendars": cmd_calendars, "events": cmd_events, "add": cmd_add, "delete": cmd_delete}
    try:
        handlers[args.cmd](args)
    except Fail as e:
        print(f"error: {e}", file=sys.stderr)
        return e.code
    except KeyboardInterrupt:
        return 130
    except Exception as e:
        if os.environ.get("CAL_DEBUG"):
            raise
        text = str(e)
        for name, val in os.environ.items():
            if (name.endswith("PASSWORD") or name == "CAL_ICS_URL") and val:
                text = text.replace(val, "***")
        print(f"error: {type(e).__name__}: {text} (CAL_DEBUG=1 for the traceback)", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
