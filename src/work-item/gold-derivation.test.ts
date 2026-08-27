import { expect, test } from 'bun:test'
import {
  createGoldDerivation,
  reviseGoldDerivation,
  validateGoldDerivation,
} from './gold-derivation.js'

const base = {
  derivationId: 'derivation-1',
  conversationId: 'conversation-1',
  graphEventId: 'event-1',
  disposition: 'temporarily_excluded' as const,
  reasons: ['media_semantics_unavailable' as const],
  evidenceMessageIds: ['message-1'],
  derivedGoldIds: [],
  supersedesDerivationIds: [],
  contextComplete: true,
  reviewedAt: 1,
}

test('media-only context is withheld instead of becoming negative gold', () => {
  const revision = createGoldDerivation(base)
  expect(revision.revision).toBe(1)
  expect(revision.derivedGoldIds).toEqual([])
  expect(validateGoldDerivation(revision)).toEqual([])
})

test('a temporary exclusion can be revised after media semantics arrive', () => {
  const first = createGoldDerivation(base)
  const second = reviseGoldDerivation(first, {
    ...base,
    disposition: 'included',
    reasons: ['coherent_work_event'],
    derivedGoldIds: ['gold-1'],
    reviewedAt: 2,
  })
  expect(second.previousRevision).toBe(1)
  expect(second.revision).toBe(2)
  expect(second.disposition).toBe('included')
})

test('split decisions must name every derived event', () => {
  const invalid = {
    ...createGoldDerivation(base),
    disposition: 'split' as const,
    reasons: ['multiple_work_events' as const],
    derivedGoldIds: ['gold-1'],
  }
  expect(validateGoldDerivation(invalid)).toContain(
    'split context requires at least two gold records',
  )
})
