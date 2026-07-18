/**
 * Yomi MCP tool schemas — the full TOOLS list served by ListToolsRequest
 * and dispatched by CallToolRequest in server.ts.
 *
 * Split out from server.ts purely to keep server.ts (the wiring/dispatch
 * file) under the project's 200-scc-line cap; behavior owned here is
 * unchanged from what previously lived inline in server.ts.
 *
 * Descriptions are deliberately terse: the tool list renders at prompt
 * position 0 on every request, so trimming boilerplate here directly lowers
 * the fixed per-request token cost every connected client pays.
 */

export const TOOLS = [
  {
    description:
      'Log in to LINE via the passwordless secondary-device flow. Requires 允許自其他裝置登入 enabled on the primary phone. On MCP clients with elicitation, this call prompts for phone/region and PIN and completes login by itself. On clients without it (e.g. Claude Desktop), phone/region come from the arguments or a persisted login, and this returns as soon as LINE issues the PIN (or reports none needed) — then call login_complete IMMEDIATELY (do not wait for the human). LINE gives ~3 minutes from PIN display to confirm on the phone; login_complete blocks past that, so calling it late only wastes that window.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        phone: {
          type: 'string',
          description:
            'Phone number in E.164 form, e.g. +8869XXXXXXXX. Omit to be prompted (elicitation) or to reuse a persisted number.',
        },
        region: {
          type: 'string',
          description:
            'Region code, e.g. TW, JP, TH, ID, US. Omit to be prompted (elicitation) or to reuse a persisted region.',
        },
      },
    },
    name: 'login',
  },
  {
    description:
      "Finish a passwordless login that `login` started on a client without elicitation (not needed on elicitation-capable clients). No arguments. Call immediately after `login` returns — do not wait for the human. Blocks while they enter the PIN (skipped if a stored certificate is valid) and approve the device, then returns the profile. LINE's real deadline is ~3 minutes from PIN display. Errors if no login is pending.",
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
      'Fetch messages from one LINE conversation. Text is E2EE-decrypted when keys are available; each message has fromName (resolved sender), a mediaType flag (image/video/audio/file) plus messageId for get_message_media, and `mentions` (LINE\'s raw contentMetadata.MENTION, or null — a literal "@name" in `text` is not itself a mention). Without `before`, returns the most recent `count`. With `before` (id/deliveredTime of the oldest message already seen), returns one older page — repeat to page further back.',
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
      'Download and decrypt one LINE media message of any downloadable type (image, video, audio, file). Returns image/audio MCP content, or an embedded resource blob (with filename when known) for video/file. Non-media messages (text, sticker refs, unsupported types) return an honest error naming the content type — never fabricated bytes.',
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
      'One-shot unread digest: every LINE conversation with unread messages, each with its most recent messages (default 10), E2EE-decrypted, with resolved sender names. Saves calling list_conversations then get_chat_messages per chat. Read-only: never marks anything read, never touches the search index; denylist-excluded conversations are omitted. Returns an empty list when nothing is unread — never fabricated.',
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
      'A compact "what needs my attention" context network over the local index — you make the final call, this assembles the evidence cheaply. Nodes: `connectors` (people across ≥2 of your chats, with structural bridges) and `relationships` (per-conversation engagement, reply rhythm, recency). `open`: conversations whose latest message is NOT yours, ranked by how overdue they are relative to your usual reply rhythm there, each with `fromName` (last speaker), a `preview` of the latest message, `overdueRatio`/`typicality`, and a `lastMessageId` pointer. It carries NO message threads and makes NO judgement about addressee, nicknames, or open-request vs closing-ack — those are language understanding you do by reading each `preview` (a group message may be addressed to someone else, who then owns it), fetching the full thread with get_chat_messages only for the few worth it. Reads across all conversations (denylist-excluded dropped). Empty only when the index is empty.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'Optional focus: restrict `relationships` and `pending` to this chat (as returned by list_conversations). Omit to scan all conversations.',
        },
        sinceHours: {
          type: 'number',
          description:
            'Lookback window in hours, measured back from the newest captured message (not wall-clock). Default 504 (21 days).',
        },
      },
    },
    name: 'get_insight',
  },
  {
    description:
      'Sends a text message to a LINE conversation immediately (not a draft). Always E2EE (pairwise for 1:1, group key for group/room); fails honestly rather than sending plaintext if the key cannot be resolved. One send per call. To @mention someone, put the visible "@name " into `text` AND pass a matching `mentions` entry — without `mentions`, "@name" is plain text and notifies no one. Resolve MIDs via get_group_members or find_contact first.',
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
            'Plain-text message body, including the literal "@name" text for any mentions — mentions only mark up text that is already there.',
        },
        mentions: {
          type: 'array',
          description:
            'Optional @mentions. Each entry marks a span of `text` as a mention of one user, which LINE highlights and notifies. Omit to send `text` as plain, non-notifying text.',
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
                  'Start offset (inclusive) of the "@name" run in `text`, in UTF-16 code units (plain JS string index).',
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
        replyToMessageId: {
          type: 'string',
          description:
            'Optional message id (from get_chat_messages) this replies to — LINE renders a quoted reply. Omit for a normal message.',
        },
      },
      required: ['chatId', 'text'],
    },
    name: 'send_message',
  },
  {
    description:
      'Sends an E2EE image to a LINE conversation immediately (encrypt → upload to OBS → send). Works for 1:1/group/room; fails honestly if the key cannot be resolved or the upload is rejected. One send per call. Provide exactly one of imagePath or imageBase64.',
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
      'Sends an E2EE file attachment (any type — .docx, .pdf, .zip, …) to a LINE conversation immediately (same pipeline as send_image; the original filename is sealed end-to-end). Works for 1:1/group/room; fails honestly if the key cannot be resolved or the upload is rejected. One send per call. Provide exactly one of filePath or fileBase64; fileName is required with fileBase64 (and overrides the basename when given with filePath).',
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
      'Sends an E2EE audio message to a LINE conversation immediately (same pipeline as send_file). Provide exactly one of filePath or audioBase64; optional durationMs sets the recipient player length. Works for 1:1/group/room. One send per call.',
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
            'Local filesystem path to the audio file. Mutually exclusive with audioBase64.',
        },
        audioBase64: {
          type: 'string',
          description:
            'Base64-encoded audio bytes. Mutually exclusive with filePath.',
        },
        fileName: {
          type: 'string',
          description:
            'Optional original filename (used for the upload name; defaults to the basename of filePath or audio.m4a).',
        },
        durationMs: {
          type: 'number',
          description:
            'Optional audio duration in milliseconds, for the recipient player progress bar.',
        },
      },
      required: ['chatId'],
    },
    name: 'send_audio',
  },
  {
    description:
      'Sends an E2EE video to a LINE conversation immediately (same pipeline as send_file; uses LINE chunked video encryption so it plays and integrity-verifies on official clients). Provide exactly one of filePath or videoBase64; optional durationMs sets the scrubber length. Works for 1:1/group/room. One send per call.',
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
            'Local filesystem path to the video file. Mutually exclusive with videoBase64.',
        },
        videoBase64: {
          type: 'string',
          description:
            'Base64-encoded video bytes. Mutually exclusive with filePath.',
        },
        fileName: {
          type: 'string',
          description:
            'Optional original filename (used for the upload name; defaults to the basename of filePath or video.mp4).',
        },
        durationMs: {
          type: 'number',
          description:
            'Optional video duration in milliseconds, for the recipient player scrubber.',
        },
      },
      required: ['chatId'],
    },
    name: 'send_video',
  },
  {
    description:
      'Sends a location (map pin) to a LINE conversation immediately — latitude/longitude plus optional title (place name) and address. Works for 1:1/group/room. One send per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        latitude: {
          type: 'number',
          description: 'Latitude in decimal degrees.',
        },
        longitude: {
          type: 'number',
          description: 'Longitude in decimal degrees.',
        },
        title: {
          type: 'string',
          description: 'Optional place name shown on the pin.',
        },
        address: {
          type: 'string',
          description: 'Optional address shown under the pin.',
        },
      },
      required: ['chatId', 'latitude', 'longitude'],
    },
    name: 'send_location',
  },
  {
    description:
      'Shares a LINE contact card to a conversation immediately — the recipient sees a tappable card for `contactMid` (e.g. from find_contact or get_group_members). `displayName` is optional (resolved from the mid when omitted). Works for 1:1/group/room. One send per call.',
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
      'Sends a LINE sticker to a conversation immediately, named by stickerId (STKID) + packageId (STKPKGID). Only OWNED stickers can be sent — get ids from search_stickers/list_stickers. Works for 1:1/group/room. One send per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        stickerId: {
          type: 'string',
          description: 'LINE sticker id (STKID).',
        },
        packageId: {
          type: 'string',
          description: 'LINE sticker package id (STKPKGID).',
        },
        version: {
          type: 'string',
          description: 'Sticker version (STKVER). Defaults to "1".',
        },
      },
      required: ['chatId', 'stickerId', 'packageId'],
    },
    name: 'send_sticker',
  },
  {
    description:
      "List the sticker packages this LINE account OWNS — the only stickers it can send. Returns each package's packageId (STKPKGID), title, and version (STKVER). Get individual sticker ids via search_stickers, then send_sticker. Read-only.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        language: {
          type: 'string',
          description:
            "Locale for package titles, e.g. 'en' or 'zh-Hant'. Defaults to 'en'.",
        },
      },
    },
    name: 'list_stickers',
  },
  {
    description:
      "Search the account's OWNED sticker packages by title and expand each match into its individual sticker ids (STKID), ready for send_sticker. Case-insensitive substring match on the package title. Read-only.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Substring to match against owned package titles (case-insensitive).',
        },
        language: {
          type: 'string',
          description:
            "Locale for package titles to match against, e.g. 'en' or 'zh-Hant'. Defaults to 'en'.",
        },
        limit: {
          type: 'number',
          description:
            'Max matching packages to expand with sticker ids (default 8).',
        },
      },
      required: ['query'],
    },
    name: 'search_stickers',
  },
  {
    description:
      'Show sticker preview images (MCP image content from the public sticker CDN) so you and the user can SEE them before sending. Give a packageId (from list_stickers/search_stickers) to preview its first stickers, or add a stickerId to preview just one. Each image is labeled with its stickerId + packageId for send_sticker. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        packageId: {
          type: 'string',
          description: 'Sticker package id (STKPKGID) to preview.',
        },
        stickerId: {
          type: 'string',
          description:
            'Optional specific sticker id (STKID) to preview just that sticker.',
        },
        limit: {
          type: 'number',
          description:
            'Max stickers to preview when no stickerId is given (default 8).',
        },
      },
      required: ['packageId'],
    },
    name: 'preview_sticker',
  },
  {
    description:
      'Send a LINE read receipt (mark a conversation read up to `messageId`, or the latest when omitted) — a real action the other party can see. Use ONLY when the user explicitly wants to mark a chat read; reading (get_chat_messages, get_unread_digest) and background capture never mark read. Fails honestly if there is nothing to mark.',
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
      "Find LINE friends whose display name contains `name` (case-insensitive substring). Returns each match's mid for send_message. Raw friend-list lookup — no ranking, no fuzzy scoring.",
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
      "List the authenticated user's full LINE friend list as-is (mid + displayName). No ranking, no interaction-frequency ordering.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    name: 'list_contacts',
  },
  {
    description:
      'List the members of one LINE group (mid + displayName each). Resolves persistent groups (`c...`); ad-hoc rooms (`r...`) without a group record return an honest error, never a fabricated empty list.',
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
      'Renames a LINE group/chat immediately; the new name is visible to every member. Works on groups/rooms (chatId starting with `c`/`r`). One rename per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE group/room MID to rename, as returned by list_conversations.',
        },
        name: { type: 'string', description: 'New group name.' },
      },
      required: ['chatId', 'name'],
    },
    name: 'rename_group',
  },
  {
    description:
      'Invites members into a LINE group immediately. Invitees must accept before joining. Provide `mids` (from find_contact or get_group_members). One call per invite batch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE group/room MID to invite into, as returned by list_conversations.',
        },
        mids: {
          type: 'array',
          items: { type: 'string' },
          description: 'MIDs of the people to invite.',
        },
      },
      required: ['chatId', 'mids'],
    },
    name: 'invite_member',
  },
  {
    description:
      'Removes (kicks) members from a LINE group immediately — they lose access at once (re-adding needs a fresh invite); visible to every member. Provide `mids` (from get_group_members). One call per removal batch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE group/room MID to remove members from, as returned by list_conversations.',
        },
        mids: {
          type: 'array',
          items: { type: 'string' },
          description: 'MIDs of the members to remove.',
        },
      },
      required: ['chatId', 'mids'],
    },
    name: 'kick_member',
  },
  {
    description:
      'Makes THIS LINE account leave a group immediately — it loses access to the group and its history. One leave per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE group/room MID to leave, as returned by list_conversations.',
        },
      },
      required: ['chatId'],
    },
    name: 'leave_group',
  },
  {
    description:
      'Creates a new LINE group/room immediately with the given members (no message is sent). chatType 0 = group (invitees must accept before joining), 1 = room (members added directly); default 1. Provide `name` and `mids` (initial members, e.g. from find_contact). One create per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name for the new group.' },
        mids: {
          type: 'array',
          items: { type: 'string' },
          description: 'MIDs of the initial members to add.',
        },
        chatType: {
          type: 'number',
          description:
            'LINE chat type: 0 = group (invite-based), 1 = room (direct add). Default 1.',
        },
      },
      required: ['name', 'mids'],
    },
    name: 'create_group',
  },
  {
    description:
      'Adds a person to your LINE friends by their MID (e.g. from get_group_members or find_contact). One add per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mid: {
          type: 'string',
          description:
            'MID of the person to add as a friend, e.g. from get_group_members.',
        },
      },
      required: ['mid'],
    },
    name: 'add_friend',
  },
  {
    description:
      'Blocks a contact for your LINE account — they can no longer message you. Reversible with unblock_contact. One block per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mid: {
          type: 'string',
          description: 'MID of the contact to block.',
        },
      },
      required: ['mid'],
    },
    name: 'block_contact',
  },
  {
    description:
      'Unblocks a previously blocked contact for your LINE account. Undoes block_contact. One unblock per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mid: {
          type: 'string',
          description: 'MID of the contact to unblock.',
        },
      },
      required: ['mid'],
    },
    name: 'unblock_contact',
  },
  {
    description:
      'Accepts a group/chat invitation for your LINE account — you join the chat. Use for a group you were invited to (its chatId appears with invited status). One accept per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description:
            'LINE group/room MID whose invitation to accept, as returned by list_conversations.',
        },
      },
      required: ['chatId'],
    },
    name: 'accept_invitation',
  },
  {
    description:
      'Adds a reaction to a LINE message, visible to the conversation. reactionType: 2 = 👍 LIKE, 3 = ❤️ LOVE, 4 = 😆 LAUGH, 5 = 😮 SURPRISE, 6 = 😢 SAD, 7 = 😡 ANGRY (default 2). One reaction per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: {
          type: 'string',
          description:
            'LINE message id to react to, as returned by get_chat_messages.',
        },
        reactionType: {
          type: 'number',
          description:
            'Predefined reaction: 2=👍LIKE, 3=❤️LOVE, 4=😆LAUGH, 5=😮SURPRISE, 6=😢SAD, 7=😡ANGRY. Default 2.',
        },
      },
      required: ['messageId'],
    },
    name: 'react_message',
  },
  {
    description:
      "Removes this account's reaction from a LINE message. Undoes a react_message. One cancellation per call.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: {
          type: 'string',
          description:
            'LINE message id whose reaction to remove, as returned by get_chat_messages.',
        },
      },
      required: ['messageId'],
    },
    name: 'cancel_reaction',
  },
  {
    description:
      'Retracts (unsends) one of YOUR OWN LINE messages for everyone — deletes it from the conversation for all participants and CANNOT be undone. LINE allows unsending only your own messages. SAFETY GATE: you must pass confirm: true, or the call refuses so it can never fire by accident. One unsend per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: {
          type: 'string',
          description:
            'LINE message id to retract (must be your own), as returned by get_chat_messages.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true to proceed. Retraction is irreversible; the call refuses unless this is explicitly true.',
        },
      },
      required: ['messageId', 'confirm'],
    },
    name: 'unsend_message',
  },
  {
    description:
      "Bulk-fetch recent messages from LINE conversations into Yomi's local cross-conversation search index (LINE has no native cross-chat search). Fetches up to `perChat` per chat (default 100) for `chatIds`, or all conversations when omitted, and best-effort embeds them for semantic search — re-running also repairs any messages still missing a vector. A background capture loop keeps the index current on its own, so call this only to force a reconcile or backfill specific chats. Undecryptable messages are skipped, not fabricated.",
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
      'Search across your LINE messages. Hybrid ranking: FTS5 keyword search (covers every indexed message, so exact matches are never dropped) fused with semantic similarity when embeddings are available — the `mode` field reports which contributed (hybrid | semantic | keyword). If the index is empty and a session is live, it auto-collects all conversations first; a populated index searches locally with no network. Empty index with no session returns an honest notice, never a fabricated match list.',
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
      "Add conversations to Yomi's privacy denylist. Excluded chats are (1) skipped by future collect_messages/search_messages auto-collect — never fetched or indexed — and (2) PURGED now: their already-indexed messages and embeddings are deleted from the local index in the same call. A real privacy action, not just a future filter. Local-index operation; works without a live LINE session.",
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
      "Remove conversations from Yomi's denylist, re-allowing future capture. Does NOT restore data purged when the chat was excluded — capture resumes from empty history going forward. Local-index operation; works without a live LINE session.",
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
      "List the conversations currently on Yomi's privacy denylist. Returns `[{ chatId, name }]`; `name` is best-effort resolved when a live LINE session exists, otherwise null — never a fabricated placeholder. Local-index operation; works without a live LINE session.",
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
