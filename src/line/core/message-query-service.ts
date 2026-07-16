import { requireLineClient } from './client-runtime.js'

/**
 * Infer the LINE conversation type from a stable chat MID.
 *
 * @param chatId - LINE chat, room, or user MID.
 * @returns LINE toType value when inferable.
 */
function inferLineToType(chatId: string | null): number | null {
  if (!chatId) {
    return null
  }
  if (chatId.startsWith('u')) {
    return 0
  }
  if (chatId.startsWith('c')) {
    return 1
  }
  if (chatId.startsWith('r')) {
    return 2
  }
  return null
}

/**
 * Attach the canonical LINE chat context required by E2EE decrypt.
 *
 * @param message - Raw LINE message payload.
 * @param chatId - Requested LINE chat MID.
 * @returns Message with stable chat context.
 */
export function normalizeLineMessageContext(
  message: any,
  chatId: string | null = null,
): any {
  const resolvedChatId = message?.chatMid || chatId || null
  const inferredToType = inferLineToType(resolvedChatId)
  return {
    ...message,
    chatMid: resolvedChatId || message?.chatMid,
    toType: message?.toType ?? inferredToType ?? message?.toType,
  }
}

/**
 * Build stable diagnostics for one failed E2EE decrypt attempt.
 *
 * @param decrypted - E2EE decrypt result.
 * @param taggedMessage - Message with canonical LINE context.
 * @returns Diagnostic metadata.
 */
function buildE2EEDecryptFailure(
  decrypted: any,
  taggedMessage: any,
): Record<string, unknown> {
  return {
    error: decrypted.error || null,
    envelopeInfo: decrypted.envelopeInfo || null,
    isSelf: decrypted.isSelf ?? null,
    isUserChat: decrypted.isUserChat ?? null,
    reason: decrypted.reason || 'decrypt_failed',
    receiverKeyId: decrypted.receiverKeyId ?? null,
    senderKeyId: decrypted.senderKeyId ?? null,
    toType: decrypted.toType ?? taggedMessage.toType ?? null,
  }
}

/**
 * Decrypt one LINE message through the service-owned E2EE manager.
 *
 * @param e2eeManager - LINE E2EE manager.
 * @param message - Raw LINE message payload.
 * @param chatId - Optional chat id to attach to the message.
 * @returns Message with decrypted text flags when available.
 */
export async function decryptLineMessage(
  e2eeManager: any,
  message: any,
  chatId: string | null = null,
): Promise<any> {
  const taggedMessage = normalizeLineMessageContext(message, chatId)
  if (!e2eeManager?.tryDecrypt) {
    return taggedMessage
  }

  const decrypted = await e2eeManager.tryDecrypt(taggedMessage)
  if (decrypted.decrypted) {
    return {
      ...taggedMessage,
      e2eeDecrypted: true,
      // Surfaced so a caller can distinguish "we could read it" from "we can
      // vouch for it". V1 messages decrypt without any integrity check, so a
      // tampered one is indistinguishable from a genuine one at this layer.
      e2eeIntegrityVerified: decrypted.integrityVerified !== false,
      text: decrypted.text,
    }
  }
  if (taggedMessage?.contentMetadata?.e2eeVersion && !taggedMessage.text) {
    return {
      ...taggedMessage,
      e2eeDecrypted: false,
      e2eeDecryptFailure: buildE2EEDecryptFailure(decrypted, taggedMessage),
    }
  }
  return taggedMessage
}

/**
 * Decrypt a LINE message batch through the service-owned E2EE manager.
 *
 * @param e2eeManager - LINE E2EE manager.
 * @param messages - Raw LINE message payloads.
 * @param chatId - Optional chat id to attach to each message.
 * @returns Messages with decrypted text flags when available.
 */
export async function decryptLineMessages(
  e2eeManager: any,
  messages: any[],
  chatId: string | null = null,
): Promise<any[]> {
  return Promise.all(
    messages.map((message) => decryptLineMessage(e2eeManager, message, chatId)),
  )
}

/**
 * Build the LINE message query boundary for a connected runtime.
 *
 * @param getClient - Deferred LINE client accessor
 * @param e2eeManager - LINE E2EE manager
 * @returns Message query methods
 */
export function createMessageQueryService(getClient, e2eeManager) {
  return {
    /**
     * Fetch recent messages and opportunistically decrypt E2EE payloads.
     *
     * @param chatId - LINE chat MID
     * @param count - Maximum number of messages to fetch
     * @returns Recent LINE messages
     */
    async getRecentMessages(chatId, count = 50) {
      const messages = await requireLineClient(getClient).getRecentMessages(
        chatId,
        count,
      )
      return decryptLineMessages(e2eeManager, messages, chatId)
    },

    /**
     * Fetch one page of messages older than a cursor and opportunistically
     * decrypt E2EE payloads. Fetches exactly one page — no pagination loop.
     *
     * @param chatId - LINE chat MID
     * @param count - Maximum number of messages to fetch
     * @param before - Cursor identifying the oldest already-seen message (messageId and/or deliveredTime)
     * @returns Previous LINE messages, older than the cursor
     */
    async getPreviousMessages(
      chatId,
      count = 50,
      before: { messageId?: string; deliveredTime?: number } = {},
    ) {
      const messages = await requireLineClient(
        getClient,
      ).getPreviousMessagesV2WithRequest({
        endMessageId: before,
        messageBoxId: chatId,
        messagesCount: count,
      })
      return decryptLineMessages(e2eeManager, messages, chatId)
    },

    /**
     * Download the original LINE content bytes for one message.
     *
     * @param messageId - LINE message identifier
     * @param requestId - Optional request identifier
     * @returns Original message content bytes
     */
    async downloadMessageContent(messageId, requestId = `yomi-${Date.now()}`) {
      return requireLineClient(getClient).downloadMessageContent(
        messageId,
        requestId,
      )
    },

    /**
     * Download the LINE preview bytes for one message.
     *
     * @param messageId - LINE message identifier
     * @param requestId - Optional request identifier
     * @returns Preview content bytes
     */
    async downloadMessageContentPreview(
      messageId,
      requestId = `yomi-${Date.now()}`,
    ) {
      return requireLineClient(getClient).downloadMessageContentPreview(
        messageId,
        requestId,
      )
    },
  }
}
