/**
 * LINE core chat/runtime capability — Yomi read-only + explicit-send subset.
 *
 * Yomi is primarily a pure query server: it exposes message read/download
 * methods, plus one explicit, always-E2EE `sendMessage` write path used only
 * by the `send_message` MCP tool. Capabilities this module intentionally
 * does NOT carry over are: startPolling (continuous read-state mutation),
 * scanChats / fetchRecentMessages (bulk backfill scanning),
 * recoverE2EEContext, and createBackfillAdapter (pipeline-facing, depends
 * on a backfill-adapter module that was not extracted). See
 * yomi/README.md for the full extraction rationale.
 */

import { createMessageCommandService } from './message-command-service.js'
import { createMessageQueryService } from './message-query-service.js'

/**
 * Create the chat/runtime capability bound to one LINE protocol service.
 *
 * @param service - Mutable LINE protocol service runtime.
 * @returns Chat/runtime methods.
 */
export function createChatRuntimeService(service: any) {
  return {
    /**
     * Send one plain-text LINE message, always E2EE-encrypted through the
     * explicit message-command boundary. There is no plaintext-send path:
     * the caller-facing `send_message` tool only ever reaches this method,
     * and this method only ever asks for `{ e2ee: true }`. If the E2EE key
     * material cannot be resolved (peer negotiation or group key fetch
     * fails), the underlying encrypt call throws and no request reaches
     * LINE — never a silent plaintext fallback.
     *
     * @param to - Recipient chat MID (1:1 `u...` or group/room `c.../r...`).
     * @param text - Plain-text message body.
     * @param contentMetadata - Optional extra contentMetadata to merge in
     * alongside the E2EE markers — e.g. an outbound `MENTION` payload built
     * via `../mention.ts`. Never part of the encrypted chunks; see the
     * JSDoc on message-command-service.ts's `sendMessage` E2EE branch.
     * @returns LINE sendMessage result (includes the sent message id).
     */
    async sendMessage(
      to: string,
      text: string,
      contentMetadata?: Record<string, string>,
      reply?: {
        relatedMessageId: string
        messageRelationType: number
        relatedMessageServiceCode?: number
      },
    ): Promise<any> {
      return createMessageCommandService(
        () => service.client,
        service.e2eeManager,
      ).sendMessage(to, {
        e2ee: true,
        text,
        contentMetadata,
        relatedMessageId: reply?.relatedMessageId ?? null,
        messageRelationType: reply?.messageRelationType ?? null,
        relatedMessageServiceCode: reply?.relatedMessageServiceCode ?? null,
      })
    },

    /**
     * Send one 1:1 E2EE image, always through the explicit
     * upload-then-send message-command boundary. There is no plaintext or
     * unencrypted-upload path: if the E2EE key material cannot be
     * resolved, or the OBS upload is rejected, the underlying call throws
     * and no message reaches LINE.
     *
     * @param to - Recipient chat MID (1:1 `u...`).
     * @param imageBytes - Raw (plaintext) image bytes to send.
     * @param fileName - Original filename, used to derive the extension.
     * @returns `{ sent, messageId, oid }` describing the delivered image.
     */
    async sendImage(
      to: string,
      imageBytes: Buffer,
      fileName: string | null,
    ): Promise<any> {
      return createMessageCommandService(
        () => service.client,
        service.e2eeManager,
      ).sendImage(to, imageBytes, fileName)
    },

    /**
     * Send one E2EE file attachment through the shared media-send pipeline.
     *
     * @param to - Recipient chat MID.
     * @param fileBytes - Raw (plaintext) file bytes to send.
     * @param fileName - Original filename (sealed E2EE for the recipient).
     * @returns `{ sent, messageId, oid }` describing the delivered file.
     */
    async sendFile(
      to: string,
      fileBytes: Buffer,
      fileName: string,
    ): Promise<any> {
      return createMessageCommandService(
        () => service.client,
        service.e2eeManager,
      ).sendFile(to, fileBytes, fileName)
    },

    /**
     * Send one E2EE audio message through the shared media-send pipeline.
     *
     * @param to - Recipient chat MID.
     * @param audioBytes - Raw (plaintext) audio bytes.
     * @param fileName - Original filename (for the OBS upload name).
     * @param durationMs - Audio duration in ms, when known.
     * @returns `{ sent, messageId, oid }` describing the delivered audio.
     */
    async sendAudio(
      to: string,
      audioBytes: Buffer,
      fileName: string | null,
      durationMs?: number,
    ): Promise<any> {
      return createMessageCommandService(
        () => service.client,
        service.e2eeManager,
      ).sendAudio(to, audioBytes, fileName, durationMs)
    },

    /**
     * Share a LINE contact card (contentType CONTACT) — not media.
     *
     * @param to - Recipient chat MID.
     * @param contactMid - MID of the person whose card is shared.
     * @param displayName - Display name shown on the card.
     * @returns `{ sent, messageId }` describing the delivered card.
     */
    async sendContact(
      to: string,
      contactMid: string,
      displayName: string,
    ): Promise<any> {
      return createMessageCommandService(
        () => service.client,
        service.e2eeManager,
      ).sendContact(to, contactMid, displayName)
    },

    /**
     * Send a LINE sticker (contentType STICKER) — not media.
     *
     * @param to - Recipient chat MID.
     * @param stickerId - Sticker id (STKID).
     * @param packageId - Sticker package id (STKPKGID).
     * @param version - Sticker version (STKVER).
     * @returns `{ sent, messageId }` describing the delivered sticker.
     */
    async sendSticker(
      to: string,
      stickerId: string,
      packageId: string,
      version?: string,
    ): Promise<any> {
      return createMessageCommandService(
        () => service.client,
        service.e2eeManager,
      ).sendSticker(to, stickerId, packageId, version)
    },

    /**
     * Send a location message (contentType LOCATION) — not media, not E2EE.
     *
     * @param to - Recipient chat MID.
     * @param latitude - Latitude.
     * @param longitude - Longitude.
     * @param title - Optional place name.
     * @param address - Optional address.
     * @returns `{ sent, messageId }` describing the delivered location.
     */
    async sendLocation(
      to: string,
      latitude: number,
      longitude: number,
      title?: string,
      address?: string,
    ): Promise<any> {
      return createMessageCommandService(
        () => service.client,
        service.e2eeManager,
      ).sendLocation(to, latitude, longitude, title, address)
    },

    /**
     * Fetch recent LINE messages through the explicit message-query boundary.
     *
     * @param chatId - LINE chat MID.
     * @param count - Maximum number of messages.
     * @returns Recent LINE messages.
     */
    async getRecentMessages(chatId: string, count = 50): Promise<any[]> {
      return createMessageQueryService(
        () => service.client,
        service.e2eeManager,
      ).getRecentMessages(chatId, count)
    },

    /**
     * Fetch one page of LINE messages older than a cursor.
     *
     * @param chatId - LINE chat MID.
     * @param count - Maximum number of messages.
     * @param before - Cursor identifying the oldest already-seen message.
     * @returns Previous LINE messages, older than the cursor.
     */
    async getPreviousMessages(
      chatId: string,
      count = 50,
      before: { messageId?: string; deliveredTime?: number } = {},
    ): Promise<any[]> {
      return createMessageQueryService(
        () => service.client,
        service.e2eeManager,
      ).getPreviousMessages(chatId, count, before)
    },

    /**
     * Download the original LINE content bytes for one message.
     *
     * @param messageId - LINE message identifier.
     * @param requestId - Optional request identifier.
     * @returns Original message content bytes.
     */
    async downloadMessageContent(
      messageId: string,
      requestId?: string,
    ): Promise<Buffer> {
      return createMessageQueryService(
        () => service.client,
        service.e2eeManager,
      ).downloadMessageContent(messageId, requestId)
    },

    /**
     * Download the LINE preview bytes for one message.
     *
     * @param messageId - LINE message identifier.
     * @param requestId - Optional request identifier.
     * @returns Preview content bytes.
     */
    async downloadMessageContentPreview(
      messageId: string,
      requestId?: string,
    ): Promise<Buffer> {
      return createMessageQueryService(
        () => service.client,
        service.e2eeManager,
      ).downloadMessageContentPreview(messageId, requestId)
    },

    /**
     * Mark a LINE conversation read up to a message via the explicit
     * sendChatChecked boundary. When messageId is omitted, resolves the most
     * recent message id in the chat. NEVER called by background capture/sync —
     * only by the send_message/send_image auto-read and the explicit mark_read
     * tool. Honest no-op (marked:false) when there is no message to mark.
     *
     * @param chatId - LINE chat MID.
     * @param messageId - Optional message id to mark read up to.
     * @returns Result describing whether a read receipt was sent.
     */
    async markChatRead(
      chatId: string,
      messageId?: string,
    ): Promise<{
      marked: boolean
      chatId?: string
      lastMessageId?: string
      reason?: string
    }> {
      let lastMessageId = messageId ?? null
      if (!lastMessageId) {
        const recent = await service.getRecentMessages(chatId, 1)
        lastMessageId = recent?.[0]?.id ? String(recent[0].id) : null
      }
      if (!lastMessageId) {
        return { marked: false, reason: 'no message to mark read' }
      }
      await service.client.sendChatChecked(chatId, lastMessageId, 0)
      return { marked: true, chatId, lastMessageId }
    },
  }
}
