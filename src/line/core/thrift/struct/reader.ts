/**
 * TCompact struct parser.
 */

import { Buffer } from 'node:buffer'
import { getCompactStructTypeDefinition } from '../compact/type-codec-dsl.js'

/**
 * Parse a TCompact struct from raw bytes (no message header).
 *
 * @param buf - Raw bytes starting at the first field header (or STOP byte)
 * @param textStrings - If true, decode STRING fields as UTF-8 string (default: false → Buffer)
 * @returns Object mapping field ID → parsed value
 */
export function readStructFields(
  buf: Buffer | Uint8Array,
  textStrings = false,
): Record<number, any> {
  let pos = 0
  let lastFieldId = 0
  let lastType = -1

  const readByte = () => buf[pos++]
  const readVarint = () => {
    let result = 0
    let shift = 0
    while (pos < buf.length) {
      const byte = buf[pos++]
      result |= (byte & 0x7f) << shift
      if (!(byte & 0x80)) {
        break
      }
      shift += 7
    }
    return result >>> 0
  }
  const readZigzagInt = () => {
    const value = readVarint()
    return (value >>> 1) ^ -(value & 1)
  }
  const readZigzagBigInt = () => {
    let result = 0n
    let shift = 0n
    while (pos < buf.length) {
      const byte = BigInt(buf[pos++])
      result |= (byte & 0x7fn) << shift
      if (!(byte & 0x80n)) {
        break
      }
      shift += 7n
    }
    return (result >> 1n) ^ -(result & 1n)
  }
  const readString = () => {
    const length = readVarint()
    if (length < 0 || pos + length > buf.length) {
      throw new Error(
        `Invalid Length: len=${length} pos=${pos} buf=${buf.length} field=${lastFieldId} type=${lastType}`,
      )
    }
    const slice = buf.subarray(pos, pos + length)
    pos += length
    if (!textStrings) {
      return Buffer.from(slice)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(slice)
    } catch {
      return Buffer.from(slice)
    }
  }

  /**
   * Read a TCompact LIST or SET payload.
   *
   * @param header - Collection header byte.
   * @returns Parsed collection items.
   */
  function readCollection(header: number) {
    const items: any[] = []
    let size = (header >> 4) & 0xf
    const elementType = header & 0xf
    if (size === 15) {
      size = readVarint()
    }
    if (size < 0 || size > 100000) {
      throw new Error(
        `Invalid Length: collection=${size} pos=${pos} field=${lastFieldId} type=${lastType}`,
      )
    }
    for (let i = 0; i < size; i++) {
      items.push(readValue(elementType))
    }
    return items
  }

  /**
   * Read a TCompact MAP payload.
   *
   * @returns Parsed key/value object.
   */
  function readMap() {
    const size = readVarint()
    if (!size) {
      return {}
    }
    const header = readByte()
    const keyType = (header >> 4) & 0xf
    const valueType = header & 0xf
    const map: Record<string, any> = {}
    if (size < 0 || size > 100000) {
      throw new Error(
        `Invalid Length: map=${size} pos=${pos} field=${lastFieldId} type=${lastType}`,
      )
    }
    for (let i = 0; i < size; i++) {
      const key = readValue(keyType)
      map[Buffer.isBuffer(key) ? key.toString('utf-8') : String(key)] =
        readValue(valueType)
    }
    return map
  }

  /**
   * Read one TCompact DOUBLE value.
   *
   * @returns Parsed floating-point value.
   */
  function readDouble() {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const value = view.getFloat64(pos, true)
    pos += 8
    return value
  }

  const compactTypeReaders: Record<string, () => any> = {
    readNullValue: () => null,
    readTrueValue: () => true,
    readFalseValue: () => false,
    readByteValue: () => readByte(),
    readI16Value: () => readZigzagInt(),
    readI32Value: () => readZigzagInt(),
    readI64Value: () => readZigzagBigInt(),
    readDoubleValue: () => readDouble(),
    readStringValue: () => readString(),
    readCollectionValue: () => readCollection(readByte()),
    readMapValue: () => readMap(),
    readStructValue: () => readStruct(),
  }

  /**
   * Read one compact field value.
   *
   * @param compactType - Compact wire type.
   * @returns Parsed field value.
   */
  function readValue(compactType: number): any {
    const definition = getCompactStructTypeDefinition(compactType)
    if (!definition) {
      throw new Error(`Unknown compact type ${compactType} at pos ${pos}`)
    }
    return compactTypeReaders[definition.handler]()
  }

  /**
   * Read one TCompact struct body.
   *
   * @returns Parsed struct fields keyed by field ID.
   */
  function readStruct(): Record<number, any> {
    const fields: Record<number, any> = {}
    let localLastFieldId = 0
    while (pos < buf.length) {
      const header = readByte()
      if (!header) {
        break
      }
      const compactType = header & 0xf
      const delta = (header >> 4) & 0xf
      const fieldId = delta ? localLastFieldId + delta : readZigzagInt()
      localLastFieldId = fieldId
      lastFieldId = fieldId
      lastType = compactType
      fields[fieldId] = readValue(compactType)
    }
    return fields
  }

  return readStruct()
}
