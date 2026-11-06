---
name: share-preview
description: Give the person a public link to something running on this machine (a web app you are building, a dev server, a static site) through a Cloudflare quick tunnel (trycloudflare.com), with no account and no port opened. Use when you built or changed something with a web interface and the person should see it, or when asked for a preview link, a demo URL or to "show me".
needs_tools: exec, read
author: Nouride
---

# Sharing a preview link

A quick tunnel gives a local port a public `https://<words>.trycloudflare.com` address for as long as
it runs. No account, no DNS, no router change. **Anyone with the link can open it**. That is the
point, and the one thing to say when you send it.

Everything below happens in one turn: the app and the tunnel are started with `service: true`, which
keeps them running as jobs and lets your turn go on, so the person gets the link in the same reply.
**And you look at the page before you send it**: a server that answers is not a page that works.

## This machine

The tunnel is one small program and runs on a 512 MB board; the app it shows needs whatever it needs. The look in
step 3 is a browser (about 220 MB for a page, measured on a Linux box), which a board that small cannot run:
`browser-automation`'s step 1 decides, and step 3 says what to tell the person when it says no.

## Only ever tunnel what the person should see

Tunnel the port of the thing you were asked to show, nothing else. Never this daemon's own ports,
the dashboard (`18254`) and the model gateway (`18256`), nor a database, an admin panel or anything
that answers without a login it should have. If you are not sure what a port serves, `curl` it first.

## 1. Have `cloudflared`

```sh
command -v cloudflared
```

If it is missing, install it the way your instructions say to install software, into the bin
directory they name, which is on `$PATH` and survives restarts. From inside that directory, so the
`chmod` is on a relative name:

```sh
a=$(uname -m); case "$a" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; armv7l) a=arm;; esac
cd <bin directory> && curl -fsSL --max-time 120 -o cloudflared \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$a" \
  && chmod +x cloudflared && ./cloudflared --version
```

On macOS use `brew install cloudflared` if Homebrew is there.

## 2. The app, as a service

If it is not already running, start it with `service: true`, bound to `127.0.0.1` where it lets you
choose (the tunnel is the only way in):

- a static site: `python3 -m http.server 8787 --bind 127.0.0.1`, with `cwd` set to the site's folder
- a project's own server: `npm run dev -- --port 8787 --host 127.0.0.1`, and so on

Then check it answers (a link to a server that is not up is a Cloudflare error page):

```sh
for i in $(seq 1 20); do curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:8787/ 2>/dev/null && echo up && break; sleep 1; done
```

## 3. Look at it, as the person will

A blank page, a stack trace, an error overlay or a layout that breaks at a phone's width all answer
`curl` with 200. **Load the `browser-automation` skill**, set it up if this machine has not yet (its
steps 1 and 2), and from its folder open the page at a laptop's width and at a phone's:

```sh
npx playwright-cli open http://127.0.0.1:8787/
npx playwright-cli screenshot --filename="$TMPDIR/preview-wide.png"
npx playwright-cli close
npx playwright-cli open --mobile http://127.0.0.1:8787/
npx playwright-cli screenshot --filename="$TMPDIR/preview-phone.png"
npx playwright-cli console error
npx playwright-cli close
```

`read` both pictures, and the errors. What you were asked to show should be on them, readable, at
both widths. Something wrong is fixed before the link goes, or said in the message with it, never
found by the person first. Where browser-automation's step 1 says this machine cannot run a browser,
say in the message that you have not seen the page, only that it answers.

## 4. The tunnel, as a service, and its link

Start the tunnel with `service: true`:

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787
```

The result names its live log. The link
appears there a few seconds later:

```sh
for i in $(seq 1 30); do u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' <live log> | head -1); [ -n "$u" ] && echo "$u" && break; sleep 1; done
```

Then check the link itself answers. A new address takes a few seconds to resolve, and until it does
the person gets an error page:

```sh
for i in $(seq 1 30); do curl -fsS -o /dev/null --max-time 5 "$u" 2>/dev/null && echo live && break; sleep 2; done
```

## 5. Send it

Send the link with one line saying it is public and temporary, a word about what to look at, and that
you can take it down. Say what you saw at both widths in a few words, and anything still wrong.

## 6. Close it

When the person is done, or you stop working on it, stop both jobs (the tunnel and the app) with
the `nouride` tool: `["jobs", "kill", "<id>"]` for each, and `["jobs"]` lists them. They are in the
dashboard too, so the person can stop them there.

A quick tunnel also ends when this daemon restarts; start a new one then, and the address will be
different. It is for previews, not for hosting: a lasting address needs a named Cloudflare tunnel on
the person's own account.
