/**
 * LINE Client E2EE transport capability.
 */

import {
  buildGetE2EEMessageInfoRequest,
  buildGetLastGroupSharedKeyRequest,
  buildGetLastPublicKeysRequest,
  buildGetPublicKeysRequest,
  buildNegotiatePublicKeyRequest,
  buildRegisterGroupKeyRequest,
  buildRegisterPublicKeyRequest,
} from './requests.js';
import { buildSharedKeyEventLog } from './shared-key-log.js';

/**
 * Resolve a logger suitable for E2EE client events.
 *
 * @param client - LINE client instance.
 * @returns Logger-like object when available.
 */
function getE2EEClientLog(client) {
  if (client?.startupFlowLogger) {
    return client.startupFlowLogger;
  }
  if (client?.logger?.info) {
    return client.logger;
  }
  return client?.logger;
}

/**
 * Create the E2EE transport capability bound to one LINE client runtime.
 *
 * @param runtime - Mutable LINE client runtime.
 * @returns E2EE transport methods bound to the runtime.
 */
export function createE2EEClient(runtime) {
  return {
    async getE2EEPublicKeys() {
      const result = await runtime.sendTalk('getE2EEPublicKeys', []);
      return result.fields?.[0] || [];
    },
    async registerE2EEPublicKey(version, keyId, keyData, timestamp) {
      const result = await runtime.sendTalk('registerE2EEPublicKey', buildRegisterPublicKeyRequest(version, keyId, keyData, timestamp));
      return result.fields?.[0] || null;
    },
    async negotiateE2EEPublicKey(mid) {
      const result = await runtime.sendTalk('negotiateE2EEPublicKey', buildNegotiatePublicKeyRequest(mid));
      return result.fields?.[0] || null;
    },
    async getE2EEPublicKeysEx(mids) {
      const result = await runtime.sendTalk('getE2EEPublicKeysEx', buildGetPublicKeysRequest(mids));
      return result.fields?.[0] || [];
    },
    async getE2EEMessageInfo(mid, messageId, receiverKeyId) {
      const result = await runtime.sendTalk('getE2EEMessageInfo', buildGetE2EEMessageInfoRequest(mid, messageId, receiverKeyId));
      return result.fields?.[0] || null;
    },
    async getLastE2EEGroupSharedKey(keyVersion, chatMid) {
      const result = await runtime.sendTalk('getLastE2EEGroupSharedKey', buildGetLastGroupSharedKeyRequest(keyVersion, chatMid));
      const shared = result.fields?.[0] || null;
      getE2EEClientLog(runtime)?.info?.('e2ee.group_shared_key.response', buildSharedKeyEventLog(chatMid, shared));
      return shared;
    },
    async getLastE2EEPublicKeys(chatMid) {
      const result = await runtime.sendTalk('getLastE2EEPublicKeys', buildGetLastPublicKeysRequest(chatMid));
      return result.fields?.[0] || {};
    },
    async registerE2EEGroupKey(keyVersion, chatMid, members, keyIds, encryptedSharedKeys) {
      const result = await runtime.sendTalk('registerE2EEGroupKey', buildRegisterGroupKeyRequest(keyVersion, chatMid, members, keyIds, encryptedSharedKeys));
      const shared = result.fields?.[0] || null;
      getE2EEClientLog(runtime)?.info?.(
        'e2ee.group_shared_key.registered',
        buildSharedKeyEventLog(chatMid, shared, { members: members.length, key_ids: keyIds.length }),
      );
      return shared;
    },
  };
}
