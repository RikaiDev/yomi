/** TalkService contact-discovery client methods. */

import { describe, expect, test } from 'bun:test'
import { createTalkCommandClient } from './command-client.js'

function fakeRuntime(response: any = { fields: [{ u1: { mid: 'u1' } }] }) {
  const calls: Array<{ method: string; args: any[] }> = []
  const client = createTalkCommandClient({
    sendTalk: async (method: string, args: any[]) => {
      calls.push({ method, args })
      return response
    },
  } as any)
  return { client, calls }
}

describe('read-only contact discovery', () => {
  test('findContactByUserid calls findContactByUserid with a searchId', async () => {
    const { client, calls } = fakeRuntime({ fields: [{ mid: 'u1' }] })
    const result = await client.findContactByUserid('abc_123')
    expect(calls).toEqual([
      { method: 'findContactByUserid', args: [[11, 2, 'abc_123']] },
    ])
    expect(result).toEqual({ mid: 'u1' })
  })

  test('findContactsByPhone calls findContactsByPhone with a SET', async () => {
    const { client, calls } = fakeRuntime()
    await client.findContactsByPhone(['0912345678'])
    expect(calls).toEqual([
      {
        method: 'findContactsByPhone',
        args: [[14, 2, [11, ['0912345678']]]],
      },
    ])
  })

  test('findContactByUserTicket calls findContactByUserTicket', async () => {
    const { client, calls } = fakeRuntime()
    await client.findContactByUserTicket('ticket#abc')
    expect(calls).toEqual([
      { method: 'findContactByUserTicket', args: [[11, 2, 'ticket#abc']] },
    ])
  })

  test('read-only searches never call an add endpoint', async () => {
    const { client, calls } = fakeRuntime()
    await client.findContactByUserid('abc_123')
    await client.findContactsByPhone(['0912345678'])
    await client.findContactByUserTicket('ticket#abc')
    expect(calls.map((call) => call.method)).toEqual([
      'findContactByUserid',
      'findContactsByPhone',
      'findContactByUserTicket',
    ])
  })

  test('search methods throw on a TalkService error', async () => {
    const { client } = fakeRuntime({ error: 'TARGET_NOT_FOUND' })
    await expect(client.findContactByUserid('nobody')).rejects.toThrow(
      'findContactByUserid failed',
    )
  })
})

describe('add by identifier', () => {
  test('findAndAddContactByUserid calls findAndAddContactsByUserid', async () => {
    const { client, calls } = fakeRuntime()
    await client.findAndAddContactByUserid('abc_123')
    expect(calls).toEqual([
      {
        method: 'findAndAddContactsByUserid',
        args: [
          [8, 1, 0],
          [11, 2, 'abc_123'],
          [11, 3, '{"screen":"chat","spec":"native"}'],
        ],
      },
    ])
  })

  test('findAndAddContactsByPhone calls findAndAddContactsByPhone', async () => {
    const { client, calls } = fakeRuntime()
    await client.findAndAddContactsByPhone(['0912345678'])
    expect(calls).toEqual([
      {
        method: 'findAndAddContactsByPhone',
        args: [
          [8, 1, 0],
          [14, 2, [11, ['0912345678']]],
          [11, 3, '{"screen":"chat","spec":"native"}'],
        ],
      },
    ])
  })
})
