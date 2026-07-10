/**
 * LINE TalkService query capability.
 *
 * Profile, contacts, chats, and message-box retrieval.
 */

import type { ThriftFieldTuple } from '../../core/thrift/types.js';
import type { MessageBoxListOptions, PreviousMessagesRequest } from './message-box-query.js';
import { parseMessages } from '../parsers.js';
import { fetchChats } from './chat-query.js';
import { mapContactList } from './contact-query.js';
import {
  buildEndMessageIdFields,
  buildMessageBoxRequest,
  logPreviousMessagesResponse,
  logRecentMessagesResponse,
  mapMessageBoxList,
} from './message-box-query.js';
import { fetchMessagesByIds } from './message-id-query.js';
import {
  buildDownloadMessageContentRequest,
  buildGetAllChatMidsRequest,
  buildGetAllContactIdsRequest,
  buildGetMessageBoxesRequest,
  buildMidListRequest,
  buildMidLookupRequest,
  buildPreviousMessagesRequest,
  buildRecentMessagesRequest,
} from './requests.js';

/** Sync reason constant matching CHRLINE reference. */
const SYNC_REASON = 7;
/** Sync reason used by getPreviousMessagesV2WithRequest for secondary-device history sync. */
const PREVIOUS_MESSAGES_SYNC_REASON = 4;

/**
 * Create the TalkService query capability bound to one LINE client runtime.
 *
 * @param runtime - Mutable LINE client runtime.
 * @returns Talk query methods bound to the runtime.
 */
