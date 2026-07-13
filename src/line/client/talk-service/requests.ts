import { CONTENT_TYPE } from '../../core/constants.js'
import {
  boolField,
  byteField,
  i32Field,
  listField,
  mapField,
  stringField,
  structField,
} from '../../core/thrift/index.js'

/**
 * Normalize sendMessage inputs into one consistent options object.
 *
 * @param to - Recipient chat id or options object.
 * @param text - Legacy text argument.
 * @returns Normalized message options.
 */
export function normalizeSendMessageOptions(to, text) {
  if (typeof to === 'object' && to !== null) {
    return {
      to: to.to,
      text: to.text,
      contentType: to.contentType ?? CONTENT_TYPE.NONE,
      contentMetadata: to.contentMetadata ?? {},
      chunks: to.chunks ?? null,
      relatedMessageId: to.relatedMessageId ?? null,
      location: to.location ?? null,
    }
  }

  return {
    to,
    text,
    contentType: CONTENT_TYPE.NONE,
    contentMetadata: {},
    chunks: null,
    relatedMessageId: null,
    location: null,
  }
}

/**
 * Build the sendMessage nested payload fields.
 *
 * @param options - Normalized send-message options.
 * @returns Thrift struct fields.
 */
export function buildSendMessagePayload(options) {
  const fields = [stringField(2, options.to), i32Field(15, options.contentType)]

  if (options.text != null) {
    fields.push(stringField(10, options.text))
  }
  if (
    options.contentMetadata &&
    Object.keys(options.contentMetadata).length > 0
  ) {
    fields.push(mapField(18, 11, 11, options.contentMetadata))
  }
  if (Array.isArray(options.chunks)) {
    fields.push(listField(20, 11, options.chunks))
  }
  if (options.relatedMessageId) {
    fields.push(stringField(21, options.relatedMessageId))
  }
  if (options.location) {
    fields.push(structField(11, options.location))
  }

  return fields
}

/**
 * Build the sendMessage request fields.
 *
 * @param options - Normalized send-message options.
 * @returns Thrift request fields.
 */
export function buildSendMessageRequest(options) {
  return [i32Field(1, 0), structField(2, buildSendMessagePayload(options))]
}

/**
 * Build the getAllChatMids request fields.
 *
 * @param syncReason - Talk sync reason constant.
 * @returns Thrift request fields.
 */
export function buildGetAllChatMidsRequest(syncReason) {
  return [
    structField(1, [boolField(1, true), boolField(2, true)]),
    i32Field(2, syncReason),
  ]
}

/**
 * Build the getChats request fields.
 *
 * @param chatMids - Requested chat MIDs.
 * @param withMembers - Whether to include members.
 * @param syncReason - Talk sync reason constant.
 * @returns Thrift request fields.
 */
export function buildGetChatsRequest(chatMids, withMembers, syncReason) {
  return [
    structField(1, [
      listField(1, 11, chatMids),
      boolField(2, withMembers),
      boolField(3, true),
    ]),
    i32Field(2, syncReason),
  ]
}

/**
 * Build the getMessageBoxes request fields.
 *
 * @param request - Message-box request payload.
 * @param syncReason - Talk sync reason constant.
 * @returns Thrift request fields.
 */
export function buildGetMessageBoxesRequest(request, syncReason) {
  return [structField(2, request), i32Field(3, syncReason)]
}

/**
 * Build the getPreviousMessagesV2WithRequest request fields.
 *
 * @param request - Previous-message request payload.
 * @param endMessageIdFields - Cursor struct fields.
 * @param syncReason - Talk sync reason constant.
 * @returns Thrift request fields.
 */
export function buildPreviousMessagesRequest(
  request,
  endMessageIdFields,
  syncReason,
) {
  return [
    structField(2, [
      stringField(1, request.messageBoxId),
      structField(2, endMessageIdFields),
      i32Field(3, request.messagesCount),
      boolField(4, Boolean(request.withReadCount)),
      boolField(5, Boolean(request.receivedOnly)),
    ]),
    i32Field(3, syncReason),
  ]
}

/**
 * Build the getRecentMessagesV2 request fields.
 *
 * @param chatId - Target chat MID.
 * @param count - Maximum number of messages.
 * @returns Thrift request fields.
 */
export function buildRecentMessagesRequest(chatId, count) {
  return [stringField(2, chatId), i32Field(3, count)]
}

/**
 * Build a message-content download request.
 *
 * @param requestId - Client request identifier.
 * @param messageId - LINE message identifier.
 * @returns Thrift request fields.
 */
export function buildDownloadMessageContentRequest(requestId, messageId) {
  return [stringField(1, requestId), stringField(2, messageId)]
}

/**
 * Build a single-MID lookup request.
 *
 * @param mid - Target MID.
 * @returns Thrift request fields.
 */
export function buildMidLookupRequest(mid) {
  return [stringField(2, mid)]
}

/**
 * Build a multi-MID lookup request.
 *
 * @param mids - Target MIDs.
 * @returns Thrift request fields.
 */
export function buildMidListRequest(mids) {
  return [listField(2, 11, mids)]
}

/**
 * Build the getAllContactIds request fields.
 *
 * @returns Thrift request fields.
 */
export function buildGetAllContactIdsRequest() {
  return [i32Field(1, 0)]
}

/**
 * Build the sendChatChecked request fields.
 *
 * @param chatMid - Chat MID to mark read.
 * @param lastMessageId - Message id to mark read up to.
 * @param sessionId - Client session id (default 0).
 * @returns Thrift request fields.
 */
export function buildSendChatCheckedRequest(
  chatMid,
  lastMessageId,
  sessionId = 0,
) {
  return [
    i32Field(1, 0),
    stringField(2, chatMid),
    stringField(3, lastMessageId),
    byteField(4, sessionId),
  ]
}
