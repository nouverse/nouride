# Providers: what works, and the steps to send the person

Checked in November 2026. Providers change their rules; when a login fails in a way this page does not explain, look
at the provider's own help page (search "<provider> IMAP settings") before telling the person something is broken.

Send the person only their provider's section, in their language, as numbered steps. The secret names are the ones in
SKILL.md (`mail_user`, `mail_password`, …).

## At a glance

| Provider | Mail with a password? | Calendar | Notes |
|---|---|---|---|
| Gmail / Google Workspace | yes, with an **app password** (needs 2-Step Verification) | **no CalDAV with a password**: read the secret iCal feed; add by `.ics` file or invitation mail | a Workspace admin can switch app passwords off |
| iCloud (`@icloud.com`, `@me.com`, `@mac.com`) | yes, **app-specific password** (needs two-factor) | yes, CalDAV, the same app-specific password | |
| Fastmail | yes, **app password** | yes, CalDAV | |
| Yahoo | yes, **app password** | Yahoo Calendar's CalDAV is not covered here | |
| Zoho Mail | yes, after IMAP is switched on (app password if 2FA is on) | not covered here | regional hosts (`.eu`, `.in`) differ |
| Outlook.com / Hotmail / Live | **no**, OAuth only since 16 September 2024 | read-only ICS feed (published calendar) | see below for what is left |
| Microsoft 365 work / school | **reading no** (IMAP basic auth is off); sending only where the admin still allows SMTP AUTH | read-only ICS feed if publishing is allowed | see below |
| Own domain on a hosting panel (cPanel, Plesk, DirectAdmin) | yes, the mailbox password | sometimes (cPanel has CalDAV) | the panel's "Connect devices" page lists the hosts |
| Nextcloud, Radicale, Baïkal, Synology | calendar only | yes, CalDAV with an app password / the account | |
| Proton Mail | only through Proton Mail Bridge on a computer | not covered here | Bridge gives its own local host, port and password |

## Gmail

1. Turn on **2-Step Verification**: myaccount.google.com → Security → 2-Step Verification.
2. Make an app password: **myaccount.google.com/apppasswords** → name it "Nouride" → Create. Copy the 16 letters
   (the spaces do not matter).
3. Send me: `/secret set mail_user nama@gmail.com` and `/secret set mail_password <the 16 letters>`.

If the app-password page says the setting is not available: on a work/school (Workspace) account the administrator
has switched app passwords off, and only they can allow it. On a personal account, 2-Step Verification is not on yet.

Servers (set automatically): IMAP `imap.gmail.com` 993, SMTP `smtp.gmail.com` 465.

Gmail behaves differently from other IMAP servers:

- Labels are folders. `[Gmail]/All Mail` holds everything; `[Gmail]/Sent Mail`, `[Gmail]/Drafts`, `[Gmail]/Spam`,
  `[Gmail]/Trash` (`[Gmail]/Bin` in British English accounts). The helper finds them by their role, not the name.
- `--gmail 'query'` takes the same search as Gmail's search box: `from:`, `to:`, `subject:`, `has:attachment`,
  `filename:pdf`, `newer_than:7d`, `older_than:1y`, `label:`, `is:unread`, `category:primary`.
- Moving a mail out of INBOX archives it (it stays in All Mail); `delete` moves it to Trash, which Gmail empties after
  30 days.
- Gmail files sent mail itself; the helper does not add a second copy.

**Calendar.** Google's CalDAV accepts only OAuth sign-in (a password gets `401`), which these scripts do not do.
What works:

- *Reading*: the person copies the calendar's **secret address in iCal format** from Google Calendar on the web →
  Settings (gear) → *Settings for my calendars* → the calendar → *Integrate calendar* → **Secret address in iCal
  format**, and stores it: `/secret set cal_ics_url <that address>`. Then `python3 CAL events` reads it (the feed can
  lag behind the calendar by some hours; Google refreshes it on its own schedule). It is read-only, and anyone
  with the address can read the calendar: if it leaks, *Reset* on the same page makes a new one.
