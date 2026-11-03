/**
 * Tests for message-actions handlers (unsend_message, react_message, cancel_reaction).
 * Verifies safety gates, parameter validation, and service delegation.
 */

import { describe, expect, test } from 'bun:test'
import {
  handleCancelReaction,
  handleReactMessage,
  handleUnsendMessage,
} from './message-actions.js'

function createMockService() {
  const unsendCalls: string[] = []
  const reactCalls: Array<{ messageId: string; reactionType?: number }> = []
  const cancelCalls: string[] = []

  const service: any = {
    unsendMessage: async (messageId: string) => {
      unsendCalls.push(messageId)
      return { unsent: true, messageId }
    },
    reactToMessage: async (messageId: string, reactionType?: number) => {
      reactCalls.push({ messageId, reactionType })
      return { success: true, messageId, reactionType: reactionType ?? 2 }
    },
    cancelReaction: async (messageId: string) => {
      cancelCalls.push(messageId)
      return { cancelled: true, messageId }
    },
  }

  return { service, unsendCalls, reactCalls, cancelCalls }
}

describe('handleUnsendMessage', () => {
  test('rejects missing messageId', async () => {
    const { service, unsendCalls } = createMockService()
    const result = await handleUnsendMessage(service, {
      messageId: '',
      confirm: true,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('messageId is required')
    expect(unsendCalls.length).toBe(0)
  })

  test('blocks execution when confirm is not explicitly true', async () => {
    const { service, unsendCalls } = createMockService()
    const result = await handleUnsendMessage(service, {
      messageId: '12345678',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('confirm: true')
    expect(unsendCalls.length).toBe(0)
  })

  test('blocks execution when confirm is false', async () => {
    const { service, unsendCalls } = createMockService()
    const result = await handleUnsendMessage(service, {
      messageId: '12345678',
      confirm: false,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('confirm: true')
    expect(unsendCalls.length).toBe(0)
  })

  test('retracts message when messageId and confirm: true are supplied', async () => {
    const { service, unsendCalls } = createMockService()
    const result = await handleUnsendMessage(service, {
      messageId: '12345678',
      confirm: true,
    })

    expect(result.isError).toBeUndefined()
    expect(unsendCalls).toEqual(['12345678'])
    const payload = JSON.parse(result.content[0].text)
    expect(payload.unsent).toBe(true)
    expect(payload.messageId).toBe('12345678')
  })
})

describe('handleReactMessage', () => {
  test('rejects missing messageId', async () => {
    const { service, reactCalls } = createMockService()
    const result = await handleReactMessage(service, { messageId: '' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('messageId is required')
    expect(reactCalls.length).toBe(0)
  })

  test('adds reaction with default or specific reactionType', async () => {
    const { service, reactCalls } = createMockService()
    const result = await handleReactMessage(service, {
      messageId: '12345678',
      reactionType: 3,
    })

    expect(result.isError).toBeUndefined()
    expect(reactCalls).toEqual([{ messageId: '12345678', reactionType: 3 }])
    const payload = JSON.parse(result.content[0].text)
    expect(payload.reactionType).toBe(3)
  })
})

describe('handleCancelReaction', () => {
  test('rejects missing messageId', async () => {
    const { service, cancelCalls } = createMockService()
    const result = await handleCancelReaction(service, { messageId: '' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('messageId is required')
    expect(cancelCalls.length).toBe(0)
  })

  test('cancels reaction on valid messageId', async () => {
    const { service, cancelCalls } = createMockService()
    const result = await handleCancelReaction(service, {
      messageId: '12345678',
    })

    expect(result.isError).toBeUndefined()
    expect(cancelCalls).toEqual(['12345678'])
    const payload = JSON.parse(result.content[0].text)
    expect(payload.cancelled).toBe(true)
  })
})