export function createTalkQueryClient(runtime) {
  return {
    /**
     * Retrieve the authenticated user's profile.
     *
     * @returns The user's profile object.
     */
    async getProfile() {
      const result = await runtime.sendTalk('getProfile', []);
      if (result.fields?.[1]) {
        const err = result.fields[1];
        throw new Error(`getProfile failed: code=${err[1]} ${err[2] || 'Unknown error'}`);
      }
      const profile = result.fields?.[0];
      if (!profile || typeof profile !== 'object') {
        throw new Error('getProfile: no profile data in response');
      }
      runtime.profile = {
        mid: profile[1] || null,
        displayName: profile[20] || null,
        picturePath: profile[22] || null,
        statusMessage: profile[24] || null,
      };
      return runtime.profile;
    },

    /**
     * Retrieve all contact IDs from the server.
     *
     * @returns An array of contact IDs.
     */
    async getAllContactIds() {
      const result = await runtime.sendTalk('getAllContactIds', buildGetAllContactIdsRequest());
      const ids = result.fields?.[0];
      return Array.isArray(ids) ? ids : [];
    },

    /**
     * Retrieve one raw contact by MID.
     *
     * @param mid - Contact MID.
     * @returns Contact object or null.
     */
    async getContact(mid) {
      const result = await runtime.sendTalk('getContact', buildMidLookupRequest(mid));
      return result.fields?.[0] || null;
    },

    /**
     * Retrieve and normalize multiple contacts.
     *
     * @param mids - Contact MIDs.
     * @returns Normalized contact objects.
     */
    async getContacts(mids) {
      const result = await runtime.sendTalk('getContacts', buildMidListRequest(mids));
      return mapContactList(result.fields?.[0]);
    },

    /**
     * Retrieve all member and invited chat MIDs.
     *
     * @returns Member/invited chat MID groups.
     */
    async getAllChatMids() {
      const result = await runtime.sendTalk('getAllChatMids', buildGetAllChatMidsRequest(SYNC_REASON));
      const response = result.fields?.[0];
      return { memberChats: response?.[1] || [], invitedChats: response?.[2] || [] };
    },

    /**
     * Retrieve and normalize chats.
     *
     * @param chatMids - Chat MIDs.
     * @param withMembers - Whether to include members.
     * @returns Normalized chat objects.
     */
    async getChats(chatMids, withMembers = true) {
      return fetchChats(runtime, SYNC_REASON, chatMids, withMembers);
    },

    /**
     * Retrieve one group profile.
     *
     * @param groupId - Group MID.
     * @returns Group object or null.
     */
    async getGroup(groupId) {
      const result = await runtime.sendTalk('getGroup', buildMidLookupRequest(groupId));
      return result.fields?.[0] || null;
    },

    /**
     * Retrieve message-box metadata.
     *
     * @param options - Message-box listing options.
     * @returns Normalized message-box result.
     */
    async getMessageBoxes(options: MessageBoxListOptions = {}) {
      const request = buildMessageBoxRequest(options);
      const result = await runtime.sendTalk('getMessageBoxes', buildGetMessageBoxesRequest(request, SYNC_REASON));
      const root = result.fields?.[0];
      return {
        messageBoxes: mapMessageBoxList(root?.[1]),
        hasNext: Boolean(root?.[2]),
      };
    },

    /**
     * Retrieve previous messages through one message-box cursor.
     *
     * @param request - Previous-message request payload.
     * @returns Parsed previous messages.
     */
    async getPreviousMessagesV2WithRequest(request: PreviousMessagesRequest) {
      const endMessageIdFields = buildEndMessageIdFields(request);
      const result = await runtime.sendTalk(
        'getPreviousMessagesV2WithRequest',
        buildPreviousMessagesRequest(request, endMessageIdFields, PREVIOUS_MESSAGES_SYNC_REASON),
      );
      const raw = result.fields?.[0];
      const messages = Array.isArray(raw) ? parseMessages(raw) : [];
      logPreviousMessagesResponse(request, messages);
      return messages;
    },

    /**
     * Retrieve previous MessageBoxV2 ids for one conversation.
     *
     * @param request - Previous-message request payload.
     * @returns Message id cursors and the server pagination flag.
     */
    async getPreviousMessageIds(request: PreviousMessagesRequest) {
      const fields: ThriftFieldTuple[] = [
        [11, 1, request.messageBoxId],
      ];
      const endMessageIdFields = buildEndMessageIdFields(request);
      if (endMessageIdFields.length > 0) {
        fields.push([12, 2, endMessageIdFields]);
      }
      fields.push([8, 4, request.messagesCount]);
      const result = await runtime.sendTalk('getPreviousMessageIds', [
        [12, 2, fields],
        [8, 3, PREVIOUS_MESSAGES_SYNC_REASON],
      ]);
      const response = result.fields?.[0];
      const ids = Array.isArray(response?.[1])
        ? response[1].map((item: any) => ({
            deliveredTime: Number(item?.[1] || 0),
            messageId: String(item?.[2] || ''),
          })).filter((item: any) => item.deliveredTime && item.messageId)
        : [];
      return {
        ids,
        hasPrevious: Boolean(response?.[2]),
      };
    },

    /**
     * Retrieve messages by MessageBoxV2 ids.
     *
     * @param messageBoxId - Conversation id.
     * @param messageIds - MessageBoxV2 ids to resolve.
     * @returns Parsed messages.
     */
    async getMessagesByIds(messageBoxId: string, messageIds: any[]) {
      return fetchMessagesByIds(runtime, messageBoxId, messageIds);
    },

    /**
     * Retrieve recent messages from one chat.
     *
     * @param chatId - Chat MID.
     * @param count - Maximum number of messages.
     * @returns Parsed message list.
     */
    async getRecentMessages(chatId, count = 50) {
      const result = await runtime.sendTalk('getRecentMessagesV2', buildRecentMessagesRequest(chatId, count));
      const raw = result.fields?.[0];
      const messages = raw ? parseMessages(raw) : [];
      logRecentMessagesResponse(chatId, count, raw, messages);
      return messages;
    },

    /**
     * Retrieve binary media content for one LINE message.
     *
     * @param messageId - LINE message identifier.
     * @param requestId - Client request identifier.
     * @returns Message content bytes.
     */
    async downloadMessageContent(messageId, requestId = `yomi-${Date.now()}`) {
      const result = await runtime.sendTalk(
        'downloadMessageContent',
        buildDownloadMessageContentRequest(requestId, messageId),
      );
      const content = result.fields?.[0];
      return Buffer.isBuffer(content) ? content : Buffer.from(content || '');
    },

    /**
     * Retrieve binary preview media content for one LINE message.
     *
     * @param messageId - LINE message identifier.
     * @param requestId - Client request identifier.
     * @returns Message preview bytes.
     */
    async downloadMessageContentPreview(messageId, requestId = `yomi-${Date.now()}`) {
      const result = await runtime.sendTalk(
        'downloadMessageContentPreview',
        buildDownloadMessageContentRequest(requestId, messageId),
      );
      const content = result.fields?.[0];
      return Buffer.isBuffer(content) ? content : Buffer.from(content || '');
    },
  };
}