- *Adding*: `python3 CAL add … --ics-out "$TMPDIR/event.ics"`, then send the file with `send_file`, or mail it to
  their Gmail address (`python3 MAIL send --to <their address> --subject "<title>" --body "…" --attach
  "$TMPDIR/event.ics"`). Gmail shows the event with an *Add to calendar* button. With `--attendee`, the file is an
  invitation the attendee can accept.

## iCloud

1. Two-factor authentication must be on for the Apple Account (it is, on any recent iPhone).
2. **account.apple.com** → *Sign-In and Security* → **App-Specific Passwords** → *Generate* → name it "Nouride".
   Copy it (`xxxx-xxxx-xxxx-xxxx`).
3. Send me: `/secret set mail_user <your full @icloud.com address>`, `/secret set mail_password <the app-specific
   password>`. For the calendar too: `/secret set caldav_url https://caldav.icloud.com`, `/secret set caldav_user
   <the Apple Account email>`, `/secret set caldav_password <the same app-specific password>`.

Servers (set automatically): IMAP `imap.mail.me.com` 993, SMTP `smtp.mail.me.com` 587 (STARTTLS). The user name is the
full iCloud address. Mail sent from an alias needs `/secret set mail_from <the alias>`.

Calendars: `python3 CAL calendars` finds them through `caldav.icloud.com` (Apple answers with the person's own
server, e.g. `p123-caldav.icloud.com`; the script follows it). Reminders lists show up as calendars that hold no
events; `calendars` lists their kinds (`VTODO`).

## Fastmail

1. Fastmail → *Settings* → *Privacy & Security* → **App passwords** (*Manage app passwords and access*) → *New app
   password*, access **Mail (IMAP/POP/SMTP)**, and **Calendars (CalDAV)** for the calendar.
2. Send me `mail_user` (the Fastmail address), `mail_password` (the app password), and for the calendar
   `caldav_url https://caldav.fastmail.com/dav/`, `caldav_user`, `caldav_password` (the same app password if it has
   both kinds of access).

Servers (set automatically): IMAP `imap.fastmail.com` 993, SMTP `smtp.fastmail.com` 465.

## Yahoo

1. Yahoo → *Account info* → **Account security** → *Generate app password* (or *Manage app passwords*) → name it
   "Nouride".
2. Send me `mail_user` (the Yahoo address) and `mail_password` (the app password).

Servers (set automatically): IMAP `imap.mail.yahoo.com` 993, SMTP `smtp.mail.yahoo.com` 465.

## Zoho Mail

1. Zoho Mail → *Settings* → *Mail Accounts* → the address → **IMAP Access**: on.
2. With two-factor on: *accounts.zoho.com* → *Security* → **App Passwords** → generate one.
3. Send me `mail_user` and `mail_password`. Accounts on another data centre also need `mail_imap_host` /
   `mail_smtp_host`: `imap.zoho.eu` / `smtp.zoho.eu`, `imap.zoho.in` / `smtp.zoho.in` (a `.com` account uses
   `imap.zoho.com` / `smtp.zoho.com`, set automatically).

## Outlook.com, Hotmail, Live (personal Microsoft accounts)

Say it plainly: **this cannot be connected with a password.** Since 16 September 2024 Microsoft accepts only OAuth
("modern authentication") for IMAP and SMTP on personal accounts, and app passwords stopped working for them. These
scripts do not do OAuth. What the person can do:

- **Forward** the mail they want you to see to an account that works (Outlook.com → *Settings* → *Mail* →
  *Forwarding*), and you read that one.
- Use another mailbox for what you send for them.
- **Calendar, read-only**: Outlook on the web → *Settings* → *Calendar* → *Shared calendars* → **Publish a calendar**
  → choose the calendar and *Can view all details* → *Publish* → copy the **ICS** link → `/secret set cal_ics_url
  <link>`.

## Microsoft 365 work or school (Exchange Online)

- **Reading mail: no.** Exchange Online turned off basic authentication for IMAP and POP in October 2022; only OAuth
  works, which these scripts do not do.
