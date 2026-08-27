import { expect, test } from 'bun:test'
import { resolveConversationNames } from './names.js'

test('synthesizes a legacy room title from participant names', async () => {
  let getChatsCalls = 0
  const service = {
    profile: { mid: 'u-self', displayName: 'Me' },
    nameCache: new Map<string, string>(),
    chatCache: new Map<string, any>(),
    client: {
      getChats: async () => {
        getChatsCalls += 1
        return []
      },
      getContacts: async (mids: string[]) =>
        mids.map((mid) => ({
          mid,
          displayName: mid === 'u-nadia' ? 'Nadia' : 'Yijun',
        })),
    },
    getRecentMessages: async () => [
      {
        from: 'u-nadia',
        contentMetadata: {
          MENTION: JSON.stringify({ MENTIONEES: [{ M: 'u-yijun' }] }),
        },
      },
      { from: 'u-self', contentMetadata: {} },
    ],
  }

  const names = await resolveConversationNames(service as any, ['r-room'])

  expect(names.get('r-room')).toBe('Nadia、Yijun')
  expect(service.chatCache.get('r-room')?.chatName).toBe('Nadia、Yijun')
  expect(getChatsCalls).toBe(0)
})
