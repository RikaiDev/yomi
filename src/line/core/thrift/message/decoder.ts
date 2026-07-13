/**
 * TCompact response message decoder.
 */

import { readStructFields } from '../struct/reader.js'

/**
 * Decode a full TCompact response message from raw bytes.
 *
 * Parses the 2-byte protocol header, varint seqId, varint+bytes method name,
 * then delegates struct body parsing to readStructFields().
 *
 * @param data - Raw response bytes from the LINE server
 * @returns Decoded message with fields map, or an error object
 */
export function decodeResponseMessage(data: Uint8Array): {
  type?: string
  method?: string
  seqId?: number
  fields?: Record<number, any>
  error?: string
  raw?: string
} {
  if (!data || data.length < 2 || data[0] !== 0x82) {
    throw new Error('invalid')
  }
  let pos = 1

  const typeByte = data[pos++]
  const msgType = (typeByte >> 5) & 0x07

  let seqId = 0
  let shift = 0
  while (pos < data.length) {
    const b = data[pos++]
    seqId |= (b & 0x7f) << shift
    if (!(b & 0x80)) {
      break
    }
    shift += 7
  }

  let nameLen = 0
  shift = 0
  while (pos < data.length) {
    const b = data[pos++]
    nameLen |= (b & 0x7f) << shift
    if (!(b & 0x80)) {
      break
    }
    shift += 7
  }
  const name = new TextDecoder().decode(data.subarray(pos, pos + nameLen))
  pos += nameLen

  const fields = readStructFields(data.subarray(pos), true)
  const typeNames: Record<number, string> = {
    1: 'CALL',
    2: 'REPLY',
    3: 'EXCEPTION',
  }
  return {
    type: typeNames[msgType] || `?${msgType}`,
    method: name,
    seqId,
    fields,
  }
}
