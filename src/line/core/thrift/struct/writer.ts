/**
 * TCompact struct writer.
 */

import { Buffer } from 'node:buffer'
import { varint, zigzag, zigzag64 } from '../primitives/varint.js'
import type {
  ThriftFieldTuple,
  ThriftFieldValue,
  ThriftListValue,
  ThriftMapValue,
  ThriftType,
} from '../types.js'

const COMPACT_TYPE_BY_THRIFT_TYPE: Record<number, number> = {
  3: 3,
  6: 4,
  8: 5,
  10: 6,
  11: 8,
  12: 12,
  13: 11,
  15: 9,
}

/**
 * Check whether a value is a Buffer instance.
 *
 * @param value - Candidate value.
 * @returns True when the value is a Buffer.
 */
function isBufferLike(value: unknown): value is Buffer {
  return Buffer.isBuffer(value)
}

/**
 * Check whether a value looks like a struct field tuple array.
 *
 * @param value - Candidate value.
 * @returns True when the value is a struct field tuple array.
 */
function isStructFieldTupleArray(
  value: ThriftFieldValue,
): value is ThriftFieldTuple[] {
  return (
    Array.isArray(value) &&
    value.every((item) => Array.isArray(item) && item.length === 3)
  )
}

/**
 * Write one compact field header.
 *
 * @param parts - Buffer accumulator.
 * @param compactType - Compact wire type.
 * @param delta - Delta from previous field ID.
 * @param fieldId - Absolute field ID.
 */
function writeHeader(
  parts: Buffer[],
  compactType: number,
  delta: number,
  fieldId: number,
): void {
  parts.push(
    delta > 0 && delta <= 15
      ? Buffer.from([(delta << 4) | compactType])
      : Buffer.concat([Buffer.from([compactType]), zigzag(fieldId)]),
  )
}

/**
 * Write one TCompact MAP payload.
 *
 * @param parts - Buffer accumulator.
 * @param value - Map tuple payload.
 */
function writeMap(parts: Buffer[], value: ThriftMapValue): void {
  const [keyType, valueType, entriesObject] = value
  const compactMap: Record<number, number> = { 8: 5, 11: 8, 12: 12 }
  const compactKeyType = compactMap[keyType] || keyType
  const compactValueType = compactMap[valueType] || valueType
  const entries = Object.entries(entriesObject)
  parts.push(varint(entries.length))
  if (entries.length > 0) {
    parts.push(Buffer.from([(compactKeyType << 4) | compactValueType]))
  }
  for (const [key, item] of entries) {
    if (keyType === 11) {
      const encodedKey = Buffer.from(key, 'utf-8')
      parts.push(varint(encodedKey.length), encodedKey)
    } else if (keyType === 8) {
      parts.push(zigzag(Number(key)))
    }
    if (valueType === 11) {
      const encodedValue =
        typeof item === 'string' ? Buffer.from(item, 'utf-8') : (item as Buffer)
      parts.push(varint(encodedValue.length), encodedValue)
    } else if (valueType === 8) {
      parts.push(zigzag(item as number))
    }
  }
}

/**
 * Write one TCompact LIST payload.
 *
 * @param parts - Buffer accumulator.
 * @param value - List tuple payload.
 */
function writeList(parts: Buffer[], value: ThriftListValue): void {
  const [elementType, items] = value
  const compactMap: Record<number, number> = { 8: 5, 11: 8, 12: 12 }
  const compactElementType = compactMap[elementType] || elementType
  if (items.length < 15) {
    parts.push(Buffer.from([(items.length << 4) | compactElementType]))
  } else {
    parts.push(Buffer.from([0xf0 | compactElementType]), varint(items.length))
  }
  for (const item of items) {
    if (elementType === 11) {
      const encodedItem =
        typeof item === 'string'
          ? Buffer.from(item, 'utf-8')
          : isBufferLike(item)
            ? item
            : Buffer.alloc(0)
      parts.push(varint(encodedItem.length), encodedItem)
    } else if (elementType === 8) {
      parts.push(zigzag(Number(item)))
    }
  }
}

/**
 * Write one primitive or composite thrift field value.
 *
 * @param parts - Buffer accumulator.
 * @param type - Thrift field type ID.
 * @param value - Field value.
 */
function writeFieldValue(
  parts: Buffer[],
  type: ThriftType,
  value: ThriftFieldValue,
): void {
  if (type === 3) {
    parts.push(Buffer.from([(value as number) & 0xff]))
    return
  }
  if (type === 6 || type === 8) {
    parts.push(zigzag(value as number))
    return
  }
  if (type === 10) {
    parts.push(zigzag64(value))
    return
  }
  if (type === 11) {
    const encodedValue =
      typeof value === 'string'
        ? Buffer.from(value, 'utf-8')
        : isBufferLike(value)
          ? value
          : Buffer.alloc(0)
    parts.push(varint(encodedValue.length), encodedValue)
    return
  }
  if (type === 12) {
    if (isStructFieldTupleArray(value) && value.length) {
      parts.push(writeFieldsArray(value, { v: 0 }))
    }
    parts.push(Buffer.from([0]))
    return
  }
  if (type === 13) {
    writeMap(parts, value as ThriftMapValue)
    return
  }
  if (type === 15) {
    writeList(parts, value as ThriftListValue)
  }
}

/**
 * Recursively write field definitions into a TCompact struct body.
 *
 * @param fields - Array of [type, fieldId, value] tuples.
 * @param lastFieldId - Mutable field ID tracker for delta encoding.
 * @param lastFieldId.v - Last written field ID.
 * @returns Serialized struct body.
 */
export function writeFieldsArray(
  fields: ThriftFieldTuple[],
  lastFieldId: { v: number },
): Buffer {
  const parts: Buffer[] = []
  for (const field of fields) {
    if (!field) {
      continue
    }
    const [type, fieldId, value] = field
    const delta = fieldId - lastFieldId.v

    if (type === 2) {
      const compactType = value ? 1 : 2
      writeHeader(parts, compactType, delta, fieldId)
      lastFieldId.v = fieldId
      continue
    }

    const compactType = COMPACT_TYPE_BY_THRIFT_TYPE[type]
    if (compactType === undefined) {
      throw new Error(`Unsupported thrift type: ${type}`)
    }
    writeHeader(parts, compactType, delta, fieldId)
    lastFieldId.v = fieldId
    writeFieldValue(parts, type, value)
  }
  return Buffer.concat(parts)
}
