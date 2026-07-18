/**
 * TCompact primitive encoding helpers.
 */

import { Buffer } from 'node:buffer'

/**
 * Encode an unsigned integer as a base-128 varint.
 *
 * @param value - The number to encode.
 * @returns Encoded varint buffer.
 */
export function varint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value >>> 0
  do {
    let byte = remaining & 0x7f
    remaining >>>= 7
    if (remaining) {
      byte |= 0x80
    }
    bytes.push(byte)
  } while (remaining)
  return Buffer.from(bytes)
}

/**
 * Encode a signed 32-bit integer using ZigZag encoding.
 *
 * @param value - Signed 32-bit integer.
 * @returns Encoded varint buffer.
 */
export function zigzag(value: number): Buffer {
  return varint(((value << 1) ^ (value >> 31)) >>> 0)
}

/**
 * Encode an unsigned bigint as a base-128 varint.
 *
 * @param value - Bigint to encode.
 * @returns Encoded varint buffer.
 */
function varintBig(value: bigint): Buffer {
  const bytes: number[] = []
  let remaining = value
  if (remaining < 0n) {
    remaining += 1n << 64n
  }
  do {
    let byte = Number(remaining & 0x7fn)
    remaining >>= 7n
    if (remaining) {
      byte |= 0x80
    }
    bytes.push(byte)
  } while (remaining)
  return Buffer.from(bytes)
}

/**
 * Encode a signed 64-bit integer using ZigZag encoding.
 *
 * @param value - Signed 64-bit integer.
 * @returns Encoded varint buffer.
 */
export function zigzag64(value: any): Buffer {
  const bigintValue = BigInt(value)
  return varintBig((bigintValue << 1n) ^ (bigintValue >> 63n))
}
