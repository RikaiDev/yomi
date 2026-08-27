import { expect, test } from 'bun:test'
import type {
  AmbientEventGraph,
  AmbientGraphMessage,
} from '../ambient/ambient-event-graph.js'
import { assembleEventContext } from './event-context.js'

const messages: AmbientGraphMessage[] = [
  {
    messageId: 'm1',
    chatId: 'c1',
    senderName: 'A',
    sentAt: 1,
    text: 'first',
    isSelf: false,
  },
  {
    messageId: 'm2',
    chatId: 'c1',
    senderName: 'self',
    sentAt: 2,
    text: 'question',
    isSelf: true,
  },
  {
    messageId: 'm3',
    chatId: 'c1',
    senderName: 'A',
    sentAt: 3,
    text: 'answer',
    isSelf: false,
  },
  {
    messageId: 'm4',
    chatId: 'c1',
    senderName: 'A',
    sentAt: 10_000_000,
    text: 'unrelated',
    isSelf: false,
  },
]

function graph(): AmbientEventGraph {
  return {
    edges: [
      {
        parentId: 'm1',
        childId: 'm2',
        weight: 0.7,
        entropy: 0.1,
        reasons: ['fixture'],
      },
      {
        parentId: 'm2',
        childId: 'm3',
        weight: 0.9,
        entropy: 0.1,
        reasons: ['fixture'],
      },
    ],
    descendants: () => new Set(),
  }
}

test('context size follows graph connectivity instead of a fixed neighbour count', () => {
  const context = assembleEventContext(messages, graph(), ['m3'])
  expect(context.messages.map((item) => item.messageId)).toEqual([
    'm1',
    'm2',
    'm3',
  ])
  expect(context.messages.map((item) => item.messageId)).not.toContain('m4')
  expect(context.complete).toBe(true)
})

test('context records a message limit instead of silently truncating', () => {
  const context = assembleEventContext(messages, graph(), ['m3'], {
    maximumMessages: 2,
  })
  expect(context.messages).toHaveLength(2)
  expect(context.complete).toBe(false)
  expect(context.boundary).toBe('message_limit')
})

test('missing anchors are explicit', () => {
  const context = assembleEventContext(messages, graph(), ['missing'])
  expect(context.boundary).toBe('missing_anchor')
  expect(context.messages).toEqual([])
})
