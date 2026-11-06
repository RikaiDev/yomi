/**
 * Regression tests: the unread digest and conversation list must cover the
 * whole inbox. LINE returns message boxes in chat-MID order one page at a
 * time, so reading a single page dropped every 1:1 chat past the page.
 */

import { describe, expect, test } from 'bun:test'
import {
  handleGetUnreadDigest,
  handleListConversations,
} from './conversations.js'

function box(id: string, unreadCount: number, deliveredTime: number) {
  return {
    id,
    unreadCount,
    lastDeliveredMessageId: { deliveredTime, messageId: `m-${id}` },
    lastMessages: [],
  }
}

function createService(boxes: any[]) {
  const calls = { all: 0, single: 0 }
  const service: any = {
    chatCache: new Map(),
    nameCache: new Map(),
    e2eeManager: {},
    sessionState: undefined,
    getRecentMessages: async () => [],
    client: {
      syncLongPoll: async () => {},
      getAllMessageBoxes: async () => {
        calls.all += 1
        return { messageBoxes: boxes, hasNext: false }
      },
      getMessageBoxes: async () => {
        calls.single += 1
        return { messageBoxes: boxes.slice(0, 1), hasNext: true }
      },
      getChats: async () => [],
      getContacts: async () => [],
      getContact: async () => null,
      getJoinedSquareChats: async () => [],
    },
  }
  return { service, calls }
}

const INBOX = [
  box('c0001', 1, 100),
  box('m0002', 0, 500),
  box('uaaaa', 2, 900),
  box('uzzzz', 1, 1000),
]

describe('handleGetUnreadDigest', () => {
  test('lists unread chats from every page, newest activity first', async () => {
    const { service, calls } = createService(INBOX)
    const result = await handleGetUnreadDigest(service, {})
    const text = result.content[0].text as string

    expect(calls.all).toBe(1)
    expect(calls.single).toBe(0)
    expect(text).toContain('uzzzz')
    expect(text.indexOf('uzzzz')).toBeLessThan(text.indexOf('uaaaa'))
    expect(text.indexOf('uaaaa')).toBeLessThan(text.indexOf('c0001'))
    expect(text).not.toContain('m0002')
  })

  test('limit keeps the most recent chats and says it truncated', async () => {
    const { service } = createService(INBOX)
    const result = await handleGetUnreadDigest(service, { limit: 1 })
    const text = result.content[0].text as string

    expect(text).toContain('uzzzz')
    expect(text).not.toContain('uaaaa')
    expect(result.content[1].text).toContain('1 most recently active of 3')
  })
})

describe('handleListConversations', () => {
  test('limit returns the most recently active chats, not the lowest MIDs', async () => {
    const { service, calls } = createService(INBOX)
    const result = await handleListConversations(service, { limit: 2 })
    const text = result.content[0].text as string

    expect(calls.single).toBe(0)
    expect(text).toContain('uzzzz')
    expect(text).toContain('uaaaa')
    expect(text).not.toContain('c0001')
  })
})
