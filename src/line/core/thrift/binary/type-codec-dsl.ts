import { THRIFT_TYPE } from '../types.js';

export interface BinaryTypeCodecDefinition {
  readHandler: string;
  type: number;
  writeHandler: string;
}

export const BINARY_TYPE_CODEC_DEFINITIONS: BinaryTypeCodecDefinition[] = [
  { type: THRIFT_TYPE.BOOL, readHandler: 'readBoolValue', writeHandler: 'writeBoolValue' },
  { type: THRIFT_TYPE.BYTE, readHandler: 'readByteValue', writeHandler: 'writeByteValue' },
  { type: THRIFT_TYPE.I16, readHandler: 'readI16Value', writeHandler: 'writeI16Value' },
  { type: THRIFT_TYPE.I32, readHandler: 'readI32Value', writeHandler: 'writeI32Value' },
  { type: THRIFT_TYPE.I64, readHandler: 'readI64Value', writeHandler: 'writeI64Value' },
  { type: THRIFT_TYPE.STRING, readHandler: 'readStringValue', writeHandler: 'writeStringValue' },
] as const;

/**
 * Resolve one binary thrift type into its configured codec definition.
 *
 * @param type - Thrift wire type.
 * @returns Codec definition, if defined.
 */
export function getBinaryTypeCodecDefinition(type: number): BinaryTypeCodecDefinition | null {
  return BINARY_TYPE_CODEC_DEFINITIONS.find(candidate => candidate.type === type) ?? null;
}
