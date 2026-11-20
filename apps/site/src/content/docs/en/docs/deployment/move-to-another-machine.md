---
title: Move Nouride to another machine
description: Export everything a Nouride holds as one file, import it on a new machine, and go live there.
---

Since 0.8.41 a Nouride can be taken to another machine as one file: export on the old machine, install Nouride on
the new one, import the file there, then **Go live**. The import replaces what the new machine holds. Nothing is
merged.

## What the file holds

| In the file | Not in the file |
|---|---|
| The database: chats, missions, automations, accounts, usage, the audit log | A coding CLI's sign-ins: sign each one in again |
| The config and the people | A chat app's own session, such as a linked WhatsApp |
| The agents' packs and the skills | The snapshots (`backups/`) and logs kept as files |
| The memory and the documents | Installed tools and caches |
| Files sent in chats, and the work notes | The agents' own folders, unless you ask for them |
| The secrets, sealed to a passphrase you type | The old machine's own key and control token |
| | The credentials folder (`credentials_dir`): the key files and token files your agents read. Copy it yourself |

The file is a `.tar.gz` you can open with your own `tar`. Its first entry, `manifest.json`, says what the rest is.
Only the secrets are sealed. Everything else is readable by whoever holds the file, and it holds every chat and
memory: keep it as you would keep those.

With no passphrase the file holds no secrets, and the export says so before it makes the file. On the new machine
each secret is then entered again.

The agents' own folders (their private folders and the shared one) can be large, so they are in the file only when
asked for. Links, a coding CLI's folders, files whose name says they hold a sign-in or a key, and what tools
installed (`node_modules`, `.venv`) are left out of them.

## 1. Export on the old machine

From the dashboard, as an admin: **Settings**, then **Export and import**. The page says what the file will hold
and how large it is before you press **Make the file**. Type a password for the secrets twice, at least twelve
characters, or untick the secrets. Tick the agents' own folders if you want them. When the file is made, press
**Download**.

From a terminal, on the machine itself:

```bash
nouride export --out /var/tmp/nouride-export.tar.gz             # asks for the passphrase, twice
nouride export --out /var/tmp/nouride-export.tar.gz --folders   # with the agents' own folders
nouride export --out /var/tmp/nouride-export.tar.gz --no-secrets
```

A script gives the passphrase on stdin with `--stdin`. The command works whether Nouride is running or not, and
never writes over a file that is already there.

On a server install the command runs as Nouride's own account, whoever types it, root included. That account
cannot write in root's folders, so `--out ~/…` typed by root is refused: name a folder it can write in, such as
`/var/tmp`. The file is that account's alone; copy it off the machine as root.

Leave the old machine running for now: nothing has changed on it.

## 2. Install Nouride on the new machine

Install it as you would any new Nouride ([Server & systemd](/en/docs/deployment/production/) or
[Docker & Compose](/en/docs/deployment/docker/)), the same version as the old machine or a newer one. A file made
by a newer Nouride than the one importing it is refused with "Update Nouride first".

## 3. Import the file

From the dashboard of the new machine: sign in with the password the install printed, and on the setup's first
page choose **Bring its file in**. On an install that is already set up, the same card is on **Settings**,
**Export and import**. Pick the file. If it holds secrets the page asks for the password you typed when you made
it. It then shows what the file holds beside what this Nouride holds now. **Replace everything here** asks for the
word `replace` to be typed, and its button waits ten seconds more.

Nouride then restarts and the import goes in as it starts. Where nothing on the server starts Nouride again by
itself, the page says so: restart it yourself, and the import goes in then.

From a terminal, with Nouride stopped:

```bash
nouride stop
nouride import /var/tmp/nouride-export.tar.gz     # asks for the passphrase, then for the word "replace"
nouride start                              # or: systemctl start nouride
```

A script gives the passphrase on the first line of stdin and the word on the second, with `--stdin`.

On a server install, put the file where Nouride's own account can read it, such as `/var/tmp`, and readable by
it (`chown nouride /var/tmp/nouride-export.tar.gz`): the command runs as that account.

What the import refuses, before anything is replaced: a file that is not an export or was cut short, a damaged
database, a file from a newer Nouride, a passphrase that does not open the secrets, and the word not typed.

What the new machine held before is moved into a folder beside its data, `before-import-<date>`, and stays there.
If the import fails at any step, everything is moved back and the machine is as it was. Remove the folder yourself
once you are satisfied.

The new machine keeps its own places: where its folders are, and the address and port its dashboard listens on.
The secrets are stored under the new machine's own key.

## 4. Sign in again, and look at what came

Every session and every device's token ends with the import. Sign in with the accounts of the old machine.

**Settings**, **Export and import** now leads with how the import went: what came, what did not, and any place the
config names that is not on this machine (an agent's project folder, say). Sign each coding CLI in again from its
agent's page.

The credentials folder is never in the file, wherever your config keeps it, inside the agents' folder too: an
ssh key or a service account's file there would be readable by whoever held the file. Copy it to the same place
on the new machine yourself, over a channel you trust, and make it the service account's (`chown -R nouride`).

## 5. Switch the old machine off, then Go live

Until you press **Go live**, the new machine makes no connection to a chat app and runs no automation, by the
clock, by hand or by a webhook. A bot's token used from two machines at once has both asking for the same
messages, and an automation would run on both. Missions that were at work when the file was made are paused:
resume them from **Work**.

Stop Nouride on the old machine. Then press **Go live** on the new one. Its automations run from that moment, and
it restarts to bring its connections up. Where it cannot restart itself, restart it yourself.

## What has not been tried

The move has been run between installs on the same version. An older file brought into a newer Nouride is
migrated as an update would do it, by the same code, and has not been run on a real older install. An install
whose agents run as their own Linux users has not been moved: on the new machine, files in the agents' folders
arrive owned by Nouride's own user.
