export interface CompactStructTypeDefinition {
  handler: string
  type: number
}

const COMPACT_STRUCT_TYPE_DEFINITIONS: CompactStructTypeDefinition[] = [
  { type: 0, handler: 'readNullValue' },
  { type: 1, handler: 'readTrueValue' },
  { type: 2, handler: 'readFalseValue' },
  { type: 3, handler: 'readByteValue' },
  { type: 4, handler: 'readI16Value' },
  { type: 5, handler: 'readI32Value' },
  { type: 6, handler: 'readI64Value' },
  { type: 7, handler: 'readDoubleValue' },
  { type: 8, handler: 'readStringValue' },
  { type: 9, handler: 'readCollectionValue' },
  { type: 10, handler: 'readCollectionValue' },
  { type: 11, handler: 'readMapValue' },
  { type: 12, handler: 'readStructValue' },
] as const

/**
 * Resolve one compact struct field type into its configured reader handler.
 *
 * @param type - Compact field type.
 * @returns Handler definition, if defined.
 */
export function getCompactStructTypeDefinition(
  type: number,
): CompactStructTypeDefinition | null {
  return (
    COMPACT_STRUCT_TYPE_DEFINITIONS.find(
      (candidate) => candidate.type === type,
    ) ?? null
  )
}
