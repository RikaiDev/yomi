/**
 * LINE Protocol Message & Operation Parsers
 *
 * Transforms raw Thrift structs into domain objects.
 * Pure functions — no side effects, no network calls.
 */

export interface ParsedMessage {
  id: string | null
  from: string | null
  to: string | null
  toType: number
  createdTime: number | null
  deliveredTime: number | null
  text: string | null
  contentType: number
  contentMetadata: Record<string, any>
  chunks: any
}

export interface ParsedOperation {
  revision: number
  createdTime: number
  type: number
  reqSeq: number
  param1: string | null
  param2: string | null
  param3: string | null
  message: ParsedMessage | null
}

/**
 * Parse a raw Thrift message struct into a domain object.
 *
 * @param msg - Raw Thrift message struct
 * @returns Parsed message or null if invalid
 */
export function parseMessage(msg: any): ParsedMessage | null {
  if (!msg || typeof msg !== 'object') {
    return null
  }
  return {
    id: msg[4] || null,
    from: msg[1] || null,
    to: msg[2] || null,
    toType: msg[3],
    createdTime: typeof msg[5] === 'bigint' ? Number(msg[5]) : msg[5],
    deliveredTime:
      typeof msg[6] === 'bigint'
        ? Number(msg[6])
        : typeof msg[7] === 'bigint'
          ? Number(msg[7])
          : (msg[6] ?? msg[7]),
    text: msg[10] || null,
    contentType: msg[15] || 0,
    contentMetadata: msg[18] || {},
    chunks: msg[20] || null,
  }
}

/**
 * Parse raw message data into an array of message objects.
 *
 * @param data - Raw message data (array or single struct)
 * @returns Array of parsed message objects
 */
export function parseMessages(data: any): ParsedMessage[] {
  if (Array.isArray(data)) {
    return data.map((m) => parseMessage(m)).filter(Boolean) as ParsedMessage[]
  }
  if (data && typeof data === 'object') {
    return [parseMessage(data)].filter(Boolean) as ParsedMessage[]
  }
  return []
}

/**
 * Parse a raw Thrift operation struct into a domain object.
 *
 * @param op - Raw Thrift operation struct
 * @returns Parsed operation or null if invalid
 */
export function parseOperation(op: any): ParsedOperation | null {
  if (!op || typeof op !== 'object') {
    return null
  }
  return {
    revision: typeof op[1] === 'bigint' ? Number(op[1]) : op[1],
    createdTime: typeof op[2] === 'bigint' ? Number(op[2]) : op[2],
    type: op[3],
    reqSeq: op[4],
    param1: op[10] || null,
    param2: op[11] || null,
    param3: op[12] || null,
    message: op[20] && typeof op[20] === 'object' ? parseMessage(op[20]) : null,
  }
}
