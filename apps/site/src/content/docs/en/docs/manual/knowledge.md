---
title: Knowledge base
description: "Documents you keep for your agents to look things up in: collections, who may be answered from them, and how agents find and cite them."
---

Memory learns from your conversations. The knowledge base is for what nobody says in a chat: a manual, an SOP, a price
list, a policy, a lab result. You keep the documents; your agents search them when a question is about what they cover,
and say which document and which part of it an answer came from.

## Collections

Documents are kept in **collections**, a folder each. Make one on the dashboard under **Knowledge & Memory →
Knowledge → New collection**, or ask an agent to keep something in a collection that does not exist yet. A collection
has:

- **A name**, and **a line saying what it holds**. Agents are shown both, so they know when to look in it.
- **Who may be answered from it** (below).
- **Which agents search it**: every agent, unless you choose some.
- **Whom it is about**, if it is about people: a person's documents are listed with what is known about them, under
  **Knowledge & Memory → People**, and found first when the conversation is about them. This says nothing about who may
  read it.

## Who may be answered from a collection

A collection is closed until you open it. Who may be answered from one depends on where it was made:

| Made | Who may be answered from it |
|---|---|
| On the dashboard | The person who made it |
| From a chat | The people in that chat, or that group |
| As a folder by hand, with no settings | The admins |

An admin can open a collection to everyone, or to one group, from its card. An agent never can.

A collection is used only when every person in the conversation may be answered from it. So a collection kept for one
person is never used in a group, even a group that person is in, and the family group's collection is not used in a
one-to-one chat.

## Adding documents

- **On the dashboard:** drop files on a collection, or **Write a document** there.
- **From a chat:** send the file, or the link, and say to keep it: "keep this SOP in Finance". It is saved at once into
  a collection for the people in that chat. Into a collection open to more people than the chat, it waits for an
  admin's yes on the Knowledge tab, and the agent tells you so.
- **From the command line:** `nouride knowledge add <file> --to <collection>`.
- **By hand:** a collection is a folder under `.nouride/knowledge/` (on Docker, in the volume). Files put there, by you
  or by a tool such as Syncthing, are read within five minutes.

Nouride reads Markdown, text, CSV, web pages, PDF, Word, Excel, PowerPoint and their OpenDocument forms, up to 50 MB a
file. PDF and Office files are read with Python, which the Docker image does not have; PDF also needs `pdftotext` (or
Python's pypdf), and old `.doc`, `.xls` and `.ppt` files need LibreOffice. When one is missing, the document says so and
the page offers to have it installed; once it is, the document is read within five minutes. Pictures and videos are kept
and listed, not searched, and so is a scanned PDF, which has no text in it to read.

On the dashboard a collection's documents are listed newest first, each saying when it was added.

### A document's title

Each document has a title, shown over its file's name: what search finds it by, in any language. An agent that keeps a
document gives it an English one that says what it is, with the document's own terms ("NIB, business registration
certificate (Nomor Induk Berusaha)"), so an English search finds a document written in Indonesian even where search by
meaning is not set up. The file keeps the name it came with.

You can give a document a title yourself with the pencil on its row, in any language; written in English, your agents find
it whatever language they search in. Without one, a document's title is its first heading or its file's name.

## How agents use it

- An agent is told the names of the collections it may search in that chat, and whom each is about, never what is in
  them, so a collection costs a line in its prompt, not its documents.
- `memory_search` finds parts of documents beside past conversations and facts, and `memory_read` opens one, or a whole
  document. An answer from a document names the document and the part.
- Documents are found by their words always, and by meaning when search by meaning is set up: the same model memory
  uses, set once under Knowledge & Memory.
- A document keeps the language it was written in, and its English title finds it in English.

## Memory or the knowledge base

| What | Where it goes |
|---|---|
| Something a person says about themselves or their life: work, plans, an allergy | Memory, learned each night |
| A document, a file or a link someone hands over to keep | The knowledge base |
| How an agent works, what it is in the middle of | That agent's own notes |

When it is not clear that something is meant to be kept as a document, the agent asks once.

## Archive, backups, the command line

**Archive** keeps a collection without searching it, until you bring it back. The knowledge folder is backed up on the
same schedule as memory.

```bash
nouride knowledge                                  # the collections, and who may be answered from each
nouride knowledge search <words> [--in <collection>]
nouride knowledge add <file> --to <collection>
nouride knowledge add - --name <file name> --to <collection> < <file>   # the file on standard input
nouride knowledge reindex [collection]             # read again what changed in the folder
nouride knowledge archive|unarchive <collection>
nouride knowledge title <collection>/<file> <words>   # its title; "" takes it off
nouride knowledge rm <collection>/<file>
```

A collection is named by its name, as the dashboard shows it (`--to "Lab results"`), or by the id the list prints
beside it.

On a server, `nouride` run as root runs as the service's own account, which cannot read a file in root's home. Hand
the file over on standard input instead: `sudo nouride knowledge add - --name manual.pdf --to House < manual.pdf`.
