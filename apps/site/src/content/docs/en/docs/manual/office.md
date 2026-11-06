---
title: Office
description: Your agents' statuses as a small office of cats (who is working, who waits for you, who is idle or asleep), and a look of its own for each.
---

**Monitor → Office** shows what your agents are doing as a small pixel-art office: a workroom, the lobby and a
bedroom, side by side over a hall. Each agent is a Nouride cat with its own desk, its own seat on a sofa and its own
bed (the orchestrator's desk alone at the front of the workroom, a crown by its name).
The Overview shows the same office, small and still, with a line of who is doing what.

![The Office: Nouva, the orchestrator, and Ember at work (Ember under a red ! because it cannot work), Wren waiting for you, Kira and Pip on the sofa, Moss asleep, and Codey in bed because it cannot work](/media/dashboard-office.png)

## Where a cat is

Each cat is where its agent's status puts it. When more than one is true, the first in this table wins.

| Status | Where | Over it | When |
|---|---|---|---|
| Waiting for you | At its desk, a hand up | `?` | An approval, or a question from its turn, waits on a person; or one of its missions needs you: a question to answer, stuck, at a limit, or its result to accept. |
| Working | At its desk, behind its laptop | `…` | It has something running: a turn in a chat, a background job, a command its coding CLI (Claude Code, Codex) left running in the background, or a mission at work, between that mission's turns too, and while it tries its model again by itself. |
| Asleep | In its bed | `z` | You put it to sleep, or it cannot work (below), with nothing running. |
| Idle | On its seat, in the lobby | nothing | Awake, nothing running. |

**An agent that cannot work** sleeps until it can: a pack that does not load or is switched off, a model with no
credential, a coding CLI that is not installed or not signed in. Its label and its card say why, as in "Codey, asleep,
cannot work: Codex is not signed in". If it is still working or waiting for you when it stops being able to work (a key
removed mid-task, a CLI signed out), it stays at its desk with a red **`!`** over it, and goes to bed once that is over.

When a status changes, the cat walks to its new place through the
doors and along the hall, its name with it. On a phone the rooms stand one above another, the hall down their left.
The windows show the sky as it is where you are, day or night.

An office holds twelve agents: the orchestrator always, then the ones made first. With more, the rest are in another
office (a door at the end of the hall says how many), and the line over the office counts them all, and says how
many of those elsewhere are waiting for you.

Click a cat to see what its agent is doing and where, with a link to each chat and mission, and to put it to sleep or
wake it, open the chat, or change its look.

The page asks for the agents' statuses every five seconds while it is open and in view, and nothing while it is not.
It moves nothing if your system asks for reduced motion, and on a phone it shrinks to fit.

## A look for each agent

An agent's page has a **Look** tab with its cat drawn as it will be. Pick any part; a part you leave is the one its id
gives, so an agent nobody styled keeps the look it always had, and no two agents in one office are twins.

| Part | Key | Words |
|---|---|---|
| Fur | `fur` | ginger, grey, black, white, brown, cream |
| Pattern | `pattern` | plain, tabby |
| Outfit | `outfit` | none, hoodie, tee, jacket |
| Outfit colour | `outfit_color` | blue, lime, peach, charcoal, sage, lilac, white. A hat and a scarf wear it too; white only when picked |
| Hat | `hat` | none, beanie, cap, beret, headband, headphones |
| Accessory | `accessory` | none, glasses, sunglasses, scarf |
| Eyes | `eyes` | round, sleepy, sparkly |

The look is kept under `[look]` in the agent's `config.toml`, so it travels with the pack:

```toml
[look]
fur = "black"
outfit = "hoodie"
outfit_color = "lime"
hat = "beanie"
```

A word that is not one of its part's stops that agent from loading, and the error names the words the part takes; the
other agents load. Rolled back to 0.8.0, which has no Office, an agent's `[look]` is ignored with a warning about an
unknown key, and read again once 0.8.1 is back.
