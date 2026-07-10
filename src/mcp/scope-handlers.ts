/**
 * Yomi conversation-scoping MCP tool handlers — exclude_chats,
 * include_chats, list_excluded_chats, get_scope_policy.
 *
 * Split out from handlers.ts (mirrors the search-handlers.ts split) to keep
 * that file under the project's 500-scc-line module cap. These are
 * LOCAL-INDEX operations over the denylist in ../search/scope.ts: they read
 * and write the same search-index.db that ../search/collector.ts and
 * ../search/store.ts own, and never require a live LINE session except to
 * best-effort resolve display names in list_excluded_chats/get_scope_policy.
 */

import type { LineProtocolService } from '../line/core/service.js';
import { addExcludedChatIds, deleteMessagesForChats, getExcludedChatIds, removeExcludedChatIds } from '../search/scope.js';
import { toolError } from './handlers.js';
import { resolveConversationNames } from './names.js';
import { getPrivacyPolicyText } from './policy.js';

/** One excluded conversation with its best-effort resolved display name. */
interface ExcludedChat {
  chatId: string;
  name: string | null;
}

/**
 * Read the current exclusion denylist and pair each chatId with a
 * best-effort display name. Name resolution only runs when a live LINE
 * session exists (`service.client`); without one, or when a name is
 * otherwise unresolvable, `name` is `null` rather than a fabricated
 * placeholder. Shared by list_excluded_chats and get_scope_policy so the
 * two never drift.
 *
 * @param service - LineProtocolService; `service.client` is used only for
 *   name resolution and may be absent.
 * @returns Excluded conversations, each `{ chatId, name }`.
 */
async function listExcludedChatsWithNames(service: LineProtocolService): Promise<ExcludedChat[]> {
  const chatIds = Array.from(getExcludedChatIds());
  if (chatIds.length === 0) {
    return [];
  }
  const names = service.client
    ? await resolveConversationNames(service, chatIds)
    : new Map<string, string | null>();
  return chatIds.map(chatId => ({ chatId, name: names.get(chatId) ?? null }));
}

/**
 * Handle `exclude_chats` — add chatIds to the scoping denylist AND purge
 * their already-indexed messages/embeddings. Both effects happen together:
 * excluding a chat is meant to remove what Yomi already learned about it,
 * not just stop learning more (see ../search/scope.ts).
 *
 * @param args - Tool arguments.
 * @returns MCP tool result with `{ excluded, purgedMessages }`.
 */
export async function handleExcludeChats(args: { chatIds?: string[] }) {
  if (!args.chatIds || args.chatIds.length === 0) {
    return toolError('chatIds is required and must be a non-empty array.');
  }
  const excluded = addExcludedChatIds(args.chatIds);
  const purgedMessages = deleteMessagesForChats(args.chatIds);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ excluded, purgedMessages }, null, 2) }],
  };
}

/**
 * Handle `include_chats` — remove chatIds from the scoping denylist,
 * re-allowing future capture. Does NOT re-fetch or restore any previously
 * purged data; the next `collect_messages`/`search_messages` auto-collect
 * picks the chat back up going forward.
 *
 * @param args - Tool arguments.
 * @returns MCP tool result with `{ included }`.
 */
export async function handleIncludeChats(args: { chatIds?: string[] }) {
  if (!args.chatIds || args.chatIds.length === 0) {
    return toolError('chatIds is required and must be a non-empty array.');
  }
  const included = removeExcludedChatIds(args.chatIds);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ included }, null, 2) }],
  };
}

/**
 * Handle `list_excluded_chats` — the current scoping denylist, with
 * best-effort display-name resolution when a live LINE session exists.
 * Without a session (or when a name is otherwise unresolvable), `name` is
 * `null` rather than a fabricated placeholder.
 *
 * @param service - LineProtocolService; `service.client` is used only for
 *   name resolution and may be absent.
 * @returns MCP tool result with `[{ chatId, name }]`.
 */
export async function handleListExcludedChats(service: LineProtocolService) {
  const result = await listExcludedChatsWithNames(service);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Handle `get_scope_policy` — return Yomi's data-capture privacy policy (the
 * disclosure the agent should surface to the user) alongside the current
 * exclusion list. The policy prose comes from the canonical PRIVACY.md via
 * getPrivacyPolicyText (single source of truth — never duplicated here).
 * Reuses the same best-effort name resolution as list_excluded_chats via
 * listExcludedChatsWithNames, so names appear only when a live LINE session
 * exists, else `null`.
 *
 * @param service - LineProtocolService; `service.client` is used only for
 *   name resolution and may be absent.
 * @returns MCP tool result with `{ policy, excludedChats }`.
 */
export async function handleGetScopePolicy(service: LineProtocolService) {
  const excludedChats = await listExcludedChatsWithNames(service);
  const result = {
    policy: getPrivacyPolicyText(),
    excludedChats,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
