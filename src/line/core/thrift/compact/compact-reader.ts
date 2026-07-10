/**
 * Thrift Compact Reader
 *
 * Reads Thrift protocol messages in compact binary format.
 *
 * @class TCompactReader
 */

import type { ThriftField } from '../types.js';
import { THRIFT_TYPE } from '../types.js';
import { getCompactTypeCodecDefinition } from './type-codec-dsl.js';

/**
 *
 */
export class TCompactReader {
  private buffer: Uint8Array;
  private offset: number = 0;
  private lastFieldId: number = 0;
  private readonly readHandlers: Record<string, () => unknown>;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.readHandlers = {
      readBoolValue: () => this.readByte() !== 0,
      readByteValue: () => this.readByte(),
      readI16Value: () => this.readZigzag32(),
      readI32Value: () => this.readZigzag32(),
      readI64Value: () => this.readZigzag64(),
      readStringValue: () => this.readString(),
    };
  }

  /**
   * Read message header
   *
   * @returns {{name: string, type: number, seqId: number}} Message header
   */
  readMessageBegin(): { name: string; type: number; seqId: number } {
    const protocolId = this.readVarint32();
    if ((protocolId & 0xFF000000) !== 0x82010000) {
      throw new Error('Invalid compact protocol');
    }

    const type = (protocolId >> 4) & 0x0F;
    const name = this.readString();
    const seqId = this.readVarint32();

    return { name, type, seqId };
  }

  /**
   * Read message end
   */
  readMessageEnd(): void {
    // No-op
  }

  /**
   * Read field begin
   *
   * @returns {{type: number, id: number}} Field header
   */
  readFieldBegin(): { type: number; id: number } {
    const header = this.readByte();
    if ((header & 0x0F) === THRIFT_TYPE.STOP) {
      return { type: THRIFT_TYPE.STOP, id: 0 };
    }

    const delta = (header >> 4) & 0x0F;
    const type = header & 0x0F;

    if (delta > 0) {
      this.lastFieldId += delta;
    }
    else {
      this.lastFieldId = this.readVarint32();
    }

    return { type, id: this.lastFieldId };
  }

  /**
   * Read field end
   */
  readFieldEnd(): void {
    // No-op
  }

  /**
   * Read byte
   *
   * @returns {number} Byte value
   */
  readByte(): number {
    return this.buffer[this.offset++];
  }

  /**
   * Read varint32
   *
   * @returns {number} Integer value
   */
  readVarint32(): number {
    let result = 0;
    let shift = 0;

    while (true) {
      const b = this.readByte();
      result |= (b & 0x7F) << shift;
      if ((b & 0x80) === 0) {
        break;
      }
      shift += 7;
    }

    return result;
  }

  /**
   * Read zigzag32
   *
   * @returns {number} Integer value
   */
  readZigzag32(): number {
    const n = this.readVarint32();
    return (n >>> 1) ^ -(n & 1);
  }

  /**
   * Read zigzag64
   *
   * @returns {number} Integer value
   */
  readZigzag64(): number {
    const n = this.readVarint64();
    return (n >>> 1) ^ -(n & 1);
  }

  /**
   * Read varint64
   *
   * @returns {number} Integer value
   */
  readVarint64(): number {
    let result = 0n;
    let shift = 0;

    while (true) {
      const b = this.readByte();
      result |= BigInt(b & 0x7F) << BigInt(shift);
      if ((b & 0x80) === 0) {
        break;
      }
      shift += 7;
    }

    return Number(result);
  }

  /**
   * Read string
   *
   * @returns {string} String value
   */
  readString(): string {
    const len = this.readVarint32();
    const bytes = this.buffer.slice(this.offset, this.offset + len);
    this.offset += len;
    return new TextDecoder().decode(bytes);
  }

  /**
   * Read value
   *
   * @param {number} type - Value type
   * @returns {unknown} Value
   */
  readValue(type: number): unknown {
    const definition = getCompactTypeCodecDefinition(type);
    if (!definition) {
      throw new Error(`Unsupported type: ${type}`);
    }
    return this.readHandlers[definition.readHandler]();
  }

  /**
   * Read struct
   *
   * @returns {ThriftField[]} Fields
   */
  readStruct(): ThriftField[] {
    const fields: ThriftField[] = [];

    while (true) {
      const { type, id } = this.readFieldBegin();
      if (type === THRIFT_TYPE.STOP) {
        break;
      }

      const value = this.readValue(type) as import('../types.js').ThriftFieldValue;
      fields.push({ id, type: type as import('../types.js').ThriftType, value });
      this.readFieldEnd();
    }

    return fields;
  }
}
