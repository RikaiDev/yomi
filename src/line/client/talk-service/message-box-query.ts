import type { ThriftFieldTuple } from '../../core/thrift/types.js';
import { createCliLogger } from '../../../util/log.js';
import { parseMessages } from '../parsers.js';

const lineLog = createCliLogger('LINE');

export interface MessageBoxListOptions {
  minChatId?: string;
  maxChatId?: string;
  activeOnly?: boolean;
  messageBoxCountLimit?: number;
  withUnreadCount?: boolean;
  lastMessagesPerMessageBoxCount?: number;
  unreadOnly?: boolean;
}

export interface PreviousMessagesRequest {
  messageBoxId: string;
  endMessageId?: {
    deliveredTime?: number;
    messageId?: string | number;
  };
  messagesCount: number;
  withReadCount?: boolean;
  receivedOnly?: boolean;
}

/**
 * Normalize bigint-like thrift scalars into numbers when possible.
 *
 * @param value - Raw thrift scalar.
 * @returns Parsed number or original fallback.
 */
function normalizeNumericValue(value: unknown): number | unknown | null {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value || null;
}

/**
 * Map one last-delivered-message cursor into the normalized shape.
 *
 * @param cursor - Raw cursor payload.
 * @returns Normalized cursor or null.
 */
function mapLastDeliveredMessageId(cursor: Record<number, unknown> | null | undefined) {
  if (!cursor || typeof cursor !== 'object') {
    return null;
  }

  return {
    deliveredTime: normalizeNumericValue(cursor[1]),
    messageId: cursor[2] != null ? String(cursor[2]) : null,
  };
}

/**
 * Build the request field array for getMessageBoxes.
 *
 * @param options - Listing options.
 * @returns Thrift request field tuples.
 */
export function buildMessageBoxRequest(options: MessageBoxListOptions = {}) {
  const request: ThriftFieldTuple[] = [];
  if (options.minChatId) {
    request.push([11, 1, options.minChatId]);
  }
  if (options.maxChatId) {
    request.push([11, 2, options.maxChatId]);
  }
  if (options.activeOnly != null) {
    request.push([2, 3, options.activeOnly]);
  }
  if (options.messageBoxCountLimit != null) {
    request.push([8, 4, options.messageBoxCountLimit]);
  }
  if (options.withUnreadCount != null) {
    request.push([2, 5, options.withUnreadCount]);
  }
  if (options.lastMessagesPerMessageBoxCount != null) {
    request.push([8, 6, options.lastMessagesPerMessageBoxCount]);
  }
  if (options.unreadOnly != null) {
    request.push([2, 7, options.unreadOnly]);
  }
  return request;
}

/**
 * Build the end-message cursor field list for previous-message requests.
 *
 * @param request - Previous-message request.
 * @returns Thrift field tuples.
 */
export function buildEndMessageIdFields(request: PreviousMessagesRequest) {
  const endMessageIdFields: ThriftFieldTuple[] = [];
  if (request?.endMessageId?.deliveredTime != null) {
    endMessageIdFields.push([10, 1, request.endMessageId.deliveredTime]);
  }
  if (request?.endMessageId?.messageId != null) {
    endMessageIdFields.push([10, 2, request.endMessageId.messageId]);
  }
  return endMessageIdFields;
}

/**
 * Map one raw message-box thrift struct into the app shape.
 *
 * @param box - Raw message-box thrift struct.
 * @returns Normalized message-box or null.
 */
function mapMessageBoxStruct(box: Record<number, unknown> | null | undefined) {
  if (!box || typeof box !== 'object') {
    return null;
  }
  return {
    id: (box[1] as string) || null,
    midType: box[2] ?? null,
    lastDeliveredMessageId: mapLastDeliveredMessageId(box[4] as Record<number, unknown>),
    unreadCount: normalizeNumericValue(box[6]) || 0,
    lastMessages: Array.isArray(box[7]) ? parseMessages(box[7]) : [],
  };
}

/**
 * Map a message-box list, dropping invalid entries.
 *
 * @param boxes - Raw message-box list.
 * @returns Normalized message-box list.
 */
export function mapMessageBoxList(boxes: unknown): unknown[] {
  return Array.isArray(boxes) ? boxes.map(box => mapMessageBoxStruct(box as Record<number, unknown>)).filter(Boolean) : [];
}

/**
 * Emit one debug log for previous-message responses.
 *
 * @param request - Previous-message request.
 * @param messages - Parsed messages.
 */
export function logPreviousMessagesResponse(request: PreviousMessagesRequest, messages: unknown[]): void {
  lineLog.debug('talk.get_previous_messages.response', {
    box: request.messageBoxId,
    count: request.messagesCount,
    parsed: messages.length,
  });
}

/**
 * Emit one debug log for recent-message responses.
 *
 * @param chatId - Chat MID.
 * @param count - Requested message count.
 * @param raw - Raw response payload.
 * @param messages - Parsed messages.
 */
export function logRecentMessagesResponse(chatId: string, count: number, raw: unknown, messages: unknown[]): void {
  lineLog.debug('talk.get_recent_messages.response', {
    chat: chatId,
    count,
    parsed: messages.length,
    raw_type: Array.isArray(raw) ? 'array' : typeof raw,
  });
}
