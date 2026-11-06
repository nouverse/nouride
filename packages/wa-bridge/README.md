# wa-bridge

The WhatsApp connection, as its own module.

A member of the root workspace since 2026-09-30 — see Install below. The engine imports it by name,
`nouride-wa-bridge`, which no package lists as a dependency, so `bun install` does not link it: a
build links it into `node_modules` for its own run and removes the link after. The protocol is
newline-delimited JSON, declared twice by hand: `src/protocol.ts` here,
`packages/shared/src/types/bridge.ts` there. The duplication is the point; the `hello` handshake
carries a version so a drift is a rejected connection rather than a mystery at runtime.

Every Nouride edition compiles this into the daemon and runs it in the daemon's own process. There is no
second executable, nothing to spawn and nothing to connect to: one WhatsApp number per daemon. `stdio`
spawned an executable the tarball used to ship beside the daemon, and went on 2026-09-16 — since 0.8.0 a
config still naming it, or its `bridge_command`, is refused at load. `ws` dialled a bridge running somewhere else,
which nothing here ever served (the standalone build spoke stdin and stdout only); it went in 0.7.10,
with that build, and a config naming it is refused at load.

## `libsignal` is detached from Baileys

The reason this matters: a binary that links GPL-3.0 code is a combined work, and Nouride ships
closed-source binaries.

