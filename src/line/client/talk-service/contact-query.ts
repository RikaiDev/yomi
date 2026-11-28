interface ContactProfile {
  displayName: string | null
  phoneticName: string | null
  pictureStatus: string | null
  thumbnailUrl: string | null
  statusMessage: string | null
  displayNameOverridden: string | null
  picturePath: string | null
  statusMessageContentMetadata: Record<string, unknown>
  profileId: string | null
  /** Raw Contact fields 35/36: official/account attributes and notification settings. */
  attributes: number | null
  settings: number | null
  notificationDisabled: boolean
  isOfficial: boolean
}

/**
 * Normalize bigint-like thrift scalars into numbers when possible.
 *
 * @param value - Raw thrift scalar.
 * @returns Parsed number or original fallback.
 */
function normalizeNumericValue(value: unknown): number | null {
  if (typeof value === 'bigint') {
    return Number(value)
  }
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Extract profile fields from one raw contact struct.
 *
 * @param contact - Raw contact thrift struct.
 * @returns Normalized profile fields.
 */
function mapContactProfileFields(
  contact: Record<number, unknown>,
): ContactProfile {
  return {
    displayName: (contact[22] as string) || null,
    phoneticName: (contact[23] as string) || null,
    pictureStatus: (contact[24] as string) || null,
    thumbnailUrl: (contact[25] as string) || null,
    statusMessage: (contact[26] as string) || null,
    displayNameOverridden: (contact[27] as string) || null,
    picturePath: (contact[37] as string) || null,
    statusMessageContentMetadata:
      (contact[43] as Record<string, unknown>) || {},
    profileId: (contact[49] as string) || null,
    attributes: normalizeNumericValue(contact[35]),
    settings: normalizeNumericValue(contact[36]),
    notificationDisabled: Boolean(
      (normalizeNumericValue(contact[36]) ?? 0) & 1,
    ),
    isOfficial: Boolean((normalizeNumericValue(contact[35]) ?? 0) & 32),
  }
}

/**
 * Extract capability flags from one raw contact struct.
 *
 * @param contact - Raw contact thrift struct.
 * @returns Capability flags.
 */
function mapContactCapabilityFields(contact: Record<number, unknown>) {
  return {
    capableVoiceCall: Boolean(contact[31]),
    capableVideoCall: Boolean(contact[32]),
  }
}

/**
 * Map one raw contact thrift struct into the app shape.
 *
 * @param contact - Raw contact thrift struct.
 * @returns Normalized contact or null.
 */
export function mapContactStruct(
  contact: Record<number, unknown> | null | undefined,
) {
  if (!contact || typeof contact !== 'object') {
    return null
  }
  return {
    mid: (contact[1] as string) || null,
    createdTime: normalizeNumericValue(contact[2]),
    type: contact[10] ?? null,
    status: contact[11] ?? null,
    relation: contact[21] ?? null,
    favoriteTime: normalizeNumericValue(contact[28]),
    ...mapContactCapabilityFields(contact),
    ...mapContactProfileFields(contact),
  }
}

/**
 * Map a contact list, dropping invalid entries.
 *
 * @param contacts - Raw contact list.
 * @returns Normalized contact list.
 */
export function mapContactList(contacts: unknown): unknown[] {
  return Array.isArray(contacts)
    ? contacts
        .map((contact) => mapContactStruct(contact as Record<number, unknown>))
        .filter(Boolean)
    : []
}

/**
 * Map a `map<string, Contact>` response (used by findContactsByPhone and the
 * findAndAddContactsBy* family) into the normalized contact shape. Accepts a
 * plain list too, so callers do not need to care which wire shape LINE used.
 *
 * @param value - Raw map or list of contact structs.
 * @returns Normalized contacts, invalid entries dropped.
 */
export function mapContactMap(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return mapContactList(value)
  }
  if (!value || typeof value !== 'object') {
    return []
  }
  return Object.values(value as Record<string, unknown>)
    .map((contact) => mapContactStruct(contact as Record<number, unknown>))
    .filter(Boolean)
}
