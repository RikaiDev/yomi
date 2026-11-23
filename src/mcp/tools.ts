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
import type { Tool } from '@modelcontextprotocol/server'
import { PRIMARY_DEVICE_SETTING_PATH } from './handlers/login-copy.js'

export const TOOLS: Tool[] = [
  {
    description: `Log in to LINE via the passwordless secondary-device flow. Requires ${PRIMARY_DEVICE_SETTING_PATH} enabled on the primary phone — with it off LINE never prompts that phone and NO login can succeed, so raise this with the human up front rather than after a failure. On MCP clients with form elicitation, this call first confirms that setting, then prompts for phone/region and PIN and completes login by itself; if the human says the setting is off, it returns the enabling steps without starting a login (relay them verbatim, then call \`login\` again). On clients without it (e.g. Claude Desktop), phone/region come from the arguments or a persisted login, and this returns as soon as LINE issues the PIN (or reports none needed) — then call login_complete IMMEDIATELY (do not wait for the human). LINE gives ~3 minutes from PIN display to confirm on the phone; login_complete blocks past that, so calling it late only wastes that window.`,
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
      "Finish a passwordless login that `login` started on a client without form elicitation (not needed on form-elicitation-capable clients). No arguments. Call immediately after `login` returns — do not wait for the human. Blocks while they enter the PIN (skipped if a stored certificate is valid) and approve the device, then returns the profile. LINE's real deadline is ~3 minutes from PIN display. Errors if no login is pending.",
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
      'Fetch messages from one LINE conversation. Text is E2EE-decrypted when keys are available; each message has fromName (resolved sender), a mediaType flag (image/video/audio/file) plus message_id for get_message_media, and `mentions` (LINE\'s raw contentMetadata.MENTION, or null — a literal "@name" in `text` is not itself a mention). Without `before`, returns the most recent `count`. With `before` (id/delivered_time of the oldest message already seen), returns one older page — repeat to page further back.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
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
            'Cursor to fetch messages older than this point. Use the id and/or delivered_time of the oldest message already seen.',
          properties: {
            message_id: {
              type: 'string',
              description: 'LINE message id of the cursor message.',
            },
            delivered_time: {
              type: 'number',
              description: 'delivered_time of the cursor message.',
            },
          },
        },
      },
      required: ['chat_id'],
    },
    name: 'get_chat_messages',
  },
  {
    description:
      'Download and decrypt one LINE image message. Legacy alias of get_message_media restricted to images; prefer get_message_media for video/audio/file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE chat/group/room MID the message belongs to. Required to locate E2EE key material.',
        },
        message_id: {
          type: 'string',
          description: 'LINE message id, as returned by get_chat_messages.',
        },
        preview: {
          type: 'boolean',
          description:
            'Fetch the smaller preview object instead of the full-resolution original.',
        },
      },
      required: ['chat_id', 'message_id'],
    },
    name: 'get_message_image',
  },
  {
    description:
      'Download and decrypt one LINE media message of any downloadable type (image, video, audio, file). Returns image/audio MCP content, or an embedded resource blob (with filename when known) for video/file. Set asImage=true to convert a PDF attachment to a PNG image (first page) so it can be read as MCP image content. Non-media messages (text, sticker refs, unsupported types) return an honest error naming the content type — never fabricated bytes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE chat/group/room MID the message belongs to. Required to locate E2EE key material.',
        },
        message_id: {
          type: 'string',
          description: 'LINE message id, as returned by get_chat_messages.',
        },
        preview: {
          type: 'boolean',
          description:
            'Fetch the smaller preview object instead of the full-resolution original (images/video only).',
        },
        asImage: {
          type: 'boolean',
          description:
            'If true and the attachment is a PDF, convert the first page to a PNG image and return it as MCP image content instead of a resource blob.',
        },
      },
      required: ['chat_id', 'message_id'],
    },
    name: 'get_message_media',
  },
  {
    description:
      'Analyze conversations for ball-in-court ownership (who likely needs to act next). For each conversation returns ball=mine|theirs|team|none|unknown with heuristic reasons and confidence, the last relevant message, and unread count. Read-only (never marks read). Use to triage what needs my reply/action vs what I am waiting on; treat as evidence in groups or when messages are ambiguous/encrypted. Defaults to all non-excluded conversations; set unread_only/include_read to focus unread, or chat_id for one chat.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description:
            'Maximum conversations to analyze, most recently active first (default: all).',
        },
        per_chat: {
          type: 'number',
          description:
            'Recent messages inspected per conversation (default 20, min 5, max 50).',
        },
        unread_only: {
          type: 'boolean',
          description:
            'If true, analyze only conversations with unread messages.',
        },
        include_read: {
          type: 'boolean',
          description:
            'If false, same as unread_only=true (backward-friendly); default analyzes all conversations.',
        },
        chat_id: {
          type: 'string',
          description:
            'Analyze a single chat MID instead of scanning conversations.',
        },
      },
    },
    name: 'get_action_items',
  },
  {
    description:
      'One-shot unread digest: every LINE conversation with unread messages (all pages of the inbox, newest activity first), each with its most recent messages (default 10), E2EE-decrypted, with resolved sender names. Saves calling list_conversations then get_chat_messages per chat. Read-only: never marks anything read, never touches the search index; denylist-excluded conversations are omitted. Returns an empty list when nothing is unread — never fabricated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        per_chat: {
          type: 'number',
          description:
            'Maximum recent messages to include per unread conversation (default 10).',
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of unread conversations to return, most recently active first (default: all of them).',
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
        chat_id: {
          type: 'string',
          description:
            'Optional focus: restrict `relationships` and `pending` to this chat (as returned by list_conversations). Omit to scan all conversations.',
        },
        since_hours: {
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
        chat_id: {
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
        reply_to_message_id: {
          type: 'string',
          description:
            'Optional message id (from get_chat_messages) this replies to — LINE renders a quoted reply. Omit for a normal message.',
        },
      },
      required: ['chat_id', 'text'],
    },
    name: 'send_message',
  },
  {
    description:
      'Sends an E2EE image to a LINE conversation immediately (encrypt → upload to OBS → send). Works for 1:1/group/room; fails honestly if the key cannot be resolved or the upload is rejected. One send per call. Provide exactly one of image_path or image_base64.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        image_path: {
          type: 'string',
          description:
            'Local filesystem path to the image file. Mutually exclusive with image_base64.',
        },
        image_base64: {
          type: 'string',
          description:
            'Base64-encoded image bytes. Mutually exclusive with image_path.',
        },
      },
      required: ['chat_id'],
    },
    name: 'send_image',
  },
  {
    description:
      'Sends an E2EE file attachment (any type — .docx, .pdf, .zip, …) to a LINE conversation immediately (same pipeline as send_image; the original filename is sealed end-to-end). Works for 1:1/group/room; fails honestly if the key cannot be resolved or the upload is rejected. One send per call. Provide exactly one of file_path or file_base64; file_name is required with file_base64 (and overrides the basename when given with file_path).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        file_path: {
          type: 'string',
          description:
            'Local filesystem path to the file. Mutually exclusive with file_base64.',
        },
        file_base64: {
          type: 'string',
          description:
            'Base64-encoded file bytes. Mutually exclusive with file_path; requires file_name.',
        },
        file_name: {
          type: 'string',
          description:
            'Original filename shown to the recipient (sealed E2EE). Required with file_base64; optional with file_path (defaults to its basename).',
        },
      },
      required: ['chat_id'],
    },
    name: 'send_file',
  },
  {
    description:
      'Sends an E2EE audio message to a LINE conversation immediately (same pipeline as send_file). Provide exactly one of file_path or audio_base64; optional duration_ms sets the recipient player length. Works for 1:1/group/room. One send per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        file_path: {
          type: 'string',
          description:
            'Local filesystem path to the audio file. Mutually exclusive with audio_base64.',
        },
        audio_base64: {
          type: 'string',
          description:
            'Base64-encoded audio bytes. Mutually exclusive with file_path.',
        },
        file_name: {
          type: 'string',
          description:
            'Optional original filename (used for the upload name; defaults to the basename of file_path or audio.m4a).',
        },
        duration_ms: {
          type: 'number',
          description:
            'Optional audio duration in milliseconds, for the recipient player progress bar.',
        },
      },
      required: ['chat_id'],
    },
    name: 'send_audio',
  },
  {
    description:
      'Sends an E2EE video to a LINE conversation immediately (same pipeline as send_file; uses LINE chunked video encryption so it plays and integrity-verifies on official clients). Provide exactly one of file_path or video_base64; optional duration_ms sets the scrubber length. Works for 1:1/group/room. One send per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        file_path: {
          type: 'string',
          description:
            'Local filesystem path to the video file. Mutually exclusive with video_base64.',
        },
        video_base64: {
          type: 'string',
          description:
            'Base64-encoded video bytes. Mutually exclusive with file_path.',
        },
        file_name: {
          type: 'string',
          description:
            'Optional original filename (used for the upload name; defaults to the basename of file_path or video.mp4).',
        },
        duration_ms: {
          type: 'number',
          description:
            'Optional video duration in milliseconds, for the recipient player scrubber.',
        },
      },
      required: ['chat_id'],
    },
    name: 'send_video',
  },
  {
    description:
      'Sends a location (map pin) to a LINE conversation immediately — latitude/longitude plus optional title (place name) and address. Works for 1:1/group/room. One send per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
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
      required: ['chat_id', 'latitude', 'longitude'],
    },
    name: 'send_location',
  },
  {
    description:
      'Shares a LINE contact card to a conversation immediately — the recipient sees a tappable card for `contact_mid` (e.g. from find_contact or get_group_members). `display_name` is optional (resolved from the mid when omitted). Works for 1:1/group/room. One send per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        contact_mid: {
          type: 'string',
          description:
            'MID of the person whose contact card to share, as returned by find_contact or get_group_members.',
        },
        display_name: {
          type: 'string',
          description:
            'Optional display name for the card. Resolved from contact_mid when omitted.',
        },
      },
      required: ['chat_id', 'contact_mid'],
    },
    name: 'send_contact',
  },
  {
    description:
      'Sends a LINE sticker to a conversation immediately, named by sticker_id (STKID) + package_id (STKPKGID). Only OWNED stickers can be sent — get ids from search_stickers/list_stickers. Works for 1:1/group/room. One send per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE chat/group/room MID to send to, as returned by list_conversations.',
        },
        sticker_id: {
          type: 'string',
          description: 'LINE sticker id (STKID).',
        },
        package_id: {
          type: 'string',
          description: 'LINE sticker package id (STKPKGID).',
        },
        version: {
          type: 'string',
          description: 'Sticker version (STKVER). Defaults to "1".',
        },
      },
      required: ['chat_id', 'sticker_id', 'package_id'],
    },
    name: 'send_sticker',
  },
  {
    description:
      "List the sticker packages this LINE account OWNS — the only stickers it can send. Returns each package's package_id (STKPKGID), title, and version (STKVER). Get individual sticker ids via search_stickers, then send_sticker. Read-only.",
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
      'Show sticker preview images (MCP image content from the public sticker CDN) so you and the user can SEE them before sending. Give a package_id (from list_stickers/search_stickers) to preview its first stickers, or add a sticker_id to preview just one. Each image is labeled with its sticker_id + package_id for send_sticker. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        package_id: {
          type: 'string',
          description: 'Sticker package id (STKPKGID) to preview.',
        },
        sticker_id: {
          type: 'string',
          description:
            'Optional specific sticker id (STKID) to preview just that sticker.',
        },
        limit: {
          type: 'number',
          description:
            'Max stickers to preview when no sticker_id is given (default 8).',
        },
      },
      required: ['package_id'],
    },
    name: 'preview_sticker',
  },
  {
    description:
      'Send a LINE read receipt (mark a conversation read up to `message_id`, or the latest when omitted) — a real action the other party can see. Use ONLY when the user explicitly wants to mark a chat read; reading (get_chat_messages, get_unread_digest) and background capture never mark read. Fails honestly if there is nothing to mark.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE chat/group/room MID to mark read, as returned by list_conversations.',
        },
        message_id: {
          type: 'string',
          description:
            'Optional message id to mark read up to. Omit to mark read up to the latest message.',
        },
      },
      required: ['chat_id'],
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
      "List the authenticated user's full LINE friend list as-is (mid + display_name). No ranking, no interaction-frequency ordering.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    name: 'list_contacts',
  },
  {
    description:
      'List the members of one LINE group (mid + display_name each). Resolves persistent groups (`c...`); ad-hoc rooms (`r...`) without a group record return an honest error, never a fabricated empty list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE group chat MID, as returned by list_conversations.',
        },
      },
      required: ['chat_id'],
    },
    name: 'get_group_members',
  },
  {
    description:
      'Renames a LINE group/chat immediately; the new name is visible to every member. Works on groups/rooms (chat_id starting with `c`/`r`). One rename per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE group/room MID to rename, as returned by list_conversations.',
        },
        name: { type: 'string', description: 'New group name.' },
      },
      required: ['chat_id', 'name'],
    },
    name: 'rename_group',
  },
  {
    description:
      'Invites members into a LINE group immediately. Invitees must accept before joining. Provide `mids` (from find_contact or get_group_members). One call per invite batch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
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
      required: ['chat_id', 'mids'],
    },
    name: 'invite_member',
  },
  {
    description:
      'Removes (kicks) members from a LINE group immediately — they lose access at once (re-adding needs a fresh invite); visible to every member. Provide `mids` (from get_group_members). One call per removal batch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
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
      required: ['chat_id', 'mids'],
    },
    name: 'kick_member',
  },
  {
    description:
      'Makes THIS LINE account leave a group immediately — it loses access to the group and its history. One leave per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE group/room MID to leave, as returned by list_conversations.',
        },
      },
      required: ['chat_id'],
    },
    name: 'leave_group',
  },
  {
    description:
      'Creates a new LINE group/room immediately with the given members (no message is sent). chat_type 0 = group (invitees must accept before joining), 1 = room (members added directly); default 1. Provide `name` and `mids` (initial members, e.g. from find_contact). One create per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name for the new group.' },
        mids: {
          type: 'array',
          items: { type: 'string' },
          description: 'MIDs of the initial members to add.',
        },
        chat_type: {
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
      'Accepts a group/chat invitation for your LINE account — you join the chat. Use for a group you were invited to (its chat_id appears with invited status). One accept per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'LINE group/room MID whose invitation to accept, as returned by list_conversations.',
        },
      },
      required: ['chat_id'],
    },
    name: 'accept_invitation',
  },
  {
    description:
      'Adds a reaction to a LINE message, visible to the conversation. reaction_type: 2 = 👍 LIKE, 3 = ❤️ LOVE, 4 = 😆 LAUGH, 5 = 😮 SURPRISE, 6 = 😢 SAD, 7 = 😡 ANGRY (default 2). One reaction per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message_id: {
          type: 'string',
          description:
            'LINE message id to react to, as returned by get_chat_messages.',
        },
        reaction_type: {
          type: 'number',
          description:
            'Predefined reaction: 2=👍LIKE, 3=❤️LOVE, 4=😆LAUGH, 5=😮SURPRISE, 6=😢SAD, 7=😡ANGRY. Default 2.',
        },
      },
      required: ['message_id'],
    },
    name: 'react_message',
  },
  {
    description:
      "Removes this account's reaction from a LINE message. Undoes a react_message. One cancellation per call.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        message_id: {
          type: 'string',
          description:
            'LINE message id whose reaction to remove, as returned by get_chat_messages.',
        },
      },
      required: ['message_id'],
    },
    name: 'cancel_reaction',
  },
  {
    description:
      'Retracts (unsends) one of YOUR OWN LINE messages for everyone — deletes it from the conversation for all participants and CANNOT be undone. LINE allows unsending only your own messages. SAFETY GATE: you must pass confirm: true, or the call refuses so it can never fire by accident. One unsend per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message_id: {
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
      required: ['message_id', 'confirm'],
    },
    name: 'unsend_message',
  },
  {
    description:
      "Bulk-fetch recent messages from LINE conversations into Yomi's local cross-conversation search index (LINE has no native cross-chat search). Fetches up to `per_chat` per chat (default 100) for `chat_ids`, or all conversations when omitted, and indexes them for keyword search. Semantic vectors are produced by a background worker in idle batches, so a collect does not wait for the whole embedding backlog. A background capture loop keeps the index current on its own, so call this only to force a reconcile or backfill specific chats. Undecryptable messages are skipped, not fabricated.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'LINE chat/group/room MIDs to collect from, as returned by list_conversations. Omit to collect from all conversations.',
        },
        per_chat: {
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
      'Search across your LINE messages. Hybrid ranking: FTS5 keyword search (covers every indexed message, so exact matches are never dropped) fused with semantic similarity when embeddings are available — the `mode` field reports which contributed (hybrid | semantic | keyword). Semantic ranking runs only when the vector index covers enough of the corpus and only within a timeout; otherwise the search degrades to the keyword index and says so in `mode`. If the index is empty and a session is live, it auto-collects the conversations within a time budget first; a populated index searches locally with no network. Empty index with no session returns an honest notice, never a fabricated match list.',
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
        chat_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'LINE chat/group/room MIDs to exclude, as returned by list_conversations.',
        },
      },
      required: ['chat_ids'],
    },
    name: 'exclude_chats',
  },
  {
    description:
      "Remove conversations from Yomi's denylist, re-allowing future capture. Does NOT restore data purged when the chat was excluded — capture resumes from empty history going forward. Local-index operation; works without a live LINE session.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'LINE chat/group/room MIDs to re-include.',
        },
      },
      required: ['chat_ids'],
    },
    name: 'include_chats',
  },
  {
    description:
      "List the conversations currently on Yomi's privacy denylist. Returns `[{ chat_id, name }]`; `name` is best-effort resolved when a live LINE session exists, otherwise null — never a fabricated placeholder. Local-index operation; works without a live LINE session.",
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
  {
    description:
      "Return the user's style read as three layers, kept apart on purpose. `measured`: a compact DIGITAL TWIN card computed from the local index — tone/phrasing guide, message segmentation/bursting (how to split into multiple short messages), emoji habits, sticker habits (when to use, with top sticker_id/package_id to send via send_sticker), and a PERSONAL WRITING-STYLE read measured from the user's own sent messages: a discrete attribute table (ideational: where a concrete value sits relative to the action verb, how dates and amounts are written; interpersonal: speech-act distribution, the politeness-strategy position of requests (direct imperative vs. mitigation-fronted vs. conditional), the moves that reduce imposition, the source of reasons; textual: how messages are cut into units, field arrangement, and the transition relations between units), plus the user's own verbatim sentences, what they do NOT do, and the items the sample cannot support. These are MEASUREMENTS of a corpus, not instructions: the guide lines state what the sample shows, and the sample is a heuristic approximation. `rules`: writing rules a model wrote after reading the owner's own messages as evidence — each with the sentence it rests on, the situation it applies to, and the situation it does NOT apply to. When a rule and a measurement disagree, the rule wins. `vocabulary`: the conversation's terms split by who used them — `known_terms` the counterpart has used themselves, `unconfirmed_terms` only the owner has used, i.e. the things that can confuse someone who has never heard of them. ALWAYS call before drafting/composing/sending any LINE reply or message — matching the user's voice and messaging behavior is Yomi's default. Pass chat_id to get per-conversation nuances. Reads local index only (no network); needs collect_messages to have indexed user's sent messages.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'Optional: target conversation MID to include per-chat style nuances (segmentation/sticker habits can differ per chat).',
        },
      },
    },
    name: 'get_style_profile',
  },
  {
    description:
      "Read the evidence a style rule needs: the owner's own sent messages, quoted verbatim, each with the message it answered, plus the conversation's vocabulary split by who used which term. Yomi does not write rules itself — it has no voice of its own and runs no model. It hands you the sentences, and you decide what they show; write your conclusion back with add_style_rule so the next read starts from it. Use this before add_style_rule, and use it instead of guessing a rule from the statistics in get_style_profile.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'Optional: restrict to one conversation. Omit to read across conversations.',
        },
        limit: {
          type: 'number',
          description:
            'Optional: how many quoted messages to return (default 60).',
        },
      },
    },
    name: 'get_style_evidence',
  },
  {
    description:
      "Record a writing rule the owner follows, as you read it from their own messages. Every rule keeps the owner's sentence it rests on (`evidence`), the situation it applies to (`applies_when`), and the situation it does not apply to (`does_not_apply_when`) — a rule without its limits is how a measured statistic turns into a false instruction. Record a rule with `chat_id` to scope it to that conversation, without it to make it global. When a new rule contradicts an older one, pass the older `rule_id` in `supersedes`: the old rule stays in the history as superseded rather than being overwritten.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        statement: {
          type: 'string',
          description:
            'The rule itself, in your own words — what the owner does, not a statistic.',
        },
        evidence: {
          type: 'string',
          description:
            "The owner's own sentence the rule was read from, copied verbatim.",
        },
        applies_when: {
          type: 'string',
          description: 'Optional: the situation the rule applies to.',
        },
        does_not_apply_when: {
          type: 'string',
          description: 'Optional: the situation the rule does NOT apply to.',
        },
        counter_example: {
          type: 'string',
          description:
            "Optional: a case from the owner's own messages where the rule does not hold.",
        },
        chat_id: {
          type: 'string',
          description:
            'Optional: scope the rule to one conversation. Omit for a global rule.',
        },
        rule_id: {
          type: 'string',
          description:
            'Optional: a stable id for the rule. Re-using an id updates that rule in place.',
        },
        supersedes: {
          type: 'string',
          description:
            'Optional: the rule_id this rule replaces. The older one is kept as superseded.',
        },
        origin: {
          type: 'string',
          description:
            "Optional: 'stated' when the owner said the rule outright, 'derived' when you read it from their messages (default 'derived').",
        },
        confidence: {
          type: 'number',
          description:
            'Optional: your confidence in the rule, from 0 to 1 (default 0.5).',
        },
      },
    },
    name: 'add_style_rule',
  },
  {
    description:
      'Read the style rules in force, optionally including the superseded ones so the history of what was believed is still readable. Rules come back in two groups: global, and scoped to a conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: {
          type: 'string',
          description:
            'Optional: include the rules scoped to this conversation.',
        },
        include_superseded: {
          type: 'boolean',
          description:
            'Optional: also return rules that a later rule replaced (default false).',
        },
      },
    },
    name: 'get_style_rules',
  },
  {
    description:
      'Return a persona graph of the people in your conversations: the address form you use with each of them, the work you delegate to them, their most substantial line, and the roles that have been named for them. Reads the local index only. IMPORTANT: Yomi does not name roles itself — it has no role vocabulary and runs no model. It hands you the evidence, quoted, and you decide who each person is; write your conclusion back with add_persona_fact so the next read starts from it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description:
            'Optional: cap on how many indexed messages are read (default 20000).',
        },
      },
    },
    name: 'get_persona_graph',
  },
  {
    description:
      'Record what you concluded about a person from the persona evidence — for example "the hospital pharmacist" for someone whose address form is "Lin pharmacist" and whose delegated work is invoice processing. Yomi has no role vocabulary, so this is where your reading of the evidence becomes part of the graph. The quoted sentence you pass as evidence is kept, so a later reader can check the conclusion against the words it came from.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subject_name: {
          type: 'string',
          description:
            'The person\'s name, as it appears in the graph (e.g. "Lin Jialin"). Used to match the fact to a person.',
        },
        subject_mid: {
          type: 'string',
          description:
            "Optional: the person's LINE MID, when the graph gave you one. More reliable than the name.",
        },
        term: {
          type: 'string',
          description:
            'The role, in your own words (e.g. "hospital pharmacist", "wife", "company finance").',
        },
        category: {
          type: 'string',
          description:
            'Optional: family, household, workplace, professional, client, or other.',
        },
        evidence: {
          type: 'string',
          description:
            'The quoted sentence the conclusion rests on, copied verbatim from the evidence in the graph.',
        },
        origin: {
          type: 'string',
          description:
            "Optional: 'named' when you concluded it from the evidence (default), or 'stated' when the owner told you outright.",
        },
        instances: {
          type: 'number',
          description:
            'Optional: how many independent pieces of evidence back this (default 1).',
        },
        confidence: {
          type: 'number',
          description: 'Optional: confidence in [0,1] (default 0.5).',
        },
      },
      required: ['subject_name', 'term', 'evidence'],
    },
    name: 'add_persona_fact',
  },
  {
    description:
      'Read the persisted persona evidence directly: for each person, the address form you use with them, the work you delegate to them, and their most substantial line, all quoted. This reads what the background pass last collected, so it is cheaper than get_persona_graph and does not rescan the corpus. Use it when you need the evidence about specific people.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    name: 'get_persona_evidence',
  },
]
