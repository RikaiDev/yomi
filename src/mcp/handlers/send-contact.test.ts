/**
 * `send_contact` writes its display name into a card the *recipient* reads, so
 * that name must always be the contact's own profile name. The shared name
 * cache holds the name the user gave a friend locally in LINE, which is a
 * private label; it drives everything shown to the user, but it must never be
 * what gets shared with someone else.
 */

import { expect, test } from 'bun:test'
import { createDirectoryRuntimeService } from '../../line/core/directory-runtime-service.js'
import { handleListContacts } from './contacts.js'
import { handleSendContact } from './send.js'

const FRIEND = {
  mid: 'u-alex',
  displayName: 'Alex', // contact-query field 22: the friend's own name
  displayNameOverridden: 'School - Alex (dad)', // field 27: the user's private alias
}

function buildService() {
  const nameCache = new Map<string, string>()
  const shared: Array<{ chatId: string; mid: string; displayName: string }> = []
  let getContactCalls = 0

  const service: any = {
    nameCache,
    chatCache: new Map<string, any>(),
    profile: { mid: 'u-self', displayName: 'Me' },
    client: {
      getContacts: async (mids: string[]) =>
        mids.includes(FRIEND.mid) ? [{ ...FRIEND }] : [],
      getAllContactIds: async () => [FRIEND.mid],
      getContact: async (mid: string) => {
        getContactCalls += 1
        return { mid, ...FRIEND }
      },
    },
    getRecentMessages: async () => [],
    markChatRead: async () => ({}),
    sendContact: async (chatId: string, mid: string, displayName: string) => {
      shared.push({ chatId, mid, displayName })
      return { messageId: 'sent' }
    },
  }
  // The real directory runtime, so the cache read path is the shipping one.
  Object.assign(
    service,
    createDirectoryRuntimeService({ ...service, client: service.client }),
  )

  return { service, shared, calls: () => getContactCalls }
}

test('a warmed name cache never leaks the private alias into a shared card', async () => {
  const h = buildService()

  // An agent lists contacts, which populates the cache the way it ships, then
  // shares one of them without naming it — the ordinary call.
  await handleListContacts(h.service)
  await handleSendContact(h.service, {
    chatId: 'c-school-group',
    contactMid: FRIEND.mid,
  })

  expect(h.shared).toHaveLength(1)
  expect(h.shared[0]!.displayName).toBe('Alex')
  expect(h.shared[0]!.displayName).not.toContain('School - Alex')
})

test('a caller-supplied displayName is still passed through untouched', async () => {
  const h = buildService()
  await handleSendContact(h.service, {
    chatId: 'c-school-group',
    contactMid: FRIEND.mid,
    displayName: 'Alex from Soccer',
  })

  expect(h.shared[0]!.displayName).toBe('Alex from Soccer')
  expect(h.calls()).toBe(0)
})

test('an unresolvable contact still sends, leaving LINE to name it', async () => {
  const h = buildService()
  h.service.client.getContact = async () => {
    throw new Error('no such contact')
  }

  await handleSendContact(h.service, {
    chatId: 'c-school-group',
    contactMid: 'u-unknown',
  })

  expect(h.shared).toHaveLength(1)
  expect(h.shared[0]!.displayName).toBe('')
})
