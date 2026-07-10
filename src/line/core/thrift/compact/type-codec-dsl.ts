import { THRIFT_TYPE } from '../types.js';

export interface CompactTypeCodecDefinition {
  readHandler: string;
  type: number;
  writeHandler: string;
}

export const COMPACT_TYPE_CODEC_DEFINITIONS: CompactTypeCodecDefinition[] = [
  { type: THRIFT_TYPE.BOOL, readHandler: 'readBoolValue', writeHandler: 'writeBoolValue' },
  { type: THRIFT_TYPE.BYTE, readHandler: 'readByteValue', writeHandler: 'writeByteValue' },
  { type: THRIFT_TYPE.I16, readHandler: 'readI16Value', writeHandler: 'writeI16Value' },
  { type: THRIFT_TYPE.I32, readHandler: 'readI32Value', writeHandler: 'writeI32Value' },
  { type: THRIFT_TYPE.I64, readHandler: 'readI64Value', writeHandler: 'writeI64Value' },
  { type: THRIFT_TYPE.STRING, readHandler: 'readStringValue', writeHandler: 'writeStringValue' },
] as const;

export interface CompactStructTypeDefinition {
  handler: string;
  type: number;
}

export const COMPACT_STRUCT_TYPE_DEFINITIONS: CompactStructTypeDefinition[] = [
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
] as const;

/**
 * Resolve one compact thrift type into its configured codec definition.
 *
 * @param type - Thrift wire type.
 * @returns Codec definition, if defined.
 */
export function getCompactTypeCodecDefinition(type: number): CompactTypeCodecDefinition | null {
  return COMPACT_TYPE_CODEC_DEFINITIONS.find(candidate => candidate.type === type) ?? null;
}

/**
 * Resolve one compact struct field type into its configured reader handler.
 *
 * @param type - Compact field type.
 * @returns Handler definition, if defined.
 */
export function getCompactStructTypeDefinition(type: number): CompactStructTypeDefinition | null {
  return COMPACT_STRUCT_TYPE_DEFINITIONS.find(candidate => candidate.type === type) ?? null;
}
