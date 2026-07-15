/**
 * Yomi MCP server — LINE query + reply surface over stdio.
 *
 * On startup resumes any persisted LINE session. Exposes twenty-one tools:
 * login, login_complete, list_conversations, get_chat_messages,
 * get_message_image, get_message_media, get_unread_digest, mark_read,
 * send_message, send_image, send_file, send_contact, find_contact,
 * list_contacts, get_group_members, collect_messages, search_messages,
 * exclude_chats, include_chats, list_excluded_chats, get_scope_policy.
 *
 * find_contact/list_contacts/get_group_members expose LINE's raw
 * people/membership data only — no affinity scoring, no interaction-
 * frequency ranking, no relationship-graph computation. That
 * intelligence layer belongs to the host app, not this server.
 *
 * collect_messages/search_messages add cross-conversation search (LINE has
 * no such primitive): collect_messages explicitly fetches and indexes
 * recent messages locally (see ../search/), embedding them for semantic
 * search along the way; search_messages ranks by cosine similarity when
 * vectors exist, falling back to FTS5 keyword search otherwise. No
 * relationship graph, no affinity scoring either way.
 *
 * exclude_chats/include_chats/list_excluded_chats manage a scoping
 * DENYLIST (see ../search/scope.ts): excluded chats are skipped by
 * collect_messages and have their already-indexed data purged, not just
 * filtered at query time. These are local-index operations too, so they
 * work without a live LINE session (list_excluded_chats degrades its name
 * resolution gracefully when there is none).
 *
 * Hard rules:
 *   - `login`/`login_complete` are the only tools callable without a live
 *     session; together they drive the passwordless flow and persist the
 *     result. Two calls are needed only on MCP clients that don't support
 *     elicitation (confirmed empirically for Claude Desktop) — `login`
 *     starts the flow and returns the PIN as a visible tool result instead
 *     of blocking, then `login_complete` finishes it once the human has
 *     acted on their phone; clients with elicitation get the original
 *     single-call flow via `login` alone. `search_messages` also runs
 *     without a live session, reading the local index as-is (with a live
 *     session it also auto-collects a first-time empty index).
 *     `exclude_chats`/`include_chats`/`list_excluded_chats` are local-index
 *     operations and likewise run without a live session.
 *     Every other tool returns a clear error until a session exists.
 *   - Runs a background capture loop (see ../search/capture.ts): on startup
 *     it starts LINE's poll loop and indexes new incoming messages into the
 *     local search index. This is SILENT — SYNC4 sync never sends read
 *     receipts — and denylist-gated. It never sends messages and never
 *     marks anything read. The only read-receipt path is the explicit
 *     mark_read tool and the auto-read that follows a successful
 *     send_message/send_image/send_file (replying implies reading).
 *   - `send_message`/`send_image`/`send_file` perform exactly one real,
 *     E2EE-encrypted send per call — no auto-send, no retry loop, no
 *     background send. Each also best-effort sends a read receipt for that
 *     chat after a successful send (see the `read` field in the response).
 *
 * Tool handler bodies live in handlers.ts/search-handlers.ts and the tool
 * schema list lives in tools.ts, to keep this file, the wiring/dispatch
 * surface, under the project's 200-scc-line cap for MCP server files.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Mention } from '../line/core/mention.js'
import { LineProtocolService } from '../line/core/service.js'
import { startCapture } from '../search/capture.js'
import { getDefaultEmbedder } from '../search/default-embedder.js'
import { createCliLogger } from '../util/log.js'
import { YOMI_VERSION } from '../version.js'
import {
  handleFindContact,
  handleGetChatMessages,
  handleGetGroupMembers,
  handleGetMessageImage,
  handleGetMessageMedia,
  handleGetUnreadDigest,
  handleListContacts,
  handleListConversations,
  handleMarkRead,
  handleSendContact,
  handleSendFile,
  handleSendImage,
  handleSendMessage,
  NO_CREDENTIALS_MESSAGE,
  sessionRequiredError,
  toolError,
} from './handlers.js'
import { handleLogin, handleLoginComplete } from './handlers-login.js'
import { getPrivacyPolicyText } from './policy.js'
import {
  handleExcludeChats,
  handleGetScopePolicy,
  handleIncludeChats,
  handleListExcludedChats,
} from './scope-handlers.js'
import {
  handleCollectMessages,
  handleSearchMessages,
} from './search-handlers.js'
import { TOOLS } from './tools.js'
import { supportsMcpApps } from './ui/capability.js'
import {
  LOGIN_UI_RESOURCE_CONTENTS,
  LOGIN_UI_RESOURCE_LISTING,
  LOGIN_UI_RESOURCE_URI,
} from './ui/resource.js'
import { toolsForClient } from './ui/tools-with-ui.js'

const log = createCliLogger('Yomi')

/**
 * Build and start the Yomi MCP server over stdio.
 */
