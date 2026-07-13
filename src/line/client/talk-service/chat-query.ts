import { createCliLogger } from '../../../util/log.js'
import { buildGetChatsRequest } from './requests.js'

const GET_CHATS_BATCH_SIZE = 100
const lineLog = createCliLogger('LINE')

/**
 * Normalize bigint-like thrift scalars into numbers when possible.
 *
 * @param value - Raw thrift scalar.
 * @returns Parsed number or original fallback.
 */
function normalizeNumericValue(value: unknown): number | unknown | null {
  if (typeof value === 'bigint') {
    return Number(value)
  }
  return value || null
}

/**
 * Resolve the actual chat-array field from a getChats response.
 *
 * @param responseRoot - Root response payload.
 * @returns Raw chat array or null.
 */
export function findChatArray(
  responseRoot: Record<number, unknown> | null | undefined,
) {
  if (!responseRoot) {
    return null
  }

  const keys = Object.keys(responseRoot)
    .map(Number)
    .sort((a, b) => a - b)
  lineLog.debug('talk.get_chats.response', { keys: keys.join(',') })
  for (const key of keys) {
    const candidate = responseRoot[key] as unknown
    if (!Array.isArray(candidate)) {
      continue
    }
    if (candidate.length === 0 || typeof candidate[0] !== 'object') {
      continue
    }
    if (key !== 1) {
      lineLog.warn('talk.get_chats.field_mismatch', {
        actual_field: key,
        expected_field: 1,
      })
    }
    return candidate
  }

  return null
}

/**
 * Map one raw chat thrift struct into the app shape.
 *
 * @param chat - Raw chat thrift struct.
 * @returns Normalized chat or null.
 */
export function mapChatStruct(
  chat: Record<number, unknown> | null | undefined,
) {
  if (!chat || typeof chat !== 'object') {
    return null
  }
  return {
    type: chat[1] ?? null,
    chatMid: (chat[2] as string) || null,
    createdTime: normalizeNumericValue(chat[3]),
    notificationDisabled: Boolean(chat[4]),
    favoriteTimestamp: normalizeNumericValue(chat[5]),
    chatName: (chat[6] as string) || null,
    picturePath: (chat[7] as string) || null,
    extra: chat[8] || null,
  }
}

/**
 * Map a chat list, dropping invalid entries.
 *
 * @param chats - Raw chat list.
 * @returns Normalized chat list.
 */
export function mapChatList(chats: unknown): unknown[] {
  return Array.isArray(chats)
    ? chats
        .map((chat) => mapChatStruct(chat as Record<number, unknown>))
        .filter(Boolean)
    : []
}

/**
 * Fetch and normalize chats from TalkService.
 *
 * @param runtime - LINE client runtime.
 * @param syncReason - Talk sync reason constant.
 * @param chatMids - Requested chat MIDs.
 * @param withMembers - Whether to include members.
 * @returns Normalized chat list.
 */
export async function fetchChats(
  runtime: any,
  syncReason: number,
  chatMids: string[],
  withMembers = true,
): Promise<unknown[]> {
  if (!Array.isArray(chatMids) || chatMids.length === 0) {
    return []
  }
  if (chatMids.length > GET_CHATS_BATCH_SIZE) {
    const allChats: unknown[] = []
    for (
      let index = 0;
      index < chatMids.length;
      index += GET_CHATS_BATCH_SIZE
    ) {
      const batch = chatMids.slice(index, index + GET_CHATS_BATCH_SIZE)
      const chats = await fetchChats(runtime, syncReason, batch, withMembers)
      allChats.push(...chats)
    }
    return allChats
  }

  let result: any
  try {
    result = await runtime.sendTalk(
      'getChats',
      buildGetChatsRequest(chatMids, withMembers, syncReason),
    )
  } catch (error: any) {
    lineLog.error('talk.get_chats.failed', { error: error?.message || error })
    throw error
  }
  const response = result.fields?.[0]
  const chatStructs = findChatArray(response)
  if (chatStructs) {
    return mapChatList(chatStructs)
  }
  lineLog.warn('talk.get_chats.empty', {
    keys: response ? Object.keys(response).join(',') : 'null',
  })
  return []
}
