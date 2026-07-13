/**
 * Thrift Binary Writer
 *
 * Writes Thrift protocol messages in binary format.
 *
 * @class TBinaryWriter
 */

import { THRIFT_TYPE } from '../types.js'
import { getBinaryTypeCodecDefinition } from './type-codec-dsl.js'

/**
 *
 */
export class TBinaryWriter {
  private buffer: number[] = []
  private readonly writeHandlers: Record<string, (value: unknown) => void>

  constructor() {
    this.writeHandlers = {
      writeBoolValue: (value) => this.writeByte((value as boolean) ? 1 : 0),
      writeByteValue: (value) => this.writeByte(value as number),
      writeI16Value: (value) => this.writeI16(value as number),
      writeI32Value: (value) => this.writeI32(value as number),
      writeI64Value: (value) => this.writeI64(Number(value)),
      writeStringValue: (value) => this.writeString(value as string),
    }
  }

  /**
   * Write a message
   *
   * @param {string} name - Method name
   * @param {number} seqId - Sequence ID
   * @param {Function} fieldsBuilder - Function to write fields
   */
  writeMessage(name: string, seqId: number, fieldsBuilder: () => void): void {
    this.buffer = []

    // Version 1 + message type
    this.writeI32(0x80010000 | 1)
    this.writeString(name)
    this.writeI32(seqId)

    fieldsBuilder()

    this.writeByte(THRIFT_TYPE.STOP)
  }

  /**
   * Write field header
   *
   * @param {number} id - Field ID
   * @param {number} type - Field type
   */
  writeFieldBegin(id: number, type: number): void {
    this.writeByte(type)
    this.writeI16(id)
  }

  /**
   * Write field stop
   */
  writeFieldStop(): void {
    this.writeByte(THRIFT_TYPE.STOP)
  }

  /**
   * Write byte
   *
   * @param {number} b - Byte value
   */
  writeByte(b: number): void {
    this.buffer.push(b & 0xff)
  }

  /**
   * Write 16-bit integer
   *
   * @param {number} n - Integer value
   */
  writeI16(n: number): void {
    this.buffer.push((n >> 8) & 0xff)
    this.buffer.push(n & 0xff)
  }

  /**
   * Write 32-bit integer
   *
   * @param {number} n - Integer value
   */
  writeI32(n: number): void {
    this.buffer.push((n >> 24) & 0xff)
    this.buffer.push((n >> 16) & 0xff)
    this.buffer.push((n >> 8) & 0xff)
    this.buffer.push(n & 0xff)
  }

  /**
   * Write 64-bit integer
   *
   * @param {number} n - Integer value
   */
  writeI64(n: number): void {
    this.writeI32(Math.floor(n / 0x100000000))
    this.writeI32(n & 0xffffffff)
  }

  /**
   * Write string
   *
   * @param {string} s - String value
   */
  writeString(s: string): void {
    const bytes = new TextEncoder().encode(s)
    this.writeI32(bytes.length)
    for (const b of bytes) {
      this.buffer.push(b)
    }
  }

  /**
   * Write list
   *
   * @param {number} elemType - Element type
   * @param {unknown[]} arr - Array of elements
   */
  writeList(elemType: number, arr: unknown[]): void {
    this.writeByte(elemType)
    this.writeI32(arr.length)
    for (const item of arr) {
      this.writeValue(elemType, item)
    }
  }

  /**
   * Write map
   *
   * @param {number} keyType - Key type
   * @param {number} valType - Value type
   * @param {Map} map - Map to write
   */
  writeMap(keyType: number, valType: number, map: Map<unknown, unknown>): void {
    this.writeByte(keyType)
    this.writeByte(valType)
    this.writeI32(map.size)
    for (const [key, val] of map) {
      this.writeValue(keyType, key)
      this.writeValue(valType, val)
    }
  }

  /**
   * Write value
   *
   * @param {number} type - Value type
   * @param {unknown} value - Value
   */
  writeValue(type: number, value: unknown): void {
    const definition = getBinaryTypeCodecDefinition(type)
    if (!definition) {
      throw new Error(`Unsupported type: ${type}`)
    }
    this.writeHandlers[definition.writeHandler](value)
  }

  /**
   * Get buffer as Uint8Array
   *
   * @returns {Uint8Array} Buffer
   */
  getBuffer(): Uint8Array {
    return new Uint8Array(this.buffer)
  }
}
