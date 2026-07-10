import { Buffer } from 'node:buffer';
import https from 'node:https';
import { LINE_APP_CONFIG } from '../../core/config.js';
import { parseMessages } from '../parsers.js';

interface MessageBoxV2MessageId {
  deliveredTime: number;
  messageId: string;
}

const writeI32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
};

const writeI16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
};

const writeI64 = (value: bigint | number | string): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(value));
  return buffer;
};

const writeString = (value: string): Buffer => {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([writeI32(body.length), body]);
};

const writeFieldHeader = (type: number, id: number): Buffer => {
  return Buffer.concat([Buffer.from([type]), writeI16(id)]);
};

let writeValue: (type: number, value: any) => Buffer;

const writeStruct = (fields: Array<[number, number, any]>): Buffer => {
  return Buffer.concat([
    ...fields.map(([type, id, value]) => Buffer.concat([writeFieldHeader(type, id), writeValue(type, value)])),
    Buffer.from([0]),
  ]);
};

writeValue = (type: number, value: any): Buffer => {
  if (type === 10) {
    return writeI64(value);
  }
  if (type === 11) {
    return writeString(String(value));
  }
  if (type === 12) {
    return writeStruct(value);
  }
  if (type === 15) {
    const [elementType, items] = value;
    return Buffer.concat([
      Buffer.from([elementType]),
      writeI32(items.length),
      ...items.map((item: any) => writeValue(elementType, item)),
    ]);
  }
  throw new Error(`Unsupported TBinary write type: ${type}`);
};

const encodeBinaryCallMessage = (method: string, seqId: number, fields: Array<[number, number, any]>): Buffer => {
  return Buffer.concat([
    writeI32(0x80010001),
    writeString(method),
    writeI32(seqId),
    writeStruct(fields),
  ]);
};

const readI32 = (buffer: Buffer, state: { position: number }): number => {
  const value = buffer.readInt32BE(state.position);
  state.position += 4;
  return value;
};

const readU32 = (buffer: Buffer, state: { position: number }): number => {
  const value = buffer.readUInt32BE(state.position);
  state.position += 4;
  return value;
};

const readI16 = (buffer: Buffer, state: { position: number }): number => {
  const value = buffer.readInt16BE(state.position);
  state.position += 2;
  return value;
};

const readI64 = (buffer: Buffer, state: { position: number }): string => {
  const value = buffer.readBigInt64BE(state.position);
  state.position += 8;
  return value.toString();
};

const readString = (buffer: Buffer, state: { position: number }): string => {
  const length = readI32(buffer, state);
  const value = buffer.subarray(state.position, state.position + length).toString('utf8');
  state.position += length;
  return value;
};

let readValue: (buffer: Buffer, state: { position: number }, type: number) => any;

const readStruct = (buffer: Buffer, state: { position: number }): Record<number, any> => {
  const fields: Record<number, any> = {};
  while (state.position < buffer.length) {
    const type = buffer[state.position];
    state.position += 1;
    if (type === 0) {
      break;
    }
    const id = readI16(buffer, state);
    fields[id] = readValue(buffer, state, type);
  }
  return fields;
};

readValue = (buffer: Buffer, state: { position: number }, type: number): any => {
  if (type === 2) {
    const value = Boolean(buffer[state.position]);
    state.position += 1;
    return value;
  }
  if (type === 3) {
    const value = buffer[state.position];
    state.position += 1;
    return value;
  }
  if (type === 8) {
    return readI32(buffer, state);
  }
  if (type === 10) {
    return readI64(buffer, state);
  }
  if (type === 11) {
    return readString(buffer, state);
  }
  if (type === 12) {
    return readStruct(buffer, state);
  }
  if (type === 13) {
    const keyType = buffer[state.position];
    const valueType = buffer[state.position + 1];
    state.position += 2;
    const length = readI32(buffer, state);
    const entries: Record<string, any> = {};
    for (let index = 0; index < length; index += 1) {
      entries[String(readValue(buffer, state, keyType))] = readValue(buffer, state, valueType);
    }
    return entries;
  }
  if (type === 15) {
    const elementType = buffer[state.position];
    state.position += 1;
    const length = readI32(buffer, state);
    const items: any[] = [];
    for (let index = 0; index < length; index += 1) {
      items.push(readValue(buffer, state, elementType));
    }
    return items;
  }
  throw new Error(`Unsupported TBinary read type: ${type}`);
};

const decodeBinaryResponseMessage = (buffer: Buffer) => {
  const state = { position: 0 };
  readU32(buffer, state);
  const method = readString(buffer, state);
  const seqId = readI32(buffer, state);
  const fields = readStruct(buffer, state);
  return { fields, method, seqId };
};

const postBinary = (host: string, path: string, body: Buffer, token: string): Promise<{ body: Buffer; nextToken?: string; statusCode?: number }> => {
  return new Promise((resolve, reject) => {
    const request = https.request({
      headers: {
        'accept': 'application/x-thrift',
        'Content-Length': body.length,
        'Content-Type': 'application/x-thrift',
        'User-Agent': LINE_APP_CONFIG.userAgent,
        'X-Line-Access': token,
        'X-Line-Application': LINE_APP_CONFIG.lineApp,
        'x-lal': 'ja_JP',
        'x-lpv': '1',
      },
      hostname: host,
      method: 'POST',
      path,
      port: 443,
      timeout: 30000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const nextToken = response.headers['x-line-next-access'];
        resolve({
          body: Buffer.concat(chunks),
          nextToken: typeof nextToken === 'string' ? nextToken : undefined,
          statusCode: response.statusCode,
        });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.write(body);
    request.end();
  });
};

const buildMessageIdStruct = (messageId: MessageBoxV2MessageId): Array<[number, number, any]> => {
  return [
    [10, 1, messageId.deliveredTime],
    [10, 2, messageId.messageId],
  ];
};

/**
 * Fetch message payloads by MessageBoxV2 ids through the legacy /S3 endpoint.
 *
 * LINE only accepts one messagesByIds request part per call on this route.
 *
 * @param runtime - Active LINE client runtime.
 * @param messageBoxId - Conversation id.
 * @param messageIds - MessageBoxV2 ids to resolve.
 * @returns Parsed LINE messages.
 */
export async function fetchMessagesByIds(runtime: any, messageBoxId: string, messageIds: MessageBoxV2MessageId[]) {
  const messages: any[] = [];
  for (const messageId of messageIds) {
    const requestPart: Array<[number, number, any]> = [
      [11, 1, messageBoxId],
      [15, 2, [12, [buildMessageIdStruct(messageId)]]],
    ];
    const body = encodeBinaryCallMessage('getMessagesByIds', runtime.seq++, [
      [15, 2, [12, [requestPart]]],
    ]);
    const response = await postBinary(runtime.host, '/S3', body, runtime.authToken);
    if (response.nextToken) {
      runtime.authToken = response.nextToken;
      runtime.emit?.('tokenRotated', response.nextToken);
    }
    if (!response.body.length) {
      continue;
    }
    const decoded = decodeBinaryResponseMessage(response.body);
    const exception = decoded.fields?.[1];
    if (exception) {
      throw new Error(`getMessagesByIds failed: ${exception[2] || JSON.stringify(exception)}`);
    }
    const rawMessages = decoded.fields?.[0];
    if (Array.isArray(rawMessages)) {
      messages.push(...parseMessages(rawMessages));
    }
  }
  return messages;
}

export type { MessageBoxV2MessageId };
