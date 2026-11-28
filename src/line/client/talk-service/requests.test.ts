/** Request-builder tests for TalkService contact discovery. */

import { describe, expect, test } from 'bun:test'
import {
  buildFindAndAddContactsByPhoneRequest,
  buildFindAndAddContactsByUseridRequest,
  buildFindContactByUseridRequest,
  buildFindContactByUserTicketRequest,
  buildFindContactsByPhoneRequest,
} from './requests.js'

describe('contact discovery request builders', () => {
  test('findContactByUserid sends only the searchId field', () => {
    expect(buildFindContactByUseridRequest('abc_123')).toEqual([
      [11, 2, 'abc_123'],
    ])
  })

  test('findContactsByPhone sends phones as a THRIFT SET', () => {
    expect(buildFindContactsByPhoneRequest(['0912345678'])).toEqual([
      [14, 2, [11, ['0912345678']]],
    ])
  })

  test('findContactByUserTicket sends only the ticket field', () => {
    expect(buildFindContactByUserTicketRequest('ticket#abc')).toEqual([
      [11, 2, 'ticket#abc'],
    ])
  })

  test('findAndAddContactsByUserid sends reqSeq, searchId and reference', () => {
    expect(buildFindAndAddContactsByUseridRequest('abc_123')).toEqual([
      [8, 1, 0],
      [11, 2, 'abc_123'],
      [11, 3, '{"screen":"chat","spec":"native"}'],
    ])
  })

  test('findAndAddContactsByPhone sends phones as a THRIFT SET', () => {
    expect(buildFindAndAddContactsByPhoneRequest(['0912345678'])).toEqual([
      [8, 1, 0],
      [14, 2, [11, ['0912345678']]],
      [11, 3, '{"screen":"chat","spec":"native"}'],
    ])
  })
})
