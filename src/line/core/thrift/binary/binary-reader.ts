/**
 * Thrift Binary Reader
 *
 * Reads Thrift protocol messages in binary format.
 *
 * @class TBinaryReader
 */

import type { ThriftField } from '../types.js';
import { THRIFT_TYPE } from '../types.js';
import { getBinaryTypeCodecDefinition } from './type-codec-dsl.js';

/**
 *
 */
export class TBinaryReader {
  private buffer: Uint8Array;
  private offset: number = 0;
  private readonly readHandlers: Record<string, () => unknown>;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.readHandlers = {
      readBoolValue: () => this.readByte() !== 0,
      readByteValue: () => this.readByte(),
      readI16Value: () => this.readI16(),
      readI32Value: () => this.readI32(),
      readI64Value: () => this.readI64(),
      readStringValue: () => this.readString(),
    };
  }

  /**
   * Read message header
   *
   * @returns {{name: string, type: number, seqId: number}} Message header
   */
  readMessageBegin(): { name: string; type: number; seqId: number } {
    const versionType = this.readI32();
    const version = versionType & 0xFFFF0000;
    const type = versionType & 0x0000FFFF;

    if (version !== 0x8000) {
      throw new Error('Invalid version');
    }

    const name = this.readString();
    const seqId = this.readI32();

    return { name, type, seqId };
  }

  /**
   * Read message end
   */
  readMessageEnd(): void {
    // No-op for binary protocol
  }

  /**
   * Read field begin
   *
   * @returns {{type: number, id: number}} Field header
   */
  readFieldBegin(): { type: number; id: number } {
    const type = this.readByte();
    if (type === THRIFT_TYPE.STOP) {
      return { type: THRIFT_TYPE.STOP, id: 0 };
    }
    const id = this.readI16();
    return { type, id };
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
   * Read 16-bit integer
   *
   * @returns {number} Integer value
   */
  readI16(): number {
    const b1 = this.buffer[this.offset++];
    const b2 = this.buffer[this.offset++];
    return (b1 << 8) | b2;
  }

  /**
   * Read 32-bit integer
   *
   * @returns {number} Integer value
   */
  readI32(): number {
    const b1 = this.buffer[this.offset++];
    const b2 = this.buffer[this.offset++];
    const b3 = this.buffer[this.offset++];
    const b4 = this.buffer[this.offset++];
    return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
  }

  /**
   * Read 64-bit integer
   *
   * @returns {number} Integer value
   */
  readI64(): number {
    const hi = this.readI32();
    const lo = this.readI32();
    return hi * 0x100000000 + lo;
  }

  /**
   * Read string
   *
   * @returns {string} String value
   */
  readString(): string {
    const len = this.readI32();
    const bytes = this.buffer.slice(this.offset, this.offset + len);
    this.offset += len;
    return new TextDecoder().decode(bytes);
  }

  /**
   * Read value by type
   *
   * @param {number} type - Value type
   * @returns {unknown} Value
   */
  readValue(type: number): unknown {
    const definition = getBinaryTypeCodecDefinition(type);
    if (!definition) {
      throw new Error(`Unsupported type: ${type}`);
    }
    return this.readHandlers[definition.readHandler]();
  }

  /**
   * Read struct fields
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
