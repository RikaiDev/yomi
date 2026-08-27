import { expect, test } from 'bun:test'
import { inferAmbientEventGraph } from './ambient-event-graph.js'

test('links a delayed dyadic answer without a hard time cutoff', () => {
  const base = Date.now() - 3 * 60 * 60 * 1000
  const graph = inferAmbientEventGraph([
    {
      messageId: 'question',
      chatId: 'u-peer',
      senderName: 'Peer',
      sentAt: base,
      text: 'Has your location been confirmed?',
      isSelf: false,
    },
    {
      messageId: 'answer',
      chatId: 'u-peer',
      senderName: 'Me',
      sentAt: base + 22 * 60 * 1000,
      text: 'Not yet. Please ask the coordinator.',
      isSelf: true,
    },
  ])
  expect(graph.descendants(['question']).has('answer')).toBe(true)
  expect(graph.edges[0].reasons).toContain('adjacency_pair')
})

test('links a mentioned owner response after several hours', () => {
  const base = Date.now() - 8 * 60 * 60 * 1000
  const graph = inferAmbientEventGraph([
    {
      messageId: 'request',
      chatId: 'c-team',
      senderName: 'Requester',
      sentAt: base,
      text: '@Owner is the integration ready?',
      isSelf: false,
      mentionNames: ['Owner'],
    },
    {
      messageId: 'response',
      chatId: 'c-team',
      senderName: 'Owner',
      sentAt: base + 4 * 60 * 60 * 1000,
      text: 'The code is ready; deployment is blocked.',
      isSelf: false,
    },
  ])
  expect(graph.descendants(['request']).has('response')).toBe(true)
  expect(graph.edges[0].reasons).toContain('addressed_responder')
})

test('does not connect unrelated same-speaker messages on time alone', () => {
  const base = Date.now() - 60_000
  const graph = inferAmbientEventGraph([
    {
      messageId: 'one',
      chatId: 'c-chat',
      senderName: 'A',
      sentAt: base,
      text: 'Alpha topic',
      isSelf: false,
    },
    {
      messageId: 'two',
      chatId: 'c-chat',
      senderName: 'A',
      sentAt: base + 1000,
      text: 'Unrelated words',
      isSelf: false,
    },
  ])
  expect(graph.edges).toHaveLength(0)
})

test('links a nearby group turn exchange without requiring question punctuation', () => {
  const base = Date.now() - 60_000
  const graph = inferAmbientEventGraph([
    {
      messageId: 'request',
      chatId: 'c-team',
      senderName: 'A',
      sentAt: base,
      text: 'Please review the roster',
      isSelf: false,
    },
    {
      messageId: 'response',
      chatId: 'c-team',
      senderName: 'Me',
      sentAt: base + 20_000,
      text: 'I will check it',
      isSelf: true,
    },
  ])
  expect(graph.descendants(['request']).has('response')).toBe(true)
  expect(graph.edges[0].reasons).toContain('local_turn_exchange')
})

test('breaks a direct conversation after a long idle gap without structural evidence', () => {
  const base = Date.now() - 3 * 24 * 60 * 60_000
  const graph = inferAmbientEventGraph([
    {
      messageId: 'old',
      chatId: 'u-peer',
      senderName: 'Peer',
      sentAt: base,
      text: 'Old topic',
      isSelf: false,
    },
    {
      messageId: 'new',
      chatId: 'u-peer',
      senderName: 'Me',
      sentAt: base + 2 * 24 * 60 * 60_000,
      text: 'Different topic',
      isSelf: true,
    },
  ])
  expect(graph.edges).toHaveLength(0)
})

test('links consecutive self-authored work details inside an adaptive session', () => {
  const base = Date.now() - 60_000
  const graph = inferAmbientEventGraph([
    {
      messageId: 'one',
      chatId: 'c-team',
      senderName: 'Me',
      sentAt: base,
      text: 'First deployment detail',
      isSelf: true,
    },
    {
      messageId: 'two',
      chatId: 'c-team',
      senderName: 'Me',
      sentAt: base + 10_000,
      text: 'Second deployment detail',
      isSelf: true,
    },
  ])
  expect(graph.descendants(['one']).has('two')).toBe(true)
  expect(graph.edges[0].reasons).toContain('self_continuation')
})
