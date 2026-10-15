import { expect, test } from 'bun:test'
import type { LineProtocolService } from '../line/core/service.js'
import { handleFindContact, handleListContacts } from './handlers/contacts.js'
import {
  contactDisplayName,
  resolveConversationNames,
  resolveUserNames,
} from './names.js'

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

const contacts = [
  {
    mid: 'u1',
    displayName: 'Alex',
    displayNameOverridden: 'School - Alex (dad)',
  },
  { mid: 'u2', displayName: 'Liz', displayNameOverridden: null },
]

function fakeService() {
  return {
    nameCache: new Map<string, string>(),
    client: {
      getContacts: async (mids: string[]) =>
        contacts.filter((c) => mids.includes(c.mid)),
      getAllContactIds: async () => contacts.map((c) => c.mid),
    },
  } as unknown as LineProtocolService
}

test('contactDisplayName prefers the user-set name, then the profile name', () => {
  expect(contactDisplayName(contacts[0])).toBe('School - Alex (dad)')
  expect(contactDisplayName(contacts[1])).toBe('Liz')
  expect(
    contactDisplayName({ displayName: null, displayNameOverridden: null }),
  ).toBeNull()
  expect(contactDisplayName(null)).toBeNull()
})

test('resolveUserNames returns and caches the user-set name', async () => {
  const service = fakeService()
  const names = await resolveUserNames(service, ['u1', 'u2'])
  expect(names.get('u1')).toBe('School - Alex (dad)')
  expect(names.get('u2')).toBe('Liz')
  expect(service.nameCache.get('u1')).toBe('School - Alex (dad)')
})

test('list_contacts shows the user-set name and keeps the profile name', async () => {
  const res = await handleListContacts(fakeService())
  const text = res.content[0].text
  expect(text).toContain('School - Alex (dad)')
  expect(text).toContain('Alex')
})

test('find_contact matches either the user-set name or the profile name', async () => {
  const byNickname = await handleFindContact(fakeService(), {
    name: 'school',
  })
  const byProfile = await handleFindContact(fakeService(), { name: 'alex' })
  expect(byNickname.content[0].text).toContain('u1')
  expect(byProfile.content[0].text).toContain('u1')
  expect(byProfile.content[0].text).not.toContain('u2')
})
