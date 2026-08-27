import { describe, expect, test } from 'bun:test'
import { createSquareClient } from './client.js'

describe('SquareService client', () => {
  test('maps joined OpenChat rooms and their status', async () => {
    const calls: any[] = []
    const client = createSquareClient({
      sendCompact: async (...args: any[]) => {
        calls.push(args)
        return {
          fields: [
            {
              1: [{ 1: 't-chat', 2: 's-square', 4: '研究社群', 5: 'hash' }],
              3: {
                't-chat': {
                  3: { 1: { 4: 'message-1', 5: 1234, 10: 'hello' } },
                  4: 'Alice',
                  5: { 2: 3 },
                },
              },
              2: { 't-chat': { 1: 'p-me', 5: true } },
            },
          ],
        }
      },
    } as any)

    const chats = await client.getJoinedSquareChats()
    expect(chats).toEqual([
      {
        id: 't-chat',
        squareMid: 's-square',
        memberMid: 'p-me',
        name: '研究社群',
        pictureHash: 'hash',
        unreadCount: 3,
        lastMessage: { 4: 'message-1', 5: 1234, 10: 'hello' },
        lastSenderName: 'Alice',
        isMuted: false,
      },
    ])
    expect(calls[0][0]).toBe('/SQ1')
    expect(calls[0][1]).toBe('getJoinedSquareChats')
  })

  test('extracts received and sent messages from Square events', async () => {
    const calls: any[] = []
    const client = createSquareClient({
      sendCompact: async (_path: string, method: string, args: any[]) => {
        calls.push([method, args])
        if (method === 'getSquareMembers') {
          return {
            fields: [
              {
                1: {
                  'p-alice': {
                    1: 'p-alice',
                    3: 'Alice',
                    4: 'alice-avatar',
                  },
                  'p-me': { 1: 'p-me', 3: 'Me', 4: 'me-avatar' },
                },
              },
            ],
          }
        }
        if (method === 'getSquareMember') {
          const self = JSON.stringify(args).includes('p-me')
          return {
            fields: [
              {
                1: {
                  1: self ? 'p-me' : 'p-alice',
                  3: self ? 'Me' : 'Alice',
                  4: self ? 'me-avatar' : 'alice-avatar',
                },
              },
            ],
          }
        }
        return {
          fields: [
            {
              2: [
                {
                  2: 1000,
                  4: {
                    1: {
                      1: 't-chat',
                      2: {
                        1: { 1: 'p-alice', 2: 't-chat', 4: 'm1', 10: '嗨' },
                      },
                      3: 'Alice',
                    },
                  },
                },
                {
                  2: 2000,
                  4: {
                    2: {
                      1: 't-chat',
                      2: { 1: { 1: 'p-me', 2: 't-chat', 4: 'm2', 10: '你好' } },
                      4: 'Me',
                    },
                  },
                },
              ],
            },
          ],
        }
      },
    } as any)

    const messages = await client.getSquareChatMessages('t-chat')
    expect(
      messages.map((message) => [message.id, message.fromName, message.isSelf]),
    ).toEqual([
      ['m1', 'Alice', false],
      ['m2', 'Me', true],
    ])
    expect(messages[0].fromPictureUrl).toBe(
      'https://obs.line-scdn.net/alice-avatar',
    )
    const fetchArgs = calls.find(
      ([method]) => method === 'fetchSquareChatEvents',
    )?.[1]
    expect(JSON.stringify(fetchArgs)).toContain('[8,5,1]')
  })

  test('falls back to Desktop bootstrap events when joined-chat RPC is unavailable', async () => {
    const client = createSquareClient({
      sendCompact: async (_path: string, method: string) => {
        if (method === 'getJoinedSquareChats') throw new Error('501 NO XLT')
        return {
          fields: [
            {
              2: [
                {
                  4: {
                    17: {
                      1: { 1: 't-event-chat', 2: 's-square', 4: '事件社群' },
                      2: { 5: { 2: 2 } },
                      3: { 1: 'p-event-me' },
                    },
                  },
                },
              ],
            },
          ],
        }
      },
    } as any)

    const chats = await client.getJoinedSquareChats()
    expect(
      chats.map((chat) => [
        chat.id,
        chat.name,
        chat.unreadCount,
        chat.memberMid,
      ]),
    ).toEqual([['t-event-chat', '事件社群', 2, 'p-event-me']])
  })

  test('routes OpenChat text through SquareService sendMessage', async () => {
    const calls: any[] = []
    const runtime = {
      seq: 7,
      sendCompact: async (...args: any[]) => {
        calls.push(args)
        return { fields: [{ 1: { 1: { 4: 'created-message' } } }] }
      },
    }
    const client = createSquareClient(runtime as any)
    const sent = await client.sendSquareMessage('m-chat', 'hello')

    expect(calls[0][0]).toBe('/SQ1')
    expect(calls[0][1]).toBe('sendMessage')
    expect(JSON.stringify(calls[0][2])).toContain('m-chat')
    expect(JSON.stringify(calls[0][2])).toContain('hello')
    expect(sent).toEqual({ 1: { 4: 'created-message' } })
  })

  test('marks an OpenChat message read through SquareService', async () => {
    const calls: any[] = []
    const client = createSquareClient({
      sendCompact: async (...args: any[]) => {
        calls.push(args)
        return { fields: [{}] }
      },
    } as any)

    await client.markSquareChatRead('m-chat', 'message-9')

    expect(calls[0][0]).toBe('/SQ1')
    expect(calls[0][1]).toBe('markAsRead')
    expect(JSON.stringify(calls[0][2])).toContain('m-chat')
    expect(JSON.stringify(calls[0][2])).toContain('message-9')
  })

  test('normalizes the authoritative status latest message', async () => {
    const client = createSquareClient({
      sendCompact: async (_path: string, method: string) => {
        if (method === 'getSquareMember') {
          return {
            fields: [{ 1: { 1: { 1: 'p-seller', 3: 'Seller' } } }],
          }
        }
        return {
          fields: [
            {
              1: {
                3: {
                  1: {
                    1: 'p-seller',
                    4: 'latest-message',
                    6: 9999,
                    10: 'Newest item',
                    15: 0,
                  },
                },
                4: 'Seller',
              },
            },
          ],
        }
      },
    } as any)

    const latest = await client.getSquareChatLatestMessage('m-chat')

    expect(latest?.id).toBe('latest-message')
    expect(latest?.text).toBe('Newest item')
    expect(latest?.createdTime).toBe(9999)
  })
})