- **Sending: only where the organisation still allows SMTP AUTH** (`smtp.office365.com` 587, STARTTLS, with the
  account password). Microsoft's announced plan (message MC786329, last updated January 2026) disables SMTP AUTH with
  basic authentication by default for existing tenants at the end of December 2026 (administrators can switch it back
  on), with final removal in 2027 on a date still to be announced. A refusal reads `535 5.7.139` or `550 5.7.30`;
  then only their IT administrator can help. Set `mail_imap_host` anyway (`outlook.office365.com`) so the helper does
  not refuse the address, and expect `check` to fail on IMAP.
- **Calendar**: the published ICS link as for Outlook.com, if the organisation allows publishing.

## Own domain on a hosting panel (cPanel, Plesk, DirectAdmin)

Common in Indonesian hosting. The host names and ports are on the panel's **Email Accounts → Connect Devices**
(cPanel) or the hosting company's help page. Usually: IMAP `mail.<domain>` 993, SMTP `mail.<domain>` 465, user = the
full address, password = the mailbox password. Send me `mail_user`, `mail_password`, `mail_imap_host`,
`mail_smtp_host` (and `mail_imap_port` / `mail_smtp_port` if they differ). A certificate issued for the hosting
server's own name rather than `mail.<domain>` fails verification: then use the host name the certificate is for (the
panel shows it) rather than `MAIL_INSECURE=1`.

cPanel's calendar is CalDAV at `https://<server>:2080/` (the *Calendars and Contacts* page shows the exact URL).

## Nextcloud, Radicale, Baïkal, Synology Calendar

- **Nextcloud**: `caldav_url https://<host>/remote.php/dav`, user = the Nextcloud user, password = an app password
  (*Settings* → *Security* → *Devices & sessions* → *Create new app password*).
- **Radicale**: `caldav_url http(s)://<host>:5232/`, the Radicale user and password.
- **Baïkal**: `caldav_url https://<host>/dav.php/`.
- **Synology Calendar**: the URL its *CalDAV Account* dialog shows (`https://<nas>:5001/caldav/…`).

A server on the home network with a self-signed certificate: `CALDAV_INSECURE=1` in the command (on that network
only).

## Proton Mail

Proton encrypts mail end to end, so IMAP works only through **Proton Mail Bridge**, an app running on one of the
person's computers (paid plans). Bridge shows its own IMAP/SMTP host (`127.0.0.1`), ports (usually 1143 and 1025) and
a Bridge password. If that computer is reachable (the `network-reach` skill), store those as `mail_imap_host`,
`mail_imap_port`, `mail_smtp_host`, `mail_smtp_port`, `mail_password`, with `mail_tls starttls`; otherwise Proton is
not reachable from here.

## Settings the helper reads

| Variable | Default | Use |
|---|---|---|
| `MAIL_USER`, `MAIL_PASSWORD` | none | required |
| `MAIL_IMAP_HOST`, `MAIL_SMTP_HOST` | from the address's provider | any other provider |
| `MAIL_IMAP_PORT`, `MAIL_SMTP_PORT` | 993, 465 (iCloud, GMX: 587) | other ports |
| `MAIL_TLS`, `MAIL_IMAP_TLS`, `MAIL_SMTP_TLS` | `starttls` on 143/587/25/2525, TLS from the start elsewhere | `ssl`, `starttls`, `plain` (`plain` only to localhost) |
| `MAIL_FROM`, `MAIL_NAME` | the user; none | sender address and display name |
| `MAIL_INSECURE=1` | off | a self-signed certificate on their own network |
| `MAIL_PROVIDER` | from the address | `gmail`, `icloud`, … for a custom domain hosted there (e.g. Workspace) |
| `CALDAV_URL`, `CALDAV_USER`, `CALDAV_PASSWORD`, `CALDAV_CALENDAR` | none | the calendar account; `CALDAV_CALENDAR` is where `add` writes |
| `CAL_ICS_URL`, `CAL_TZ`, `CALDAV_INSECURE=1` | none | a read-only feed; the person's time zone; self-signed |

A Google Workspace or iCloud custom-domain address (`ani@namaku.id`) is not recognised from the domain: store
`mail_provider gmail` (or `icloud`) as well, or the two host names.
