import { expect, test } from 'bun:test'
import type { FactorizedGoldRecord } from './gold-contract.js'
import {
  assertNoConversationLeakage,
  splitFactorizedGoldByConversation,
} from './gold-split.js'

function record(id: string, chatId: string): FactorizedGoldRecord {
  return {
    id,
    language: 'zh-TW',
    context: [{ speaker: 'other', text: 'context' }],
    targetIndex: 0,
    dialogueActs: ['inform'],
    createsWork: false,
    action: null,
    ownership: { state: 'unassigned', ownerKinds: ['unknown'] },
    dependency: 'none',
    lifecycle: 'resolved',
    completion: { delivered: false, accepted: false, cancelled: false },
    source: { chatId, graphEventId: `${chatId}:${id}` },
  }
}

test('all windows from a conversation stay in one partition', () => {
  const rows = [
    record('a1', 'a'),
    record('a2', 'a'),
    record('b1', 'b'),
    record('c1', 'c'),
    record('d1', 'd'),
  ]
  const split = splitFactorizedGoldByConversation(rows, { seed: '20260827' })
  expect(() => assertNoConversationLeakage(split)).not.toThrow()
  const partitions = [split.train, split.validation, split.test]
  expect(
    partitions.filter((values) =>
      values.some((value) => value.source?.chatId === 'a'),
    ),
  ).toHaveLength(1)
})

test('acceptance records are excluded before fitting', () => {
  const rows = [
    record('train', 'a'),
    record('acceptance', 'b'),
    record('c', 'c'),
    record('d', 'd'),
  ]
  const split = splitFactorizedGoldByConversation(rows, {
    seed: '20260827',
    acceptanceIds: ['acceptance'],
  })
  expect(split.excludedAcceptanceIds).toEqual(['acceptance'])
  expect(
    [...split.train, ...split.validation, ...split.test].map(
      (value) => value.id,
    ),
  ).not.toContain('acceptance')
})

test('split is stable for the same seed', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => record(id, id))
  const first = splitFactorizedGoldByConversation(rows, { seed: 'stable' })
  const second = splitFactorizedGoldByConversation([...rows].reverse(), {
    seed: 'stable',
  })
  expect(first.train.map((value) => value.id)).toEqual(
    second.train.map((value) => value.id),
  )
  expect(first.validation.map((value) => value.id)).toEqual(
    second.validation.map((value) => value.id),
  )
  expect(first.test.map((value) => value.id)).toEqual(
    second.test.map((value) => value.id),
  )
})
