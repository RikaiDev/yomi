import { expect, test } from 'bun:test'
import { listField, setField } from '../fields/builders.js'
import { writeFieldsArray } from './writer.js'

/**
 * A LINE SET field (e.g. inviteIntoChat/createChat `targetUserMids`) must go on
 * the wire as TCompact type 10, distinct from a LIST (type 9). Encoding a set
 * as a list makes LINE read it as empty — the exact `targetUserMids is empty`
 * failure. The element payload is identical between the two; only the field
 * header's low nibble differs.
 */
test('setField encodes TCompact type 10; listField encodes type 9', () => {
  const items = ['ab', 'cd']
  const asSet = writeFieldsArray([setField(3, 11, items)], { v: 0 })
  const asList = writeFieldsArray([listField(3, 11, items)], { v: 0 })

  // Field 3 with delta 3 from 0 → header byte = (delta << 4) | compactType.
  expect(asSet[0]).toBe((3 << 4) | 10)
  expect(asList[0]).toBe((3 << 4) | 9)

  // Everything after the field header (the collection payload) is identical.
  expect(asSet.subarray(1)).toEqual(asList.subarray(1))
})

test('setField payload carries the element-type/count header and items', () => {
  const encoded = writeFieldsArray([setField(1, 11, ['x'])], { v: 0 })
  // header (0x1A: delta 1, type 10), collection header (0x18: count 1, string
  // element type 8), then varint length 1 and the byte 'x'.
  expect([...encoded]).toEqual([0x1a, 0x18, 0x01, 0x78])
})
