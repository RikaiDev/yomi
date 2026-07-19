import { describe, expect, test } from 'bun:test'
import type { SearchResult } from '../../search/store.js'
import { applyConversationDiversity, fuseByRrf } from './search.js'

function hit(messageId: string, chatId: string): SearchResult {
  return {
    chatId,
    chatName: chatId,
    messageId,
    fromName: null,
    text: messageId,
    createdTime: null,
  }
}

describe('search ranking', () => {
  test('RRF rewards agreement across retrievers', () => {
    const fused = fuseByRrf(
      [
        [hit('keyword-only', 'a'), hit('both', 'b')],
        [hit('semantic-only', 'c'), hit('both', 'b')],
      ],
      3,
    )
    expect(fused[0].messageId).toBe('both')
  })

  test('diversifies chats before backfilling deferred matches', () => {
    const rows = [
      hit('a1', 'a'),
      hit('a2', 'a'),
      hit('a3', 'a'),
      hit('b1', 'b'),
      hit('c1', 'c'),
    ]
    expect(
      applyConversationDiversity(rows, 4, 1).map((row) => row.messageId),
    ).toEqual(['a1', 'b1', 'c1', 'a2'])
  })
})
