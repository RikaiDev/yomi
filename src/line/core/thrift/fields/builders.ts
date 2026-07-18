/**
 * TCompact field builders.
 */

import type {
  ThriftFieldTuple,
  ThriftListItems,
  ThriftListValue,
  ThriftMapEntries,
  ThriftMapValue,
  ThriftScalarValue,
  ThriftStructValue,
  ThriftType,
} from '../types.js'

/**
 * Build a generic thrift field tuple.
 *
 * @param type - Thrift wire type.
 * @param fieldId - Thrift field ID.
 * @param value - Field value.
 * @returns Thrift field tuple.
 */
function field(
  type: ThriftType,
  fieldId: number,
  value:
    | ThriftScalarValue
    | ThriftListValue
    | ThriftMapValue
    | ThriftStructValue,
): ThriftFieldTuple {
  return [type, fieldId, value]
}

/**
 * Build a BOOL field tuple.
 *
 * @param fieldId - Thrift field ID.
 * @param value - Boolean value.
 * @returns Thrift field tuple.
 */
export function boolField(fieldId: number, value: boolean): ThriftFieldTuple {
  return field(2, fieldId, value)
}

/**
 * Build a BYTE field tuple.
 *
 * @param fieldId - Thrift field ID.
 * @param value - Byte value.
 * @returns Thrift field tuple.
 */
export function byteField(fieldId: number, value: number): ThriftFieldTuple {
  return field(3, fieldId, value)
}

/**
 * Build an I32 field tuple.
 *
 * @param fieldId - Thrift field ID.
 * @param value - I32 value.
 * @returns Thrift field tuple.
 */
export function i32Field(fieldId: number, value: number): ThriftFieldTuple {
  return field(8, fieldId, value)
}

/**
 * Build an I64 field tuple.
 *
 * @param fieldId - Thrift field ID.
 * @param value - I64 value.
 * @returns Thrift field tuple.
 */
export function i64Field(
  fieldId: number,
  value: number | bigint,
): ThriftFieldTuple {
  return field(10, fieldId, value)
}

/**
 * Build a STRING/BINARY field tuple.
 *
 * @param fieldId - Thrift field ID.
 * @param value - String or buffer value.
 * @returns Thrift field tuple.
 */
export function stringField(
  fieldId: number,
  value: string | Buffer | null,
): ThriftFieldTuple {
  return field(11, fieldId, value)
}

/**
 * Build a STRUCT field tuple.
 *
 * @param fieldId - Thrift field ID.
 * @param fields - Nested struct fields.
 * @returns Thrift field tuple.
 */
export function structField(
  fieldId: number,
  fields: ThriftFieldTuple[],
): ThriftFieldTuple {
  return field(12, fieldId, fields)
}

/**
 * Build a MAP field tuple.
 *
 * @param fieldId - Thrift field ID.
 * @param keyType - Key thrift type.
 * @param valueType - Value thrift type.
 * @param entries - Map entries.
 * @returns Thrift field tuple.
 */
export function mapField(
  fieldId: number,
  keyType: ThriftType,
  valueType: ThriftType,
  entries: ThriftMapEntries,
): ThriftFieldTuple {
  return field(13, fieldId, [keyType, valueType, entries])
}

/**
 * Build a LIST field tuple.
 *
 * @param fieldId - Thrift field ID.
 * @param elementType - Element thrift type.
 * @param items - List items.
 * @returns Thrift field tuple.
 */
export function listField(
  fieldId: number,
  elementType: ThriftType,
  items: ThriftListItems,
): ThriftFieldTuple {
  return field(15, fieldId, [elementType, items])
}

/**
 * Build a SET field tuple.
 *
 * A thrift SET (type 14) is wire-identical to a LIST in TCompact — same
 * element-type/count header and element payload — only the field header's
 * type nibble differs. LINE distinguishes them: e.g. inviteIntoChat /
 * deleteOtherFromChat / createChat read `targetUserMids` as a SET and see an
 * empty collection if it arrives as a LIST.
 *
 * @param fieldId - Thrift field ID.
 * @param elementType - Element thrift type.
 * @param items - Set items.
 * @returns Thrift field tuple.
 */
export function setField(
  fieldId: number,
  elementType: ThriftType,
  items: ThriftListItems,
): ThriftFieldTuple {
  return field(14, fieldId, [elementType, items])
}
