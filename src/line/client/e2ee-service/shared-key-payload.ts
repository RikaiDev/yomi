/**
 * LINE shared-key response payload normalization.
 */

/**
 * Resolve one shared-key field from either a named property or raw tuple form.
 *
 * @param shared - Shared-key response payload.
 * @param namedKey - Preferred named property.
 * @param tupleIndex - Fallback tuple index.
 * @returns Resolved field value or null.
 */
export function readSharedKeyResponseField(shared, namedKey, tupleIndex) {
  if (shared?.[namedKey] !== undefined && shared?.[namedKey] !== null) {
    return shared[namedKey];
  }
  if (shared?.[tupleIndex] !== undefined && shared?.[tupleIndex] !== null) {
    return shared[tupleIndex];
  }
  return null;
}

/**
 * Extract normalized shared-key identity fields from a LINE response payload.
 *
 * @param shared - Shared-key response payload.
 * @returns Normalized shared-key fields used by downstream logging/diagnostics.
 */
export function extractSharedKeyIdentity(shared) {
  return {
    creator: readSharedKeyResponseField(shared, 'creator', 3),
    creator_key_id: readSharedKeyResponseField(shared, 'creatorKeyId', 4),
    receiver_key_id: readSharedKeyResponseField(shared, 'receiverKeyId', 6),
    group_key_id: readSharedKeyResponseField(shared, 'groupKeyId', 2),
    has_encrypted_shared_key: Boolean(readSharedKeyResponseField(shared, 'encryptedSharedKey', 7)),
  };
}
