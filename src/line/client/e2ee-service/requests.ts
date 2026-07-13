import {
  i32Field,
  i64Field,
  listField,
  stringField,
  structField,
} from '../../core/thrift/index.js'

/**
 * Build the registerE2EEPublicKey request fields.
 *
 * @param version - Public key version.
 * @param keyId - Assigned key identifier.
 * @param keyData - Public key payload.
 * @param timestamp - Registration timestamp.
 * @returns Thrift request fields.
 */
export function buildRegisterPublicKeyRequest(
  version,
  keyId,
  keyData,
  timestamp,
) {
  return [
    i32Field(1, 0),
    structField(2, [
      i32Field(1, version),
      i32Field(2, keyId),
      stringField(4, keyData),
      i64Field(5, timestamp),
    ]),
  ]
}

/**
 * Build the negotiateE2EEPublicKey request fields.
 *
 * @param mid - Target MID.
 * @returns Thrift request fields.
 */
export function buildNegotiatePublicKeyRequest(mid) {
  return [stringField(2, mid)]
}

/**
 * Build the getE2EEPublicKeysEx request fields.
 *
 * @param mids - Target MIDs.
 * @returns Thrift request fields.
 */
export function buildGetPublicKeysRequest(mids) {
  return [listField(2, 11, mids)]
}

/**
 * Build the getE2EEMessageInfo request fields.
 *
 * @param mid - Peer or chat MID.
 * @param messageId - LINE message id.
 * @param receiverKeyId - Receiver key id from the E2EE envelope.
 * @returns Thrift request fields.
 */
export function buildGetE2EEMessageInfoRequest(mid, messageId, receiverKeyId) {
  return [
    stringField(2, mid),
    stringField(3, messageId),
    i32Field(4, Number(receiverKeyId)),
  ]
}

/**
 * Build the getLastE2EEGroupSharedKey request fields.
 *
 * @param keyVersion - Shared key version.
 * @param chatMid - Target chat MID.
 * @returns Thrift request fields.
 */
export function buildGetLastGroupSharedKeyRequest(keyVersion, chatMid) {
  return [i32Field(2, keyVersion), stringField(3, chatMid)]
}

/**
 * Build the getLastE2EEPublicKeys request fields.
 *
 * @param chatMid - Target chat MID.
 * @returns Thrift request fields.
 */
export function buildGetLastPublicKeysRequest(chatMid) {
  return [stringField(2, chatMid)]
}

/**
 * Build the registerE2EEGroupKey request fields.
 *
 * @param keyVersion - Shared key version.
 * @param chatMid - Target chat MID.
 * @param members - Group member MIDs.
 * @param keyIds - Public key IDs.
 * @param encryptedSharedKeys - Encrypted shared keys.
 * @returns Thrift request fields.
 */
export function buildRegisterGroupKeyRequest(
  keyVersion,
  chatMid,
  members,
  keyIds,
  encryptedSharedKeys,
) {
  return [
    i32Field(2, keyVersion),
    stringField(3, chatMid),
    listField(4, 11, members),
    listField(5, 8, keyIds),
    listField(6, 11, encryptedSharedKeys),
  ]
}