`@whiskeysockets/baileys` is **MIT**. It depended on
[`libsignal`](https://www.npmjs.com/package/libsignal), which is **GPL-3.0**, and that was the only
copyleft code in the tree. `shims/libsignal/` replaces it, and `overrides` in the **root**
`package.json` is what makes the replacement reach Baileys' own copy — in a workspace, overrides only
apply at the root:

```json
"overrides": { "libsignal": "file:./packages/wa-bridge/shims/libsignal" }
```

`apps/engine/tests/contracts/wa-bridge-licence.test.ts` fails if the real package ever reaches
`bun.lock`.

A plain dependency alias does **not** work — Baileys depends on `libsignal` itself, so bun installs a
second copy under `@whiskeysockets/baileys/node_modules` and a root alias never reaches it. That was
the first attempt, and the end-to-end test passed against the real package the whole time.

The shim forwards to [`whatsapp-rust-bridge`](https://www.npmjs.com/package/whatsapp-rust-bridge) —
MIT, published by the Baileys organisation, already a dependency of Baileys and already used by its
utility layer. Baileys itself is unmodified: it imports the package in four places, three of them
deep imports, and all four resolve here.

| file | what it does |
|---|---|
| `shims/libsignal/index.js` | the four Signal classes, plus the adapter below |
| `shims/libsignal/src/curve.js` | four curve primitives, forwarded unchanged |
| `shims/libsignal/src/crypto.js` | AES-256-CBC, HMAC-SHA256, SHA-512, three-chunk HKDF, against `node:crypto` — the bridge does not export these |
| `shims/libsignal/src/protobufs.js` | the one optional field Baileys decodes, by hand |

**The adapter is the interesting part.** Two storage contracts disagree, and both were found by a
live box rather than by reading:

- `loadSession` — Baileys answers with a record; the bridge asks for bytes.
- `loadSignedPreKey` — Baileys answers with a bare `{privKey, pubKey}`; the bridge wants
  `{keyId, keyPair, signature}` and refuses without it. The signature is **recomputed** the way
  Baileys made it, `sign(identityPrivate, prefixed(preKeyPublic))` — not invented.

And one error is translated: the bridge says `SessionNotFound(...)` where Baileys matches the literal
text `'No session record'` to decide a decrypt failure is recoverable. Without the translation it
never sends a retry receipt, the phone never re-sends as `pkmsg`, and every inbound message fails
identically with nothing in the log saying why.

**Editing the shim needs `bun install`.** `file:` *copies* the directory rather than linking it, so a
stale copy will be bundled while the source looks right. `tests/libsignal-shim.test.ts` imports it by
**package name** for exactly this reason — a stale copy is a red suite instead of a silent wrong
binary.

A stored session that is not the bytes this backend wrote — one the JS `libsignal` wrote before this
change, or a damaged file — cannot be read, and `src/auth.ts` reads it as absent rather than empty;
nothing converts it. The ratchet re-negotiates on the next message and writes over the file; pairing is
untouched, because `creds` is a separate file.

### This is a stopgap — upstream is doing it properly

[**WhiskeySockets/Baileys#2067 — `feat: libsignal wasm`**](https://github.com/WhiskeySockets/Baileys/pull/2067)

| | |
|---|---|
| state | **open**, not a draft |
| opened | 2025-11-16 |
| last touched | 2026-08-06 |
| size | +6,903 / −3,505 across 75 commits |
| ships in | nothing yet — `7.0.0-rc14`, the newest release, still depends on `libsignal ^6.0.0` |

It replaces the JS `libsignal` with the same Rust core this shim forwards to, and it is the better
answer in three ways that matter here.

**It keeps the on-disk format.** In their words: *"Sessions and group sender keys are written in the
shape a pre-WASM release reads, not as the bridge's bytes. Rolling back is swapping the package: no
conversion step, no migration."* Nothing re-negotiates, which is the one cost this shim does not
avoid. It buys that for about 0.3 ms per message — a trade worth taking, and one that needed access
to the record model rather than a package name.

**It fixes a real bug.** Session operations become pure functions over a snapshot, so nothing calls
back into JS mid-operation and an operation cannot re-enter the caller's transaction. That
re-entrancy is what produced `message with old counter` failures under load. Identity rows are also
locked alongside the session, which had let an encrypt and a decrypt run concurrently on one session.

**It is several times faster.** Their benchmark, direct messages at 300/s: p50 2.62 ms → **0.59 ms**,
peak RSS 293 MB → **200 MB**. Group receive is where their counter fix lands hardest — a stored row
going from 199,724 bytes to 441.

None of that was available, so this shim exists. When #2067 lands in a release:

1. Drop `overrides.libsignal` and `dependencies.libsignal` from `package.json`.
2. Delete `shims/libsignal/` and `tests/libsignal-shim.test.ts`.
3. Drop `readableSession` from `src/auth.ts` in the same change — it reads every stored session that
   is not bytes as absent, and their sessions are written in the JS `libsignal`'s shape, so leaving it
   would re-negotiate every session on every message. Their reader accepts both shapes, so the bytes
   this shim wrote should still be readable, but that rests on a caveat in their implementation
   rather than a guarantee. Worth confirming on a live box.
4. Re-check the dependency tree for GPL-3.0 code, because the whole point of the shim is that it was
   there once.

## Install

A workspace member since 2026-09-30 (it was `nouverse/nouride-internal-wa-bridge`, a submodule, before):
the root `bun install` installs it with everything else, and it reaches the host through
`@nouride/runtime` like every other package.

```sh
bun install                         # at the repository root
bun test packages/wa-bridge         # session round-trip, at-rest encryption, and the libsignal shim
```

## Build and run

Nothing to build or run on its own: `bun run build:binary` (and `build:pro`) compile it into the
daemon, which hosts it and speaks the protocol. Baileys' optional peers — `sharp` above all — are
left out of every build on purpose; `scripts/bridge-externals.ts` says why compiling them in would
break, and the build fails an artefact that carries sharp's loader.

To watch a pairing code, add the connection in the dashboard (Gateways) or `[gateways.whatsapp.<name>]`
in `config.toml`; the QR is served through the control API. Two variables still reach the bridge from
the daemon's environment:

| Variable | Meaning |
|---|---|
| `NOURIDE_WA_LOG_LEVEL` | Baileys' own logging, on stderr. `warn` by default. |
| `NOURIDE_WA_SEND_TIMEOUT_MS` | How long a send may take before it is given up. 60 s by default. |

## Two things that are easy to get wrong

**stdout is the protocol.** Baileys' pino logger writes there by default, and its handshake dump
lands in the middle of the JSON stream. `makeLogger` redirects it to stderr; anything this process
prints for humans goes through `note()`. Still true in-process: stdout there belongs to whatever
launched the daemon, which is a worse place to corrupt.

**The session is a login.** Copying `sessionDir` to another machine signs that machine in as this
WhatsApp account. `src/auth.ts` therefore implements Baileys' `AuthenticationState` over AES-256-GCM
files instead of `useMultiFileAuthState`, which stores plain JSON. Lose the key and you scan again;
leak the key *and* the directory and you have leaked the account.

## Runtime

Baileys leans on Node's crypto and stream APIs, and Bun logs warnings about unimplemented `ws`
events. Bun works; it is the only runtime the bridge runs under now that it lives in the daemon.

## License

MIT — see [LICENSE](./LICENSE).

MIT rather than the PolyForm Noncommercial licence the engine carries, because this module is useful on its own
and shares no code with it: the entire coupling is the wire protocol. The dependencies are MIT too,
and `shims/libsignal/` exists so that stays true — the npm package `libsignal` is GPL-3.0 and is not
installed. Nothing here is derived from it; correctness is pinned by known-answer vectors rather than
by shared code.
