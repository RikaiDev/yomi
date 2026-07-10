/**
 * Thrift Compact Writer
 *
 * Writes Thrift protocol messages in compact binary format.
 *
 * @class TCompactWriter
 */

import { THRIFT_TYPE } from '../types.js';
import { getCompactTypeCodecDefinition } from './type-codec-dsl.js';

/**
 *
 */
export class TCompactWriter {
  private buffer: number[] = [];
  private lastFieldId: number = 0;
  private readonly writeHandlers: Record<string, (value: unknown) => void>;

  constructor() {
    this.writeHandlers = {
      writeBoolValue: value => this.writeByte((value as boolean) ? 1 : 0),
      writeByteValue: value => this.writeByte(value as number),
      writeI16Value: value => this.writeZigzag32(value as number),
      writeI32Value: value => this.writeZigzag32(value as number),
      writeI64Value: value => this.writeZigzag64(Number(value)),
      writeStringValue: value => this.writeString(value as string),
    };
  }

  /**
   * Write message header
   *
   * @param {string} name - Method name
   * @param {number} seqId - Sequence ID
   * @param {Function} fieldsBuilder - Function to write fields
   */
  writeMessage(name: string, seqId: number, fieldsBuilder: () => void): void {
    this.buffer = [];
    this.lastFieldId = 0;

    // Protocol version + type
    this.writeVarint32(0x820100 | 1);
    this.writeString(name);
    this.writeVarint32(seqId);

    fieldsBuilder();
    this.writeByte(THRIFT_TYPE.STOP);
  }

  /**
   * Write field header
   *
   * @param {number} id - Field ID
   * @param {number} type - Field type
   */
  writeFieldBegin(id: number, type: number): void {
    const delta = id - this.lastFieldId;
    if (delta > 0 && delta <= 15) {
      this.writeByte((delta << 4) | type);
    }
    else {
      this.writeByte(type);
      this.writeVarint32(id);
    }
    this.lastFieldId = id;
  }

  /**
   * Write field stop
   */
  writeFieldStop(): void {
    this.writeByte(THRIFT_TYPE.STOP);
  }

  /**
   * Write byte
   *
   * @param {number} b - Byte value
   */
  writeByte(b: number): void {
    this.buffer.push(b & 0xFF);
  }

  /**
   * Write varint32
   *
   * @param {number} n - Integer value
   */
  writeVarint32(n: number): void {
    while (n > 0x7F) {
      this.buffer.push((n & 0x7F) | 0x80);
      n >>= 7;
    }
    this.buffer.push(n);
  }

  /**
   * Write varint64
   *
   * @param {number} n - Integer value
   */
  writeVarint64(n: number): void {
    while (n > 0x7F) {
      this.buffer.push((n & 0x7F) | 0x80);
      n >>= 7;
    }
    this.buffer.push(n);
  }

  /**
   * Write zigzag encoded 32-bit integer
   *
   * @param {number} n - Integer value
   */
  writeZigzag32(n: number): void {
    this.writeVarint32((n << 1) ^ (n >> 31));
  }

  /**
   * Write zigzag encoded 64-bit integer
   *
   * @param {number} n - Integer value
   */
  writeZigzag64(n: number): void {
    this.writeVarint64((n << 1) ^ (n >> 63));
  }

  /**
   * Write string
   *
   * @param {string} s - String value
   */
  writeString(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.writeVarint32(bytes.length);
    for (const b of bytes) {
      this.buffer.push(b);
    }
  }

  /**
   * Write list
   *
   * @param {number} elemType - Element type
   * @param {unknown[]} arr - Array of elements
   */
  writeList(elemType: number, arr: unknown[]): void {
    this.writeByte(elemType);
    this.writeVarint32(arr.length);
    for (const item of arr) {
      this.writeValue(elemType, item);
    }
  }

  /**
   * Write value
   *
   * @param {number} type - Value type
   * @param {unknown} value - Value
   */
  writeValue(type: number, value: unknown): void {
    const definition = getCompactTypeCodecDefinition(type);
    if (!definition) {
      throw new Error(`Unsupported type: ${type}`);
    }
    this.writeHandlers[definition.writeHandler](value);
  }

  /**
   * Get buffer
   *
   * @returns {Uint8Array} Buffer
   */
  getBuffer(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}
