import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  type FactorizedGoldRecord,
  validateFactorizedGold,
} from './gold-contract.js'

const valid: FactorizedGoldRecord = {
  id: 'onboarding-permit',
  language: 'en',
  context: [
    { speaker: 'self', text: 'What else do I need to handle?' },
    { speaker: 'other', text: 'Apply for a parking permit.' },
    { speaker: 'self', text: '[sticker]' },
  ],
  targetIndex: 1,
  dialogueActs: ['inform', 'answer'],
  createsWork: true,
  action: {
    predicate: 'apply',
    object: 'parking permit',
    expectedOutcome: 'application submitted',
  },
  ownership: { state: 'owned', ownerKinds: ['self'] },
  dependency: 'none',
  lifecycle: 'proposed',
  completion: { delivered: false, accepted: false, cancelled: false },
}

test('factorized gold permits information that creates work', () => {
  expect(validateFactorizedGold(valid)).toEqual([])
})

test('gold contract rejects impossible completion combinations', () => {
  const errors = validateFactorizedGold({
    ...valid,
    lifecycle: 'accepted',
    completion: { delivered: false, accepted: true, cancelled: false },
  })
  expect(errors).toContain('acceptance requires delivery')
})

test('every independent factorized acceptance record satisfies the contract', () => {
  for (const file of [
    'research/work-item-model/factorized-acceptance.jsonl',
    'research/work-item-model/factorized-acceptance-v2.jsonl',
    'research/work-item-model/factorized-acceptance-v3.jsonl',
  ]) {
    const rows = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as FactorizedGoldRecord)
    expect(rows).toHaveLength(10)
    for (const row of rows) expect(validateFactorizedGold(row)).toEqual([])
  }
})
