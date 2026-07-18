/**
 * Thrift types and constants
 */

import type { Buffer } from 'node:buffer'

export const THRIFT_TYPE = {
  STOP: 0,
  BOOL: 2,
  BYTE: 3,
  DOUBLE: 4,
  I16: 6,
  I32: 8,
  I64: 10,
  STRING: 11,
  STRUCT: 12,
  MAP: 13,
  SET: 14,
  LIST: 15,
} as const

export type ThriftType = (typeof THRIFT_TYPE)[keyof typeof THRIFT_TYPE]

export type ThriftScalarValue =
  | boolean
  | number
  | bigint
  | string
  | Buffer
  | null
export type ThriftMapEntries = Record<string, ThriftScalarValue>
export type ThriftMapValue = [
  keyType: ThriftType,
  valueType: ThriftType,
  entries: ThriftMapEntries,
]
export type ThriftListItems = ThriftScalarValue[]
export type ThriftListValue = [elementType: ThriftType, items: ThriftListItems]
export type ThriftStructValue = ThriftFieldTuple[]
export type ThriftFieldValue =
  | ThriftScalarValue
  | ThriftMapValue
  | ThriftListValue
  | ThriftStructValue
export type ThriftFieldTuple = [
  type: ThriftType,
  fieldId: number,
  value: ThriftFieldValue,
]
