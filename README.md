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

![license](https://img.shields.io/badge/license-MIT-blue) ![runtime](https://img.shields.io/badge/runtime-node%20%7C%20bun-black) ![protocol](https://img.shields.io/badge/MCP-stdio-green) ![npm](https://img.shields.io/badge/npm-@rikaidev%2Fyomi-red)

> **Unofficial.** Yomi is an independent personal project, not affiliated with or
> endorsed by LINE. Using it may be against LINE's Terms of Service, and running an
> additional client on your account carries a risk of rate-limiting or suspension.
> It is intended for reading *your own* account. Use it at your own risk. See
> [Disclaimer](#disclaimer).

---

## Getting started

You need [Node.js](https://nodejs.org) and a LINE account. Yomi runs locally
through `npx`; you do not need to clone this repository, install Bun, or build
anything. Run `node --version` first, and install the current LTS if the command
is missing or the version is unsupported.

Yomi's local search index uses Node's built-in `node:sqlite`, so it needs
**v22.13 or newer — except v23.0–v23.3**, which are newer than v22.13 yet still
lack that module ([it was unflagged in both 22.13.0 and
23.4.0](https://github.com/nodejs/node/pull/55890)). Any current LTS is fine.
This is `engines.node` in `package.json`; the rest of Yomi runs on older Node,
but search, scope and capture do not.

> **⚠️ Yomi needs a client that runs it on your own machine.**
> Cloud-only tools (ChatGPT, Claude.ai web) cannot run Yomi. Configure Yomi in
> Claude Desktop or Claude Code and it works in both chat and Cowork, because
> Desktop starts Yomi on your machine and Cowork's local sessions load it. Do not
> ask Cowork to *install* Yomi for you: Cowork's shell runs inside a throwaway VM,
> not on your machine, so anything it installs there is gone when the session ends.
> Follow the steps below yourself, in your own terminal.

Choose the client you actually use and follow only that section. Claude Code and
Claude Desktop have separate MCP settings; configuring one does not configure the
other.

<details open>
<summary><strong>Claude Desktop — one-click install (no terminal, no Node)</strong></summary>

The easiest path, and the only one that needs no command line at all. Claude
Desktop ships its own Node runtime, so nothing else has to be installed.

1. Download the bundle for your machine from the
   [latest release](https://github.com/RikaiDev/yomi/releases/latest):

   | Machine | File |
   | --- | --- |
   | Windows (Intel/AMD) | `yomi-win32-x64.mcpb` |
   | Mac (Apple Silicon) | `yomi-darwin-arm64.mcpb` |
   | Linux (x64) | `yomi-linux-x64.mcpb` |

2. In Claude Desktop, open **Settings → Extensions**, and drag the downloaded
   file onto that page (or just double-click the file).

3. Review what it asks for, click **Install**.

4. Start a conversation and say *"log in to LINE"*. Yomi shows a form, you enter
   your phone number, and you confirm on your phone. No terminal at any point.

This skips the config file entirely, which also sidesteps the Windows MSIX bug
described below.

> **Note for Cowork users:** do not ask Cowork to install Yomi for you. Cowork's
> shell runs inside a throwaway VM — not on your machine — and it will not type
> into your real terminal. Install the bundle yourself with the three clicks
> above; once installed, Cowork's local sessions can use Yomi like any other tool.

</details>

<details>
<summary><strong>Claude Desktop — manual config (npx)</strong></summary>

1. Find the full path to `npx`:

   ```text
   macOS / Linux: which npx
   Windows:       where npx
   ```

2. Open the Claude Desktop config file:

   ```text
   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
   Windows: %APPDATA%\Claude\claude_desktop_config.json
   ```

   > **⚠️ Windows: the documented path may not be the one Claude actually reads.**
   > Claude Desktop ships as an MSIX package, whose filesystem is virtualized. The
   > app reads its config from
   >
   > ```text
   > %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
   > ```
   >
   > while **Settings → Developer → Edit Config** opens the *un*virtualized
   > `%APPDATA%\Claude\` file. They are two different files that never sync, so a
   > correct Yomi config written to the documented path is **silently ignored** — no
   > error, no log, Yomi simply never appears. This is
   > [claude-code#26073](https://github.com/anthropics/claude-code/issues/26073),
   > still open. If Yomi does not show up after a restart, write the same config to
   > the `LocalCache` path above as well. (Not applicable to Claude Code, or to
   > Desktop installed outside MSIX.)

3. Add Yomi under `mcpServers`, replacing the example `command` with the full
   path printed in step 1. On Windows, JSON requires each `\` in the path to be
   written as `\\`:

```json
{
  "mcpServers": {
    "yomi": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["@rikaidev/yomi"]
    }
  }
}
```

   For example, a Windows path may look like
   `"C:\\Program Files\\nodejs\\npx.cmd"`. Use the path reported on your own
   machine rather than copying either example blindly.

   > **⚠️ The `npx` you name here does not decide which Node runs Yomi.**
   > On macOS and Linux `npx` is a script beginning with `#!/usr/bin/env node`,
   > so it runs whichever `node` comes first on **Claude Desktop's** `PATH` —
   > not the Node installed beside the `npx` you just pointed at. Desktop
   > inherits its `PATH` from the desktop session, which is often not your
   > terminal's, and version managers (nvm, fnm, asdf, volta, …) put their own
   > `node` ahead of everything else. So `which npx` can report a perfectly
   > modern install while Yomi still starts on an old Node.
   >
   > The symptom is specific: logging in, reading and sending all work, but
   > search, scope and capture fail, and the log says
   > `No such built-in module: node:sqlite`. Yomi prints the runtime it actually
   > got in that error — read it rather than assuming.
   >
   > The fix is to give the server a `PATH` whose first entry holds a supported
   > `node`:
   >
   > ```json
   > "yomi": {
   >   "command": "<the npx path from step 1>",
   >   "args": ["-y", "@rikaidev/yomi"],
   >   "env": { "PATH": "<dir holding a supported node><sep><a base PATH>" }
   > }
   > ```
   >
   > Separator: `:` on macOS/Linux, `;` on Windows. Keep a usable base after it
   > (`/usr/local/bin:/usr/bin:/bin` or your platform's equivalent) — this
   > replaces the server's `PATH` rather than prepending to it, and `npx` needs
   > the ordinary tools.
   >
   > Naming an absolute `node` in `command` does **not** work, however plausible
   > it looks: `npx` spawns the package's own bin as a child process and resolves
   > `node` from `PATH` again for it, so `command` only picks who runs `npx`, not
   > who runs Yomi. Setting `PATH` is what actually reaches the server.

**Configuring this with an AI agent?** MCP configs are mostly written by agents
now rather than by hand, so the steps above are stated for a human reading their
own machine. An agent should resolve the values instead of emitting placeholders,
and this setup has one trap worth stating outright: naming `npx` in `command`
does **not** pin the runtime. Procedure:

1. Find a Node that actually has the module Yomi's index needs — do not infer it
   from a version number:

   ```bash
   node -e 'require("node:sqlite")' && command -v node    # POSIX
   node -e "require('node:sqlite')" && where node         # Windows
   ```

   If it throws, that Node is unusable for search/scope/capture. Try the other
   installs (`which -a node`, `nvm ls`, `fnm list`, …) until one passes; only
   then continue.

2. Write that Node's **directory** into `env.PATH`, per the JSON above, and keep
   a base `PATH` after it. Resolve the directory on the target machine
   (`dirname` of the path from step 1); do not copy an example out of this
   README — they are Apple Silicon Homebrew paths and wrong nearly everywhere.

   Do not instead put an absolute `node` in `command`. It reads like the
   stronger fix and is not one: `npx` spawns the package's bin as a child and
   re-resolves `node` from `PATH` for it, so `command` only decides who runs
   `npx`. This was measured, not assumed — with a Node 20 first on `PATH`,
   `command`-pinning still gave the server Node 20.

   `command -v` may also hand back a wrapper rather than a real binary — heap
   shims, local-first `npx` wrappers and version-manager stubs are all common,
   and some behave differently depending on the client's working directory. Do
   not try to reason your way to the "real" one. Step 3 settles it.

3. Verify with a tool that touches the index. **`yomi version` is not a
   verification** — it prints a string without opening SQLite, so it succeeds on
   a Node that cannot run search. Call `get_scope_policy`: it needs SQLite and no
   LINE login. If it returns the policy text, the runtime is right. If it fails,
   the error names the Node that actually ran and what it needed.

4. Fully quit and reopen Claude Desktop. Confirm Yomi is loaded under **Settings →
   Developer** before anything else: if Yomi is not listed there, Claude never read
   your config — on Windows, see the MSIX warning in step 2. Once it is listed, the
   tools are available in chat and in Cowork's local sessions alike.

You do **not** need to install Claude Code for this setup.

</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add yomi -- npx @rikaidev/yomi
```

Start a new `claude` session. The Yomi tools should appear automatically. This
command configures Claude Code only; it does not configure Claude Desktop.

This form leaves the runtime to `PATH`, which is fine as long as the `node` your
`claude` session resolves is a supported one — it is the same `PATH` you can see,
unlike Claude Desktop's. Check with `node -e 'require("node:sqlite")'`. If it
throws, or you would rather not depend on `PATH` at all, name the Node
explicitly:

```bash
claude mcp add yomi -e PATH="$(dirname "$(command -v node)"):$PATH" -- npx -y @rikaidev/yomi
```

Either way, verify with `get_scope_policy` rather than `yomi version`: the
version command prints a string without opening SQLite, so it passes on a Node
that cannot run search.

> **Running Claude Code inside a clone of this repo?** Spell the spec
> `@rikaidev/yomi@latest`. Without a tag, `npx` looks for a local bin first, and
> in this repo `package.json` declares `"bin": {"yomi": ...}` while nothing links
> it into `node_modules/.bin` — so `npx` skips the install and dies with
> `sh: yomi: command not found`. An explicit tag makes it fetch the published
> package. Only affects working copies of Yomi itself; everywhere else the
> untagged form is fine.

</details>

<details>
<summary><strong>Other MCP clients</strong></summary>

This standard config works in most MCP clients:

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

<details>
<summary>Cursor</summary>

`Cursor Settings` → `MCP` → `Add new MCP Server` → name it `yomi`, command type, value: `npx @rikaidev/yomi`

Or add to `.cursor/mcp.json` in your project root.
</details>

<details>
<summary>VS Code (GitHub Copilot)</summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "yomi": {
      "command": "npx",
      "args": ["@rikaidev/yomi"]
    }
  }
}
```
</details>

<details>
<summary>opencode</summary>

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "yomi": {
      "type": "local",
      "command": ["npx", "@rikaidev/yomi"],
      "enabled": true
    }
  }
}
```
</details>

<details>
<summary>Codex</summary>

```bash
codex mcp add yomi npx @rikaidev/yomi
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.yomi]
command = "npx"
args = ["@rikaidev/yomi"]
```
</details>

<details>
<summary>Cline</summary>

Add to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "yomi": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@rikaidev/yomi"]
    }
  }
}
```
</details>

<details>
<summary>Windsurf</summary>

Add to `~/.codeium/windsurf/mcp_config.json` — same JSON as standard config.
</details>

<details>
<summary>Amp</summary>

```bash
amp mcp add yomi -- npx @rikaidev/yomi
```
</details>

<details>
<summary>Goose</summary>

`Advanced settings` → `Extensions` → `Add custom extension` → name `yomi`, type `STDIO`, command: `npx @rikaidev/yomi`
</details>

<details>
<summary>Grok</summary>

```bash
grok mcp add yomi -- npx @rikaidev/yomi
```
</details>

</details>

### First login

Once connected, tell the agent:

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

For contributors working on the Yomi source code (requires [bun](https://bun.sh)
or Node.js 24+ — `.nvmrc` pins the same 24 that CI installs, so `nvm use` in this
directory picks it up; note nvm does not read `engines`, which is why the two are
stated separately and guarded by a test):

```bash
bun install                 # install dependencies (or npm install)
bun run.mjs                 # run the stdio MCP server
bun run.mjs login           # run the login flow in a terminal
npm run build               # tsc --noEmit — type-check only (Yomi ships & runs from src/)
npm test                    # bun test
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

Yomi's LINE protocol implementation was written with reference to three open-source
projects, whose field layouts, E2EE chunk ordering, request shapes, and Thrift
definitions informed this independent implementation:

- **[evex-dev/linejs](https://github.com/evex-dev/linejs)** (MIT) — request shapes
  and the Letter-Sealing E2EE payload layout.
- **[DeachSword/CHRLINE](https://github.com/DeachSword/CHRLINE)** (BSD-3-Clause) —
  protocol field layouts and the passwordless login flow.
- **[er1ce/LINE-Protocol](https://github.com/er1ce/LINE-Protocol)** (Apache-2.0) —
  Thrift enum definitions (ContentType, MessageRelationType, ServiceCode).

Their copyright notices and full license texts are reproduced in [`NOTICE`](NOTICE),
as their licenses require.

## License

MIT