async function main(): Promise<void> {
  const service = new LineProtocolService()
  // A Node EventEmitter with zero 'error' listeners turns any emit('error')
  // into an uncaught exception that kills this process (see pwless-login-flow.ts,
  // auth-session-service.ts). This listener must exist for the lifetime of the
  // service so a login/session error surfaces as a log line, not a crash — the
  // real failure still reaches callers through the normal throw/rejection path.
  service.on('error', (error: any) =>
    log.warn('service.error', { error: error?.message ?? String(error) }),
  )
  const resumed = await service.resumeSession()
  if (!resumed) {
    log.warn('session.resume_failed', { message: NO_CREDENTIALS_MESSAGE })
  } else {
    log.info('session.resumed', { mid: service.profile?.mid ?? null })
    startCapture(service, getDefaultEmbedder()).catch((error: any) => {
      log.error('capture.start_failed', {
        error: error?.message ?? String(error),
      })
    })
  }

  // `instructions` is surfaced by the MCP SDK to the client/model on
  // initialize — a "TOS on connect" privacy disclosure. It is a consent
  // notice, not decoration. A short model directive precedes the canonical
  // policy prose, which lives ONLY in PRIVACY.md (see ./policy.ts) so the
  // disclosure is single-sourced and never drifts from get_scope_policy.
  const instructions =
    'PRIVACY DISCLOSURE (say ONCE per session) — the first time this session ' +
    'does a bulk read (collect_messages/search_messages), tell the user once, in ' +
    'plain language, that Yomi captures all conversations by default, keeps the data ' +
    'on this machine, and that they can exclude conversations. Do not bury it, and do ' +
    'NOT repeat it on every call — once per session is enough. The full policy text ' +
    'is included below, so you do NOT need to call get_scope_policy just to recite the ' +
    'policy; call get_scope_policy only when the user asks to see the policy again or ' +
    'wants the current exclusion list. Policy follows:\n\n' +
    getPrivacyPolicyText()

  const server = new Server(
    { name: 'yomi', version: YOMI_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions },
  )

  // Ground truth for whether a connected client actually supports
  // elicitation (needed by the `login` tool) — observe it, don't assume it.
  server.oninitialized = () => {
    const capabilities = server.getClientCapabilities()
    log.info('client.capabilities', {
      capabilities: JSON.stringify(capabilities ?? null),
    })
  }

  // MCP Apps UI resource (the `login` view) is only advertised to clients
  // that negotiated support for it (see ./ui/capability.ts) — a client
  // without it must see `resources/list` return empty and `login`'s schema
  // stay byte-for-byte what it always was.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const supportsUi = supportsMcpApps(server.getClientCapabilities())
    const count = supportsUi ? 1 : 0
    log.info('resources.list', { supportsUi, count })
    return { resources: supportsUi ? [LOGIN_UI_RESOURCE_LISTING] : [] }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    log.info('resources.read', { uri: request.params.uri })
    if (request.params.uri !== LOGIN_UI_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${request.params.uri}`)
    }
    return { contents: [LOGIN_UI_RESOURCE_CONTENTS] }
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const supportsUi = supportsMcpApps(server.getClientCapabilities())
    return { tools: toolsForClient(TOOLS, supportsUi) }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    // `login` is the one tool allowed without an existing session — it is
    // how a session gets created. `search_messages` also runs without a
    // live session: it reads the local search index (and, when a session
    // does exist, auto-collects a first-time empty index). exclude_chats/
    // include_chats/list_excluded_chats are local-index scoping operations
    // over ../search/scope.ts and likewise need no live client (list's name
    // resolution just degrades to null without one). Everything else needs
    // a live client.
    const noSessionExempt =
      name === 'login' ||
      name === 'login_complete' ||
      name === 'search_messages' ||
      name === 'exclude_chats' ||
      name === 'include_chats' ||
      name === 'list_excluded_chats' ||
      name === 'get_scope_policy'
    if (!noSessionExempt && !service.client) {
      return sessionRequiredError()
    }

    try {
      switch (name) {
        case 'login':
          return await handleLogin(
            server,
            service,
            (args ?? {}) as { phone?: string; region?: string },
          )
        case 'login_complete':
          return await handleLoginComplete()
        case 'list_conversations':
          return await handleListConversations(
            service,
            (args ?? {}) as { limit?: number },
          )
        case 'get_chat_messages':
          return await handleGetChatMessages(
            service,
            (args ?? {}) as {
              chatId: string
              count?: number
              before?: { messageId?: string; deliveredTime?: number }
            },
          )
        case 'get_message_image':
          return await handleGetMessageImage(
            service,
            (args ?? {}) as {
              chatId: string
              messageId: string
              preview?: boolean
            },
          )
        case 'get_message_media':
          return await handleGetMessageMedia(
            service,
            (args ?? {}) as {
              chatId: string
              messageId: string
              preview?: boolean
            },
          )
        case 'get_unread_digest':
          return await handleGetUnreadDigest(
            service,
            (args ?? {}) as { perChat?: number; limit?: number },
          )
        case 'mark_read':
          return await handleMarkRead(
            service,
            (args ?? {}) as { chatId: string; messageId?: string },
          )
        case 'send_message':
          return await handleSendMessage(
            service,
            (args ?? {}) as {
              chatId: string
              text: string
              mentions?: Mention[]
            },
          )
        case 'send_image':
          return await handleSendImage(
            service,
            (args ?? {}) as {
              chatId: string
              imagePath?: string
              imageBase64?: string
            },
          )
        case 'send_file':
          return await handleSendFile(
            service,
            (args ?? {}) as {
              chatId: string
              filePath?: string
              fileBase64?: string
              fileName?: string
            },
          )
        case 'send_contact':
          return await handleSendContact(
            service,
            (args ?? {}) as {
              chatId: string
              contactMid: string
              displayName?: string
            },
          )
        case 'find_contact':
          return await handleFindContact(
            service,
            (args ?? {}) as { name: string },
          )
        case 'list_contacts':
          return await handleListContacts(service)
        case 'get_group_members':
          return await handleGetGroupMembers(
            service,
            (args ?? {}) as { chatId: string },
          )
        case 'collect_messages':
          return await handleCollectMessages(
            service,
            (args ?? {}) as { chatIds?: string[]; perChat?: number },
          )
        case 'search_messages':
          return await handleSearchMessages(
            service,
            (args ?? {}) as { query: string; limit?: number },
          )
        case 'exclude_chats':
          return await handleExcludeChats(
            (args ?? {}) as { chatIds?: string[] },
          )
        case 'include_chats':
          return await handleIncludeChats(
            (args ?? {}) as { chatIds?: string[] },
          )
        case 'list_excluded_chats':
          return await handleListExcludedChats(service)
        case 'get_scope_policy':
          return await handleGetScopePolicy(service)
        default:
          return toolError(`Unknown tool: ${name}`)
      }
    } catch (error: any) {
      log.error('tool.failed', {
        error: error?.message ?? String(error),
        tool: name,
      })
      return toolError(error?.message ?? String(error))
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log.info('server.started', { tools: TOOLS.length })
}

main().catch((error) => {
  log.error('server.fatal', { error: error?.message ?? String(error) })
  process.exit(1)
})
