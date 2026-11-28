/** MCP handler tests for pure contact search and explicit add-by-identifier. */

import { describe, expect, test } from 'bun:test'
import { handleAddContact, handleSearchContact } from './contacts.js'

function fakeService(result: any = { mid: 'u1', displayName: 'Alex' }) {
  const calls: any[] = []
  return {
    calls,
    service: {
      nameCache: new Map<string, string>(),
      searchContacts: async (args: any) => {
        calls.push({ method: 'searchContacts', args })
        return result
      },
      addContact: async (args: any) => {
        calls.push({ method: 'addContact', args })
        return result
      },
    } as any,
  }
}

describe('search_contact', () => {
  test('rejects a missing value', async () => {
    const { service } = fakeService()
    const res = await handleSearchContact(service, { by: 'userid' } as any)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('requires a non-empty string')
  })

  test('rejects a phone search without an array', async () => {
    const { service } = fakeService()
    const res = await handleSearchContact(service, {
      by: 'phone',
      value: '0912345678',
    } as any)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('phone')
  })

  test('rejects an unknown identifier type', async () => {
    const { service } = fakeService()
    const res = await handleSearchContact(service, {
      by: 'email',
      value: 'a@b.c',
    } as any)
    expect(res.isError).toBe(true)
  })

  test('searches by LINE ID without ever adding a contact', async () => {
    const { service, calls } = fakeService()
    const res = await handleSearchContact(service, {
      by: 'userid',
      value: 'abc_123',
    })
    expect(calls).toEqual([
      { method: 'searchContacts', args: { by: 'userid', value: 'abc_123' } },
    ])
    expect(res.content[0].text).toContain('u1')
    expect(res.content[0].text).toContain('Alex')
  })
})

describe('add_contact', () => {
  test('adds by MID through the explicit add path', async () => {
    const { service, calls } = fakeService()
    await handleAddContact(service, { by: 'mid', value: 'u1' })
    expect(calls).toEqual([
      { method: 'addContact', args: { by: 'mid', value: 'u1' } },
    ])
  })

  test('adds by LINE ID', async () => {
    const { service, calls } = fakeService()
    await handleAddContact(service, { by: 'userid', value: 'abc_123' })
    expect(calls).toEqual([
      { method: 'addContact', args: { by: 'userid', value: 'abc_123' } },
    ])
  })

  test('rejects an unsupported identifier type', async () => {
    const { service, calls } = fakeService()
    const res = await handleAddContact(service, {
      by: 'ticket',
      value: 'ticket#abc',
    } as any)
    expect(res.isError).toBe(true)
    expect(calls).toEqual([])
  })
})
