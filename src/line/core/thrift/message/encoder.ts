/**
 * LINE Thrift TCompact message encoder.
 */

import type { ThriftFieldTuple } from '../types.js';
import { Buffer } from 'node:buffer';
import { varint } from '../primitives/varint.js';
import { writeFieldsArray } from '../struct/writer.js';

/**
 * Build a TCompact CALL message using array-style field definitions.
 *
 * @param method - Method name.
 * @param seqId - Sequence ID.
 * @param args - Array of [type, fieldId, value] tuples.
 * @returns Serialized TCompact message as Buffer.
 */
export function encodeCallMessage(method: string, seqId: number, args: ThriftFieldTuple[]): Buffer {
  const methodName = Buffer.from(method, 'utf-8');
  return Buffer.concat([
    Buffer.from([0x82, 0x21]),
    varint(seqId),
    varint(methodName.length),
    methodName,
    args?.length ? writeFieldsArray(args, { v: 0 }) : Buffer.alloc(0),
    Buffer.from([0]),
  ]);
}
