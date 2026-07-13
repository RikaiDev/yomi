<!-- rikai-logo -->
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
    <img src=".github/assets/logo.svg" alt="yomi" width="96" height="96">
  </picture>
</p>

# Yomi (読み)

**Read your LINE from an AI agent — and reply, send images, and search across every conversation — without a browser and without LINE's own client.**

*The name reads more than one way. **読み** (yomi) — a reading: not just parsing
your messages, but reading the situation, the way you do. **詠み** (yomi) — to
recite: it doesn't read in silence, it reads things back to you. And **黄泉** (yomi)
— the realm of what's buried and out of reach; the very yomi in **黄泉帰り**
(yomigaeri), "the return from it," the root of the Japanese word for revival. Yomi
reaches into what is sealed or forgotten and brings it back to light.*

Yomi speaks LINE's TCompact-over-HTTPS protocol directly, decrypts Letter-Sealing
(E2EE) messages and media, and exposes the result to any AI agent through a small
stdio [MCP](https://modelcontextprotocol.io) server. Point Claude Desktop (or any
MCP client) at it and the agent can catch up on your LINE the way you do — read,
reply, send an image, mention someone, and search your whole history locally.

No official API, no bot account, no webhook. Yomi logs in as a secondary device
on your own account.

![license](https://img.shields.io/badge/license-MIT-blue) ![runtime](https://img.shields.io/badge/runtime-bun-black) ![protocol](https://img.shields.io/badge/MCP-stdio-green)

> **Unofficial.** Yomi is an independent personal project, not affiliated with or
> endorsed by LINE. Using it may be against LINE's Terms of Service, and running an
> additional client on your account carries a risk of rate-limiting or suspension.
> It is intended for reading *your own* account. Use it at your own risk. See
> [Disclaimer](#disclaimer).

---

## Quickstart

You need [**Node.js**](https://nodejs.org) (v24+, macOS, Linux, or Windows) and a LINE account.
Yomi runs straight from npm via `npx` — no clone, no build step.

**One-click install** (checks/installs Node.js if needed):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/RikaiDev/yomi/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/RikaiDev/yomi/main/install.ps1 | iex
```

**Claude Code** (one line, any OS):

```bash
claude mcp add yomi -- npx @rikaidev/yomi
```

**Claude Desktop** — edit the config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows), then fully quit and
reopen it. Use an **absolute** path to `npx` — Desktop launches servers without
your shell's PATH (find yours with `which npx` or `where npx`):

```json
{
  "mcpServers": {
    "yomi": {
      "command": "npx",
      "args": ["@rikaidev/yomi"]
    }
  }
}
```

Once connected, just say:

> *"Log into LINE — my number is +8869XXXXXXXX."*

Approve the device on your phone (see [Logging in](#logging-in)), and:

> *"Summarize my unread LINE and tell me who's waiting on a reply."*

---

## What you can do

Yomi exposes **19 tools** over MCP. All return JSON. "Honest error" below means an
explicit failure naming the problem (e.g. `missing_decrypt_material`) — Yomi never
fabricates a fallback, a placeholder, or a fake success.

### Reading

| Tool | Does |
| --- | --- |
| `get_unread_digest` | One-shot: every conversation with unread messages, each with its latest messages, E2EE-decrypted, sender names resolved. Built for "summarize my unread and suggest next steps." Read-only — never marks anything read. |
| `list_conversations` | Chats/groups/rooms with unread counts and a decrypted last-message preview. Newest-active first. |
| `get_chat_messages` | One conversation, decrypted. Paginate deeper with a `before` cursor. Each message carries any raw `MENTION` metadata so you can see who was @-mentioned (a literal `@name` in the text is *not* a mention). |
| `get_message_media` / `get_message_image` | Any decrypted attachment (image/video/audio/file). Honest error on non-media. |
| `find_contact` / `list_contacts` | Friend-list lookup by name substring, or the full list. Raw LINE data — no fuzzy scoring, no affinity ranking. |
| `get_group_members` | Members of a persistent group. Ad-hoc rooms without a group record fail honestly rather than returning a fake empty list. |

### Writing (these really send — not drafts)

| Tool | Does |
| --- | --- |
| `send_message` | Sends an E2EE text message now (pairwise key for 1:1, group key for groups/rooms). Optional `mentions` attach real @-mentions that LINE highlights and notifies; omit them and a literal `@name` is just text that notifies no one. One send per call, no retries. |
| `send_image` | Encrypts, uploads to LINE OBS, and sends an E2EE image now. Works for **1:1, groups, and rooms**. One send per call. Honest failure if the key can't be resolved or the upload is rejected. |
| `mark_read` | Sends a read receipt the other party can see. Explicit only — reading messages and background capture never mark anything read. |

### Search (local, cross-conversation — LINE has no such primitive)

| Tool | Does |
| --- | --- |
| `search_messages` | Hybrid search across all indexed conversations. Auto-collects on first use. Returns `mode` (`hybrid`/`semantic`/`keyword`) so nothing is hidden. |
| `collect_messages` | Explicit bulk-index into the local DB + embed for semantic search. The only tool allowed to bulk-fetch; runs once per call, never on a timer. |

### Scope & privacy (all work offline, no LINE session needed)

| Tool | Does |
| --- | --- |
| `exclude_chats` | Denylist a conversation **and purge** its already-indexed data. Not just future capture — a denylist that left old data in the index would be fake privacy. |
| `include_chats` | Re-allow a conversation (does not restore purged data). |
| `list_excluded_chats` / `get_scope_policy` | Show the denylist / the full privacy policy (read from [`PRIVACY.md`](PRIVACY.md)). |

### Session

| Tool | Does |
| --- | --- |
| `login` / `login_complete` | Passwordless secondary-device login. See below. `login` is the only tool callable without an existing session. |

---

## Logging in

**Prerequisite:** on your primary phone, enable **設定 › 我的帳號 › 允許自其他裝置登入**
(*Settings › Account › Allow login on other devices*). Without it LINE never offers
this device a sign-in prompt — this is the single most common reason a first login
appears to hang.

You only need to give the agent your phone number in E.164 form — it supplies the
region itself (e.g. `TW` for a `+886` number) when it calls the tool.

Yomi drives LINE's **passwordless (secondary-device)** flow. How the login surfaces
depends on your MCP client:

- **Clients with the MCP `elicitation` capability** — `login` prompts you for your
  phone/region, shows the PIN in a dialog, and blocks to completion. One call, no
  PIN relayed through the model. Your phone number never enters the transcript.

- **Clients without it (e.g. Claude Desktop today)** — two calls. `login` (with your
  phone + region) returns the PIN in its result; enter it in LINE on your primary
  phone and approve the device; then call `login_complete`, which blocks until the
  phone confirms. The agent should call `login_complete` immediately — it does the
  waiting, so there is nothing for you to report back.

- **From a terminal** — `npx @rikaidev/yomi login` runs the whole flow on stdout, PIN and
  all. Always available as a fallback.

**The one deadline that matters is LINE's:** you have about **3 minutes** from when
the PIN is shown to enter it and approve the device. Yomi's own client keeps
listening for many minutes beyond that, so a slow phone is never the failure — only
LINE's 3-minute code lifetime is.

Once you've logged in, the session — including a login *certificate* — is persisted
(see [below](#sessions-and-credentials)), and future logins **skip the PIN
entirely**.

> There is also an experimental [MCP Apps](https://modelcontextprotocol.io) UI (a
> `ui://yomi/login` card) for clients that render interactive views. It is
> spec-correct and renders under the MCP Inspector, but some hosts fetch the resource
> without completing the view handshake, so it is **display-only and never on the
> critical path** — the flows above always work regardless.

### Sessions and credentials

Yomi owns its own login. On startup it calls `resumeSession()` once, reading the
LINE session from the macOS Keychain (service `com.yomi.credentials`, account
`line`) and silently refreshing the token if needed.

- **First-party credentials.** The passwordless login persists the auth token,
  refresh token, certificate, MID, and the E2EE keypair itself — then reads them
  back to verify the write actually landed. A login that can't be persisted fails
  loudly at login, not silently at the next restart.
- **Backward compatibility.** If no session is found under `com.yomi.credentials`,
  Yomi reads the legacy `com.inboxd.credentials` entry once, migrates it forward,
  and never deletes it. An existing session keeps working with no re-login.
- **Platform note.** On macOS the session lives in the login Keychain. On **Linux
  and Windows** Yomi currently falls back to a local JSON file — functional, but
  less protected than an OS secret store, and less exercised than the macOS path.
  Native secure-storage backends (libsecret / DPAPI) are planned; until then, treat
  a non-macOS install accordingly.

Every tool except `login` and the offline scope/search tools returns an honest error
when there is no session. Yomi is otherwise a pure query server — it never polls,
never backfills in the background; each tool call makes exactly the LINE requests it
needs, and `collect_messages` is the only path that fetches across many chats at once.

---

## Search

LINE has no cross-conversation search; Yomi builds one locally. The index is a
gitignored SQLite database (`data/search-index.db`) in the repo — **nothing leaves
your machine**.

Search is **hybrid** by design. It always runs FTS5 keyword search (bm25 over
bigram-preprocessed text, so CJK substrings with no word boundaries are covered) and,
when embeddings exist, semantic search, then fuses the two ranked lists by
**Reciprocal Rank Fusion**. Pure semantic search silently drops exact matches that
live in un-embedded messages; pure keyword misses paraphrases; fusing both surfaces
an exact term and a meaning-match together. The response's `mode` field always
reports which methods contributed.

Semantic ranking uses **`Xenova/bge-small-zh-v1.5`** (BAAI general embedding, small,
Chinese-primary but multilingual) via **transformers.js**. Embedding **inference runs
fully in-process on CPU — your message text is never sent anywhere.**

The one caveat is a **one-time model download**: on the first `collect_messages` or
`search_messages`, transformers.js fetches the model (~90 MB) from **`huggingface.co`**
and caches it locally; every run afterwards is fully offline. That first fetch is an
outbound HTTPS request to HuggingFace for the model weights — it carries your IP and
which model is being downloaded, **but no message content and no LINE data**. If you
need Yomi fully air-gapped, pre-populate the transformers.js cache (or point it at a
local model directory) before the first search so no network call is ever made.

---

## The secondary-device reality (read before trusting "I can't get old messages")

Yomi runs as a **secondary device** on your account. That shapes what it can see:

- **Group chats *without* Letter Sealing are plaintext at the LINE server** — full
  history and media, no restriction.
- **Group chats *with* Letter Sealing are E2EE, and there the epoch matters.** Such a
  group is encrypted with a shared *group key* that rotates (on membership changes, or
  when a client provisions a new one). LINE only ever hands a device the **current**
  group key — there is no API to fetch a superseded one. So a secondary device decrypts
  messages from the epoch whose key it holds onward; messages sent under an **older
  epoch — before Yomi obtained the current key — can come back undecryptable**, even in
  a group whose earlier history it *can* read. This is inherent to Letter Sealing's
  per-epoch group keys, not a bug here. It can also cut sideways: the epoch your phone
  holds and the epoch Yomi holds need not be the same, so the **two devices can each
  read a different slice** of the very same group.
- **1:1 media** uses the account-level E2EE keychain, which a secondary device fully
  possesses (LINE syncs it during pairing) — Yomi **can** decrypt 1:1 images/files it
  can see.
- **1:1 history *backfill* is the one real limitation.** LINE does not hand a
  secondary device the *past* 1:1 message history the way it does for groups. Messages
  received while Yomi is connected decrypt normally; deep-scrolling into 1:1 history
  that predates pairing may come back empty. This is a LINE server-side restriction,
  not a bug here.

When decryption genuinely fails, Yomi returns an explicit `missing_decrypt_material`
error — never a fake card or placeholder. Silence is honest; a fabricated result is not.

---

## Development

For contributors working on the Yomi source code (requires [bun](https://bun.sh)):

```bash
bun install                 # install dependencies
bun run.mjs                 # run the stdio MCP server
bun run.mjs login           # run the login flow in a terminal
npm run build               # tsc --noEmit — type-check only (Yomi ships & runs from src/)
npm test                    # bun test
npm version patch           # bump + sync src/version.ts + tag (see RELEASING.md)
```

The build only type-checks and compiles; this repo does not talk to live LINE
servers as part of its own build. Connecting an MCP client and calling `login` is
what actually starts a session.

```
src/
  line/     LINE protocol core: TCompact/Thrift codec, E2EE (Letter-Sealing,
            group keys, media), Talk/Auth/Sync service clients, session state,
            passwordless login flow.
  auth/     Credential store (macOS Keychain, JSON-file fallback off-darwin).
  search/   Local cross-conversation index (SQLite + FTS5) and the offline
            embedding pipeline (transformers.js).
  mcp/      The stdio server: tool schemas, handlers, the privacy-policy loader,
            and the experimental MCP Apps login view (mcp/ui/).
  util/     [TAG]-prefixed logger (stderr only — stdout is the MCP JSON-RPC stream).
```

Everything Yomi writes for humans goes to **stderr**; **stdout is reserved for the
MCP JSON-RPC stream**. A stray `console.log` corrupts the protocol — don't add one on
any path the server can reach.

---

## Privacy

By default Yomi indexes **all** your conversations into the local, on-device search
index so an agent can search across them — a capture-all default, opt-out per chat.
Nothing is ever uploaded; the only data that leaves your device is whatever the agent
itself surfaces in its replies. (The one non-LINE network call Yomi itself makes is the
**one-time embedding-model download from HuggingFace** on the first search — model
weights in, no message content out; see [Search](#search).) [`PRIVACY.md`](PRIVACY.md)
is the canonical policy,
and Yomi surfaces that same text to the agent on connect (and via `get_scope_policy`)
so it can disclose the default before any bulk read.

---

## Disclaimer

Yomi is an independent, unofficial personal project, built for learning and for
accessing one's own LINE account. It is **not affiliated with, authorized, or
endorsed by LINE Corporation**. "LINE" is a trademark of its respective owner.

Running Yomi may violate LINE's Terms of Service, and operating an additional client
on an account can result in rate-limiting or suspension of that account. Yomi is
intended for accessing **your own** account and data. You are solely responsible for
how you use it. The software is provided "as is", without warranty of any kind — see
[`LICENSE`](LICENSE).

## Acknowledgments

Yomi's LINE protocol implementation was written with reference to two open-source
projects, whose field layouts, E2EE chunk ordering, and request shapes informed
this independent implementation:

- **[evex-dev/linejs](https://github.com/evex-dev/linejs)** (MIT) — request shapes
  and the Letter-Sealing E2EE payload layout.
- **[DeachSword/CHRLINE](https://github.com/DeachSword/CHRLINE)** (BSD-3-Clause) —
  protocol field layouts and the passwordless login flow.

Their copyright notices and full license texts are reproduced in [`NOTICE`](NOTICE),
as their licenses require.

## License

MIT

