/**
 * LINE TalkService command capability.
 *
 * Send messages and other TalkService write operations with side effects.
 */

import { Buffer } from 'node:buffer';
import { parseMessage } from '../parsers.js';
import { buildSendChatCheckedRequest, buildSendMessageRequest, normalizeSendMessageOptions } from './requests.js';

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
      const options = normalizeSendMessageOptions(to, text);
      if (Array.isArray(options.chunks)) {
        options.chunks = options.chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const result = await runtime.sendTalk('sendMessage', buildSendMessageRequest(options));
      if (result.error) {
        throw new Error(`sendMessage failed: ${result.error}`);
      }
      // fields[0] is the raw Thrift Message struct; normalize it so callers
      // get { id, from, ... } consistent with the read path (raw struct
      // carries the id at index [4], not `.id`).
      const sent = result.fields?.[0];
      return sent ? parseMessage(sent) : null;
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
      const result = await runtime.sendTalk('sendChatChecked', buildSendChatCheckedRequest(chatMid, lastMessageId, sessionId));
      if (result.error) {
        throw new Error(`sendChatChecked failed: ${result.error}`);
      }
      return true;
    },
  };
}
