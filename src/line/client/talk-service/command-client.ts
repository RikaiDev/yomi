/**
 * LINE TalkService command capability.
 *
 * Send messages and other TalkService write operations with side effects.
 */

import { Buffer } from 'node:buffer'
import { parseMessage } from '../parsers.js'
import {
  buildAcceptChatInvitationRequest,
  buildCancelReactionRequest,
  buildContactMidActionRequest,
  buildCreateChatRequest,
  buildDeleteOtherFromChatRequest,
  buildDeleteSelfFromChatRequest,
  buildFindAndAddContactsByMidRequest,
  buildInviteIntoChatRequest,
  buildReactRequest,
  buildSendChatCheckedRequest,
  buildSendMessageRequest,
  buildUnsendMessageRequest,
  buildUpdateChatNameRequest,
  normalizeSendMessageOptions,
} from './requests.js'

/**
 * Create the TalkService command capability bound to one LINE client runtime.
 *
 * @param runtime - Mutable LINE client runtime.
 * @returns Talk command methods bound to the runtime.
 */
export function createTalkCommandClient(runtime) {
  return {
    /**
     * Send a LINE message via TalkService.
     *
     * This method keeps backward compatibility with the existing
     * `sendMessage(to, text)` signature while also accepting a richer options
     * object closer to linejs TalkService.sendMessage(). The extended form is
     * required for E2EE outbound payloads because LINE expects caller-supplied
     * `chunks` and matching `contentMetadata`.
     *
     * @param to - The recipient chat ID, or a full message options object.
     * @param text - The message text when using the legacy two-argument signature.
     * @returns The sent message object or null on error.
     */
    async sendMessage(to, text) {
      const options = normalizeSendMessageOptions(to, text)
      if (Array.isArray(options.chunks)) {
        options.chunks = options.chunks.map((chunk) =>
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        )
      }
      const result = await runtime.sendTalk(
        'sendMessage',
        buildSendMessageRequest(options),
      )
      if (result.error) {
        throw new Error(`sendMessage failed: ${result.error}`)
      }
      // fields[0] is the raw Thrift Message struct; normalize it so callers
      // get { id, from, ... } consistent with the read path (raw struct
      // carries the id at index [4], not `.id`).
      const sent = result.fields?.[0]
      return sent ? parseMessage(sent) : null
    },

    /**
     * Mark a LINE conversation read up to a given message via TalkService
     * sendChatChecked. This has a side effect visible to the other party (a
     * read receipt); it is only ever called from explicit user-intent paths,
     * never from background sync. Returns true on success; throws on LINE error.
     *
     * @param chatMid - Chat MID to mark read.
     * @param lastMessageId - Message id to mark read up to.
     * @param sessionId - Client session id (default 0).
     * @returns True when the read receipt was accepted.
     */
    async sendChatChecked(chatMid, lastMessageId, sessionId = 0) {
      const result = await runtime.sendTalk(
        'sendChatChecked',
        buildSendChatCheckedRequest(chatMid, lastMessageId, sessionId),
      )
      if (result.error) {
        throw new Error(`sendChatChecked failed: ${result.error}`)
      }
      return true
    },

    /**
     * Rename a group/chat via TalkService updateChat. Side effect visible to
     * every member. Throws on LINE error.
     *
     * @param chatMid - Group/chat MID to rename.
     * @param name - New name.
     * @returns True when the rename was accepted.
     */
    async updateChatName(chatMid, name) {
      const result = await runtime.sendTalk(
        'updateChat',
        buildUpdateChatNameRequest(chatMid, name),
      )
      if (result.error) {
        throw new Error(`updateChat failed: ${result.error}`)
      }
      return true
    },

    /**
     * Invite members into a group/chat via TalkService inviteIntoChat. The
     * invitees must accept before joining a group. Throws on LINE error.
     *
     * @param chatMid - Group/chat MID to invite into.
     * @param mids - MIDs to invite.
     * @returns True when the invitation was accepted.
     */
    async inviteIntoChat(chatMid, mids) {
      const result = await runtime.sendTalk(
        'inviteIntoChat',
        buildInviteIntoChatRequest(chatMid, mids),
      )
      if (result.error) {
        throw new Error(`inviteIntoChat failed: ${result.error}`)
      }
      return true
    },

    /**
     * Remove (kick) members from a group/chat via TalkService
     * deleteOtherFromChat. Side effect visible to every member; the removed
     * member loses access. Throws on LINE error.
     *
     * @param chatMid - Group/chat MID to remove members from.
     * @param mids - MIDs to remove.
     * @returns True when the removal was accepted.
     */
    async deleteOtherFromChat(chatMid, mids) {
      const result = await runtime.sendTalk(
        'deleteOtherFromChat',
        buildDeleteOtherFromChatRequest(chatMid, mids),
      )
      if (result.error) {
        throw new Error(`deleteOtherFromChat failed: ${result.error}`)
      }
      return true
    },

    /**
     * Leave a group/chat via TalkService deleteSelfFromChat — the authenticated
     * account itself exits. Throws on LINE error.
     *
     * @param chatMid - Group/chat MID to leave.
     * @returns True when the departure was accepted.
     */
    async deleteSelfFromChat(chatMid) {
      const result = await runtime.sendTalk(
        'deleteSelfFromChat',
        buildDeleteSelfFromChatRequest(chatMid),
      )
      if (result.error) {
        throw new Error(`deleteSelfFromChat failed: ${result.error}`)
      }
      return true
    },

    /**
     * Create a new group/room via TalkService createChat with an initial member
     * set. Does NOT mint or register any E2EE group key (key material is
     * established lazily on first E2EE send/receive) — see the never-mint fix.
     * Throws on LINE error.
     *
     * @param name - New chat name.
     * @param mids - Initial member MIDs.
     * @param chatType - LINE chat type (0 = group, 1 = room). Default 1.
     * @returns The created Chat struct.
     */
    async createChat(name, mids, chatType = 1) {
      const result = await runtime.sendTalk(
        'createChat',
        buildCreateChatRequest(name, mids, chatType),
      )
      if (result.error) {
        throw new Error(`createChat failed: ${result.error}`)
      }
      return result.fields?.[0] ?? null
    },

    /**
     * Add a predefined reaction to a message via TalkService react. Visible to
     * the conversation. Throws on LINE error.
     *
     * @param messageId - Target message id (numeric string).
     * @param reactionType - Predefined reaction type (2=LIKE, 3=LOVE, 4=LAUGH,
     * 5=SURPRISE, 6=SAD, 7=ANGRY). Default 2.
     * @returns True when the reaction was accepted.
     */
    async react(messageId, reactionType = 2) {
      const result = await runtime.sendTalk(
        'react',
        buildReactRequest(messageId, reactionType),
      )
      if (result.error) {
        throw new Error(`react failed: ${result.error}`)
      }
      return true
    },

    /**
     * Remove this account's reaction from a message via TalkService
     * cancelReaction. Throws on LINE error.
     *
     * @param messageId - Target message id (numeric string).
     * @returns True when the cancellation was accepted.
     */
    async cancelReaction(messageId) {
      const result = await runtime.sendTalk(
        'cancelReaction',
        buildCancelReactionRequest(messageId),
      )
      if (result.error) {
        throw new Error(`cancelReaction failed: ${result.error}`)
      }
      return true
    },

    /**
     * Unsend (retract) one of this account's own messages via TalkService
     * unsendMessage — it is removed for everyone in the conversation. LINE only
     * permits unsending the caller's own messages. Throws on LINE error.
     *
     * @param messageId - Message id to unsend (numeric string).
     * @returns True when the unsend was accepted.
     */
    async unsendMessage(messageId) {
      const result = await runtime.sendTalk(
        'unsendMessage',
        buildUnsendMessageRequest(messageId),
      )
      if (result.error) {
        throw new Error(`unsendMessage failed: ${result.error}`)
      }
      return true
    },

    /**
     * Add a friend by MID via TalkService findAndAddContactsByMid. Throws on
     * LINE error.
     *
     * @param mid - MID of the person to add.
     * @param reference - JSON reference breadcrumb (optional).
     * @returns The added contact result (raw response fields).
     */
    async findAndAddContactByMid(mid, reference) {
      const result = await runtime.sendTalk(
        'findAndAddContactsByMid',
        buildFindAndAddContactsByMidRequest(mid, reference),
      )
      if (result.error) {
        throw new Error(`findAndAddContactsByMid failed: ${result.error}`)
      }
      return result.fields?.[0] ?? null
    },

    /**
     * Block a contact via TalkService blockContact. Throws on LINE error.
     *
     * @param mid - Contact MID to block.
     * @returns True when the block was accepted.
     */
    async blockContact(mid) {
      const result = await runtime.sendTalk(
        'blockContact',
        buildContactMidActionRequest(mid),
      )
      if (result.error) {
        throw new Error(`blockContact failed: ${result.error}`)
      }
      return true
    },

    /**
     * Unblock a contact via TalkService unblockContact. Throws on LINE error.
     *
     * @param mid - Contact MID to unblock.
     * @returns True when the unblock was accepted.
     */
    async unblockContact(mid) {
      const result = await runtime.sendTalk(
        'unblockContact',
        buildContactMidActionRequest(mid),
      )
      if (result.error) {
        throw new Error(`unblockContact failed: ${result.error}`)
      }
      return true
    },

    /**
     * Accept a group/chat invitation via TalkService acceptChatInvitation —
     * this account joins the chat. Throws on LINE error.
     *
     * @param chatMid - Group/chat MID to accept the invitation for.
     * @returns True when the acceptance was accepted.
     */
    async acceptChatInvitation(chatMid) {
      const result = await runtime.sendTalk(
        'acceptChatInvitation',
        buildAcceptChatInvitationRequest(chatMid),
      )
      if (result.error) {
        throw new Error(`acceptChatInvitation failed: ${result.error}`)
      }
      return true
    },
  }
}
