import { expect, test } from 'bun:test'

import { createChatRuntimeService } from './chat-runtime-service.js'
import { isOfficialAccountChatMid } from './official-account.js'

test('official-account chat MIDs are told apart from people and groups', () => {
  // Official account: `u` + an account MID that starts with `b`.
  expect(isOfficialAccountChatMid('ub00000000official0000000000000000')).toBe(
    true,
  )
  // A person: `u` + a user MID (which itself starts with `u`).
  expect(isOfficialAccountChatMid('uu00000000person000000000000000000')).toBe(
    false,
  )
  // Groups and rooms.
  expect(isOfficialAccountChatMid('c1234567890abcdef')).toBe(false)
  expect(isOfficialAccountChatMid('r1234567890abcdef')).toBe(false)
  expect(isOfficialAccountChatMid('')).toBe(false)
})

test('a message to an official account goes out in plain text', async () => {
  const calls: { to: string; text: string | null; encrypted: boolean }[] = []
  let encryptCalls = 0
  const service: any = {
    client: {
      async sendMessage(a: any, b?: any) {
        // The command boundary uses both the legacy two-argument form and
        // the richer options object; normalise them the same way the real
        // client does.
        const options =
          typeof a === 'object' && a !== null ? a : { to: a, text: b }
        calls.push({
          to: options.to,
          text: options.text ?? null,
          encrypted: Array.isArray(options.chunks),
        })
        return { id: 'sent-1' }
      },
    },
    e2eeManager: {
      async encryptE2EEMessage() {
        encryptCalls += 1
        throw new Error('E2EE must not be attempted for an official account')
      },
    },
  }

  const runtime = createChatRuntimeService(service)
  const sent = await runtime.sendMessage(
    'ub00000000official0000000000000000',
    '房東好，我剛剛轉了 8,000 元房租給您。',
  )

  expect(sent?.id).toBe('sent-1')
  expect(encryptCalls).toBe(0)
  expect(calls).toHaveLength(1)
  expect(calls[0].to).toBe('ub00000000official0000000000000000')
  expect(calls[0].text).toBe('房東好，我剛剛轉了 8,000 元房租給您。')
  expect(calls[0].encrypted).toBe(false)
})

test('a message to a person still goes through E2EE', async () => {
  let encryptCalls = 0
  let plaintextCalls = 0
  const service: any = {
    client: {
      async sendMessage(a: any, b?: any) {
        const options =
          typeof a === 'object' && a !== null ? a : { to: a, text: b }
        if (!Array.isArray(options.chunks)) {
          plaintextCalls += 1
        }
        return { id: 'sent-2' }
      },
    },
    e2eeManager: {
      async encryptE2EEMessage() {
        encryptCalls += 1
        return {
          contentType: 0,
          contentMetadata: { e2eeVersion: '2' },
          chunks: [Buffer.from('salt')],
        }
      },
    },
  }

  const runtime = createChatRuntimeService(service)
  await runtime.sendMessage('uu00000000person000000000000000000', '你好')

  expect(encryptCalls).toBe(1)
  expect(plaintextCalls).toBe(0)
})
