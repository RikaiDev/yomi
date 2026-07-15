/**
 * Yomi MCP tool schemas — the full TOOLS list served by ListToolsRequest
 * and dispatched by CallToolRequest in server.ts.
 *
 * Split out from server.ts purely to keep server.ts (the wiring/dispatch
 * file) under the project's 200-scc-line cap; behavior owned here is
 * unchanged from what previously lived inline in server.ts.
 */

export const TOOLS = [
  {
    description:
      'Log in to LINE via the passwordless (secondary-device) flow. Requires the primary phone to have 設定 > 我的帳號 > 允許自其他裝置登入 enabled, or LINE will never offer this device a sign-in prompt. Behavior depends on whether the connected MCP client supports elicitation. If it does: phone/region are elicited from the human when omitted, a second elicitation displays the PIN, and this call blocks by itself until login completes and persists the session — no further tool call needed. If it does NOT (e.g. Claude Desktop): phone/region are resolved from the arguments or, if omitted, from a previously persisted login (or you must supply them, or run `npx @rikaidev/yomi login` once in a terminal) — this call starts the login in the background and returns as soon as LINE issues the PIN (waiting up to 20s) or reports that no PIN was needed (a stored login certificate skips the PIN step entirely). Either way, call `login_complete` IMMEDIATELY after this returns — do NOT wait for the human to say they entered the PIN or approved the device first. LINE itself only gives the human about 3 minutes from when the PIN is shown to enter it and confirm the device on the primary phone — `login_complete` blocks well beyond that (minutes, not seconds) so a slow phone is never the failure, but waiting here before calling it burns into that real 3-minute deadline for nothing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        phone: {
          type: 'string',
          description:
            'Phone number in E.164 form, e.g. +8869XXXXXXXX. Omit to be prompted for it via elicitation, or to reuse a previously persisted phone number.',
        },
        region: {
          type: 'string',
          description:
            'Region code, e.g. TW, JP, TH, ID, US. Omit to be prompted for it via elicitation, or to reuse a previously persisted region.',
        },
      },
    },
    name: 'login',
  },
  {
    description:
      "Finish a LINE passwordless login that `login` started on a client without MCP elicitation support (on elicitation-capable clients, `login` alone completes the flow and this tool is not needed). Takes no arguments. Call this immediately after `login` returns a PIN (or reports the PIN step was skipped) — do not wait for the human to confirm anything first. It BLOCKS while the human acts on their phone: first for them to enter the PIN (skipped entirely when a stored login certificate is valid), then for them to approve the new device, then returns the logged-in profile. This call itself is willing to wait several minutes for each step, but that is just headroom — LINE's own server-side deadline is the real one: about 3 minutes from when the PIN is shown to enter it and confirm the device on the primary phone, after which the code is dead and a fresh `login` call is needed regardless of how much longer this call would have waited. Errors honestly if no login is currently pending — call `login` first.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    name: 'login_complete',
  },
  {
    description:
      "List LINE conversations (chats, groups, rooms) with unread counts, a preview of the last message, and a human-readable name (group title, or the other party's display name for a 1:1).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description:
            'Maximum number of conversations to return (default 20).',
        },
      },
    },
    name: 'list_conversations',
  },
  {
    description:
      'Fetch messages from one LINE conversation. Text is E2EE-decrypted when key material is available; each message includes a resolved sender display name (fromName); media messages are flagged with a mediaType (image/video/audio/file) and their messageId for use with get_message_media. Each message also includes `mentions`: LINE\'s raw, unparsed mention metadata (contentMetadata.MENTION) when present, or null otherwise — a plain "@name" appearing in `text` is not itself a mention, the real mention data lives in this separate field and its shape is still being observed. Without `before`, returns the most recent `count` messages. With `before`, fetches one page of messages older than that cursor (use the id/deliveredTime of the oldest message from a prior call) — call again with a new cursor to page further back.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID, as returned by list_conversations.',
        },
        count: {
          type: 'number',
          description: 'Maximum number of messages to return (default 50).',
        },
        before: {
          type: 'object',
          description:
            'Cursor to fetch messages older than this point. Use the id and/or deliveredTime of the oldest message already seen.',
          properties: {
            messageId: {
              type: 'string',
              description: 'LINE message id of the cursor message.',
            },
            deliveredTime: {
              type: 'number',
              description: 'deliveredTime of the cursor message.',
            },
          },
        },
      },
      required: ['chatId'],
    },
    name: 'get_chat_messages',
  },
  {
    description:
      'Download and decrypt one LINE image message. Legacy alias of get_message_media restricted to images; prefer get_message_media for video/audio/file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID the message belongs to. Required to locate E2EE key material.',
        },
        messageId: {
          type: 'string',
          description: 'LINE message id, as returned by get_chat_messages.',
        },
        preview: {
          type: 'boolean',
          description:
            'Fetch the smaller preview object instead of the full-resolution original.',
        },
      },
      required: ['chatId', 'messageId'],
    },
    name: 'get_message_image',
  },
  {
    description:
      'Download and decrypt one LINE media message of any downloadable content type (image, video, audio, or file). Returns image/audio MCP content for those kinds, or an embedded resource blob (with filename when known) for video/file. Messages that are not downloadable media (plain text, sticker refs, unsupported types) return an honest error naming the content type — never fabricated bytes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID the message belongs to. Required to locate E2EE key material.',
        },
        messageId: {
          type: 'string',
          description: 'LINE message id, as returned by get_chat_messages.',
        },
        preview: {
          type: 'boolean',
          description:
            'Fetch the smaller preview object instead of the full-resolution original (images/video only).',
        },
      },
      required: ['chatId', 'messageId'],
    },
    name: 'get_message_media',
  },
  {
    description:
      'One-shot unread digest: every LINE conversation that has unread messages, each with its most recent messages (default 10), E2EE-decrypted, with resolved sender names. Built for "summarize my unread and suggest next steps" — saves calling list_conversations then get_chat_messages per chat. Read-only: it never marks anything read (reading stays silent) and never touches the search index. Denylist-excluded conversations are omitted. Returns an empty list when there is nothing unread — never fabricated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        perChat: {
          type: 'number',
          description:
            'Maximum recent messages to include per unread conversation (default 10).',
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of conversations to scan for unread (default 20).',
        },
      },
    },
    name: 'get_unread_digest',
  },
  {
    description:
      'REALLY sends a text message to a real LINE conversation right now — this is not a draft or a preview, it is delivered to the other party/parties immediately. Always E2EE-encrypted (pairwise for a 1:1 chat, group key for a group/room); if the encryption key cannot be resolved the call fails honestly instead of sending plaintext. Exactly one message is sent per call — no retries. To @mention someone, write the visible "@name " text into `text` yourself AND pass a matching entry in `mentions` — omitting `mentions` sends a literal "@name" string that LINE renders as ordinary text and does NOT notify anyone. Use get_group_members or find_contact to look up the MID a mention needs; this tool does not resolve display names to MIDs for you.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        text: {
          type: 'string',
          description:
            'Plain-text message body to send, including the literal "@name" text for any mentions — mentions only mark up text that is already there.',
        },
        mentions: {
          type: 'array',
          description:
            'Optional @mentions to attach to this message. Each entry marks a span of `text` as a mention of one LINE user, which LINE will highlight and notify. Omit entirely to send `text` as plain, non-notifying text (even if it contains a literal "@name").',
          items: {
            type: 'object',
            properties: {
              mid: {
                type: 'string',
                description:
                  'MID of the user being mentioned, as returned by get_group_members or find_contact.',
              },
              start: {
                type: 'number',
                description:
                  'Start offset (inclusive) of the "@name" run in `text`, in UTF-16 code units (i.e. plain JS string index).',
              },
              end: {
                type: 'number',
                description:
                  'End offset (exclusive) of the "@name" run in `text` — half-open range [start, end), UTF-16 code units.',
              },
            },
            required: ['mid', 'start', 'end'],
          },
        },
      },
      required: ['chatId', 'text'],
    },
    name: 'send_message',
  },
  {
    description:
      'REALLY sends an E2EE image to a real LINE conversation right now — this is not a draft, it is delivered to the other party/parties immediately. Upload-then-send: the image is encrypted and uploaded to LINE OBS (original + required preview object) before the E2EE data message pointing at it is sent. Works for 1:1 chats, groups, and rooms — pairwise E2EE key for a 1:1 chat, group key for a group/room. Exactly one send per call — no retries. If the encryption key cannot be resolved (including a group whose key cannot be resolved) or the upload is rejected, the call fails honestly instead of fabricating a success. Provide exactly one of imagePath or imageBase64.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        imagePath: {
          type: 'string',
          description:
            'Local filesystem path to the image file. Mutually exclusive with imageBase64.',
        },
        imageBase64: {
          type: 'string',
          description:
            'Base64-encoded image bytes. Mutually exclusive with imagePath.',
        },
      },
      required: ['chatId'],
    },
    name: 'send_image',
  },
  {
    description:
      'REALLY sends an E2EE file attachment (any type — .docx, .pdf, .zip, …) to a real LINE conversation right now; it is delivered to the other party/parties immediately, not a draft. Same upload-then-send pipeline as send_image: the file is encrypted and uploaded to LINE OBS before the E2EE data message pointing at it is sent, and the original filename is sealed end-to-end so the recipient sees it. Works for 1:1 chats, groups, and rooms. Exactly one send per call — no retries. If the encryption key cannot be resolved or the upload is rejected, the call fails honestly instead of fabricating a success. Provide exactly one of filePath or fileBase64; fileName is required with fileBase64 (and overrides the basename when given with filePath).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        filePath: {
          type: 'string',
          description:
            'Local filesystem path to the file. Mutually exclusive with fileBase64.',
        },
        fileBase64: {
          type: 'string',
          description:
            'Base64-encoded file bytes. Mutually exclusive with filePath; requires fileName.',
        },
        fileName: {
          type: 'string',
          description:
            'Original filename shown to the recipient (sealed E2EE). Required with fileBase64; optional with filePath (defaults to its basename).',
        },
      },
      required: ['chatId'],
    },
    name: 'send_file',
  },
  {
    description:
      'REALLY shares a LINE contact card to a real conversation right now — the recipient sees a tappable card for the shared person. This is NOT a file/image and NOT E2EE media: it is a CONTACT message naming the shared person by their LINE mid. Provide `contactMid` (the person to share, e.g. from find_contact or get_group_members); `displayName` is optional and resolved from the mid when omitted. Works for 1:1 chats, groups, and rooms. Exactly one send per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        contactMid: {
          type: 'string',
          description:
            'MID of the person whose contact card to share, as returned by find_contact or get_group_members.',
        },
        displayName: {
          type: 'string',
          description:
            'Optional display name for the card. Resolved from contactMid when omitted.',
        },
      },
      required: ['chatId', 'contactMid'],
    },
    name: 'send_contact',
  },
  {
    description:
      'Send a LINE read receipt (mark a conversation read up to a message) — this is a real, side-effecting action the other party can see. Marks read up to `messageId`, or the latest message when `messageId` is omitted. Use ONLY when the user explicitly wants to mark a chat read; reading messages (get_chat_messages, get_unread_digest) and background capture never mark read. Honest failure if there is no message to mark.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID to mark read, as returned by list_conversations.',
        },
        messageId: {
          type: 'string',
          description:
            'Optional message id to mark read up to. Omit to mark read up to the latest message.',
        },
      },
      required: ['chatId'],
    },
    name: 'mark_read',
  },
  {
    description:
      "Find LINE friends whose display name contains `name` (case-insensitive substring match). Returns each match's mid so it can be passed straight to send_message for a 1:1. Raw LINE friend-list lookup only — no affinity ranking, no fuzzy scoring.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            "Substring to match against friends' display names, case-insensitive.",
        },
      },
      required: ['name'],
    },
    name: 'find_contact',
  },
  {
    description:
      "List the authenticated user's full LINE friend list as-is from LINE (mid + displayName). No ranking, no interaction-frequency ordering — just the raw friend list.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    name: 'list_contacts',
  },
  {
    description:
      'List the members of one LINE group (mid + displayName each). Resolves persistent LINE groups (`c...` chat MIDs); ad-hoc rooms (`r...`) without a group record return an honest error, never a fabricated empty list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE group chat MID, as returned by list_conversations.',
        },
      },
      required: ['chatId'],
    },
    name: 'get_group_members',
  },
  {
    description:
      'Explicitly collect recent messages from LINE conversations into Yomi\'s local cross-conversation search index, so search_messages has something to query. LINE has no native "search all my chats" primitive — this is how Yomi builds one locally. Fetches up to `perChat` recent messages per chat (default 100) for the given `chatIds`, or for all conversations when `chatIds` is omitted. Also batch-embeds each chat\'s messages (best-effort, local ONNX model) so search_messages can rank by meaning, not just keywords, and before returning sweeps the whole index to embed any messages still missing a vector — so re-running this repairs a partially-embedded index (legacy keyword-only rows, or a run where the model failed to load) without re-fetching from LINE. This tool is the explicit, manual path: one call = one bulk fetch, no internal loop or retry. It is NOT the only writer of the index, though — Yomi also runs a background capture loop (a startup catch-up plus a live SYNC4 poll that indexes incoming messages as they arrive, silently and denylist-gated), so the index generally stays current on its own; call this only to force a reconcile or backfill a specific set of chats. Messages without decryptable/plaintext text are skipped, not fabricated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'LINE chat/group/room MIDs to collect from, as returned by list_conversations. Omit to collect from all conversations.',
        },
        perChat: {
          type: 'number',
          description:
            'Maximum recent messages to fetch per chat (default 100).',
        },
      },
    },
    name: 'collect_messages',
  },
  {
    description:
      "Search across your LINE messages. Hybrid ranking: FTS5 keyword search (which covers every indexed message, so exact matches are never dropped) fused with semantic meaning-based similarity when embeddings are available — the response's `mode` field reports which contributed (`hybrid` | `semantic` | `keyword`). On first use, if the index is empty and a session is live, it auto-collects all conversations before searching, so you never have to call collect_messages by hand; a populated index searches locally with no network. Empty index with no session returns an honest notice, never a fabricated empty match list.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Search query. Plain keywords and natural-language descriptions both work — keyword matching catches exact terms, semantic matching catches paraphrases.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default 20).',
        },
      },
      required: ['query'],
    },
    name: 'search_messages',
  },
  {
    description:
      "Add conversations to Yomi's scoping denylist (privacy exclusion). Excluded chats are: (1) skipped by collect_messages/search_messages auto-collect from now on — never fetched or indexed, and (2) PURGED right now — their already-indexed messages and embeddings are deleted from the local search index in the same call. Exclusion is a real privacy action, not just a future filter: it removes what Yomi already learned about the chat, not only what it would learn next. Local-index operation; works without a live LINE session.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'LINE chat/group/room MIDs to exclude, as returned by list_conversations.',
        },
      },
      required: ['chatIds'],
    },
    name: 'exclude_chats',
  },
  {
    description:
      "Remove conversations from Yomi's scoping denylist, re-allowing future capture. This does NOT re-fetch or restore any data purged when the chat was excluded — the next collect_messages or search_messages auto-collect will pick the chat back up going forward, starting from an empty history for it. Local-index operation; works without a live LINE session.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'LINE chat/group/room MIDs to re-include.',
        },
      },
      required: ['chatIds'],
    },
    name: 'include_chats',
  },
  {
    description:
      "List the conversations currently on Yomi's scoping denylist (excluded from capture). Returns `[{ chatId, name }]`; `name` is best-effort resolved when a live LINE session exists, otherwise null — never a fabricated placeholder. Local-index operation; works without a live LINE session.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    name: 'list_excluded_chats',
  },
  {
    description:
      "Return Yomi's data-capture privacy policy (the disclosure to show the user) plus the current list of excluded conversations. Call this to show the user, in concrete terms, what Yomi captures by default and how to exclude conversations.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    name: 'get_scope_policy',
  },
]
