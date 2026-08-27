import { expect, test } from 'bun:test'
import type { FactorizedGoldRecord } from './gold-contract.js'
import { auditAcceptanceCoverage, auditGoldCoverage } from './gold-coverage.js'
import type { ConversationGoldSplit } from './gold-split.js'

const minimal: FactorizedGoldRecord = {
  id: 'minimal',
  language: 'en',
  context: [{ speaker: 'other', text: 'hello' }],
  targetIndex: 0,
  dialogueActs: ['inform'],
  createsWork: false,
  action: null,
  ownership: { state: 'unassigned', ownerKinds: ['unknown'] },
  dependency: 'none',
  lifecycle: 'resolved',
  completion: { delivered: false, accepted: false, cancelled: false },
}

test('coverage gate reports missing heads per partition', () => {
  const split: ConversationGoldSplit = {
    seed: 'test',
    train: [minimal],
    validation: [minimal],
    test: [minimal],
    excludedAcceptanceIds: [],
  }
  const issues = auditGoldCoverage(split)
  expect(issues).toContainEqual({
    partition: 'test',
    head: 'dependency',
    label: 'waiting_person',
    observed: 0,
    required: 1,
  })
  expect(issues).toContainEqual({
    partition: 'train',
    head: 'dialogue',
    label: 'inform',
    observed: 1,
    required: 2,
  })
})

test('acceptance coverage reports factorized labels not represented by fixtures', () => {
  expect(auditAcceptanceCoverage([minimal])).toContain('dialogue:reject')
  expect(auditAcceptanceCoverage([minimal])).not.toContain('work:false')
})
