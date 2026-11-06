import type { LineProtocolService } from './service.js'

function messageTimestamp(message: any): number {
  return Number(message?.deliveredTime || message?.createdTime || 0)
}

/** Newest activity time of one message box, in epoch milliseconds. */
export function boxActivity(box: any): number {
  const cursorTime = Number(box?.lastDeliveredMessageId?.deliveredTime || 0)
  const lastTimes = Array.isArray(box?.lastMessages)
    ? box.lastMessages.map(messageTimestamp)
    : []
  return Math.max(cursorTime, ...lastTimes, 0)
}

/**
 * Every message box, most recently active first.
 *
 * LINE returns message boxes in chat-MID order (`c…` groups, then `m…`, then
 * `u…` 1:1 chats) and one page holds only the requested count, so a single
 * `getMessageBoxes` call is neither recent nor complete: it silently drops
 * every chat whose MID sorts past the page. Page through all of them, then
 * order by activity so a caller-supplied limit keeps the newest chats.
 */
export async function listBoxesByRecency(
  service: LineProtocolService,
  options: { withUnreadCount: boolean },
): Promise<any[]> {
  const result = await service.client.getAllMessageBoxes({
    lastMessagesPerMessageBoxCount: 1,
    withUnreadCount: options.withUnreadCount,
  })
  return [...(result.messageBoxes || [])].sort(
    (a: any, b: any) => boxActivity(b) - boxActivity(a),
  )
}
