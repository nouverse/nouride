# Setting up search by meaning

Memory and documents are always found by their words. Search by meaning adds finding them by what they
are about, and needs one thing Nouride does not ship: an **embedding model**, reached through a
provider that speaks the OpenAI API. A chat model is not one, and an Anthropic provider cannot be
used for it.

This is a conversation before it is a command. Where the model runs decides what it costs, what
leaves the machine, and whether anything is installed, and those are the person's to decide.

## 1. Look at what is there

`memory` prints the settings; its last line says whether search by meaning is on, and with which
provider and model. `provider list` prints the providers. If one of them already serves embeddings
(an Ollama, an OpenAI or Gemini key, a gateway that says it embeds), the person may only need the
switch: go to step 4 with it.

If it is off and the line names the model it was set to, it has been on here before. `memory set
semantic on` switches back to that same model, and what it had embedded is still there: offer that
first. A model's name spelled another way (`bge-m3` where it was `bge-m3:latest`) is another model
to the daemon, and its vectors start from none.

## 2. Ask where the model should run

Three places. Say them in plain words, with what each means, and let the person choose:

- **On this machine.** Free, and nothing leaves it. It needs a program that serves the model
  (Ollama is the usual one), the model downloaded, and memory and disk to spare: look at what the
  machine has before you suggest it, and say what you found. On a small box, or beside agents that
  already use most of its memory, say so and suggest one of the other two.
- **On another machine of theirs.** The same program on a server or a desktop that has the room,
  and this Nouride reaches it over their network. They install it there, or you do if you can reach
  that machine; you need its address.
- **A cloud service.** Nothing to install: an API key from OpenAI or Google. The text of what is
  remembered is sent to that service to be embedded, which is the thing to say out loud, and it
  costs a little per use. Say that the price is the service's and look it up if they ask; do not
  quote one from memory.

Known to work, with the model's name each one takes:

| Where | Base URL | Model |
|---|---|---|
| Ollama | `http://<its address>:11434/v1` | `bge-m3` |
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-embedding-001` |

Another embedding model that the provider serves works too. The table is what was tried, not a
limit.

## 3. Get the model served

- **Ollama on this machine.** Installing it is a change to the machine, and on a server it is
  installed as a service, which needs root. Say what you will install and wait for a yes; the
  approval prompt alone does not say that. Then:
  - `["pkg", "check", "install", "ollama"]` says whether this machine's own package repositories
    have it. Where they do, `["pkg", "install", "ollama"]` installs it, a person approving it.
  - Where they do not, it comes from Ollama's own installer, the one line on ollama.com/download.
    Do not pipe a script from the internet into a shell yourself: give the person that line, say
    that whoever runs this machine runs it, and go on when they tell you it is done.

  Then download the model with Ollama's own `pull` (`ollama pull bge-m3`, about 1.2 GB when this
  was written: its page on ollama.com says), and see that it answers on port 11434 before you add
  it.
  **In a container**, do not install it inside: what is installed there is gone when the image is
  updated. Ollama runs beside Nouride, in its own container or on the host, and Nouride is given
  its address.
- **Ollama on another machine:** it has to listen on an address this machine can reach, not only on
  its own loopback. If you cannot reach that machine, tell the person the two things to do there
  (install Ollama, download the model) and ask for the address.
- **A cloud service:** ask the person for the key in the chat and store it yourself, through
  `stdin`, never in `args`.

Then add it as a provider of the OpenAI kind, with the base URL from the table. `provider --help`
has the exact flags. Ollama does not check its key: any word will do.

## 4. Switch it on

`memory set semantic <provider>/<model>`, with the provider's name and the model's.

The daemon asks that model for one embedding before it switches anything on, and it can take a
minute the first time a local model loads. If it stays off, the answer says why: the provider's
name is wrong, the model is not downloaded, the model is a chat model, the address does not answer.
Fix that one thing and run it again. Do not report it as on until the command says it saved.

`memory set semantic off` switches it off again. Search by words is untouched either way.

## 5. Give what is already remembered its vectors

What was remembered before gets its vectors in catch-up runs of at most 2,000 items, one each
night. `memory embed` runs one now, in the background, so the person does not wait a night; a large
memory takes several. `memory` says how many items have a vector, and so does the dashboard's
Memory settings. Until an item has one it is still found by its words.

## 6. Say what you did

Where the model runs, the provider's name and the model, that the daemon checked it, and how far
the embedding of what was already there has got. If it runs in the cloud, say again that what is
remembered is sent there to be embedded.

## What goes wrong

- **Changing the model later** starts the vectors again from none: the old ones are of another
  model and cannot be compared with the new. Searches go on with the old ones until the new model
  has as many, so nothing is lost meanwhile, but it is not a setting to change for no reason.
- **`semantic_dimensions`** is for models that can make shorter vectors. Leave it alone unless the
  person asks; a model that cannot shorten its vectors keeps its own size.
- **The daemon names the model with a size after it**, as in `ollama/bge-m3@512`: the size it asks
  for. A model that cannot shorten its vectors answers at its own size and they are kept at that.
  Nothing is wrong, and there is nothing to change.
- **The model stops answering** (the other machine is off, the key ran out): search falls back to
  words, and nothing errors. `memory` says that the model is not responding.
