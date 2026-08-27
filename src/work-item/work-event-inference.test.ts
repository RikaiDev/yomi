import { expect, test } from 'bun:test'
import type { EventContext } from './event-context.js'
import {
  type FactorizedModelOutput,
  projectFactorizedGraphInference,
  projectFactorizedInference,
  validateFactorizedGraphModelOutput,
} from './work-event-inference.js'

const context: EventContext = {
  schemaVersion: 1,
  chatId: 'chat',
  anchorMessageIds: ['m2'],
  complete: true,
  boundary: 'graph_boundary',
  edges: [],
  messages: [
    {
      messageId: 'm1',
      chatId: 'chat',
      senderName: 'self',
      sentAt: 1,
      text: 'question',
      isSelf: true,
    },
    {
      messageId: 'm2',
      chatId: 'chat',
      senderName: 'other',
      sentAt: 2,
      text: 'answer',
      isSelf: false,
    },
  ],
}

function output(
  overrides: Partial<FactorizedModelOutput> = {},
): FactorizedModelOutput {
  return {
    dialogue: [
      { messageId: 'm2', acts: ['inform', 'answer'], confidence: 0.95 },
    ],
    createsWork: { value: true, confidence: 0.94, evidenceMessageIds: ['m2'] },
    action: {
      predicate: 'apply',
      object: 'permit',
      expectedOutcome: 'submitted',
      dueAt: null,
      sourceMessageIds: ['m2'],
      confidence: 0.9,
    },
    ownership: {
      value: {
        state: 'owned',
        owners: [{ kind: 'self', stableId: null, displayName: null }],
      },
      confidence: 0.93,
      evidenceMessageIds: ['m2'],
    },
    dependency: {
      value: { state: 'none', on: null },
      confidence: 0.9,
      evidenceMessageIds: [],
    },
    lifecycle: {
      value: 'proposed',
      confidence: 0.91,
      evidenceMessageIds: ['m2'],
    },
    completion: {
      value: { delivered: false, accepted: false, cancelled: false },
      confidence: 0.95,
      evidenceMessageIds: [],
    },
    modelId: 'fixture-v1',
    ...overrides,
  }
}

test('high-confidence factorized output becomes an auditable inference', () => {
  const result = projectFactorizedInference(context, output(), undefined, 10)
  expect(result.kind).toBe('inference')
  if (result.kind === 'inference') {
    expect(result.inference.dialogue[0].acts).toEqual(['inform', 'answer'])
    expect(result.inference.createsWork).toBe(true)
  }
})

test('malformed local-model JSON abstains at the runtime boundary', () => {
  const malformed = {
    modelId: 'broken',
    dialogue: [],
    candidates: [
      {
        candidateKey: 'bad',
        createsWork: { value: true, confidence: 2, evidenceMessageIds: [] },
      },
    ],
  }
  expect(validateFactorizedGraphModelOutput(malformed)).toContain(
    'createsWork_field_invalid',
  )
  const result = projectFactorizedGraphInference(context, malformed as never)
  expect(result.candidates[0].result).toEqual(
    expect.objectContaining({ kind: 'abstain', modelId: 'broken' }),
  )
})

test('one message can project cancellation and replacement as separate events', () => {
  const shared = output()
  const { dialogue: _dialogue, modelId: _modelId, ...candidate } = shared
  const result = projectFactorizedGraphInference(context, {
    modelId: 'fixture-v2',
    dialogue: [{ messageId: 'm2', acts: ['cancel', 'ask'], confidence: 0.95 }],
    candidates: [
      {
        candidateKey: 'cancel-old',
        ...candidate,
        action: {
          ...shared.action!,
          predicate: 'attend',
          sourceMessageIds: ['m2'],
        },
        lifecycle: {
          value: 'cancelled',
          confidence: 0.95,
          evidenceMessageIds: ['m2'],
        },
        completion: {
          value: { delivered: false, accepted: false, cancelled: true },
          confidence: 0.95,
          evidenceMessageIds: ['m2'],
        },
      },
      {
        candidateKey: 'schedule-new',
        ...candidate,
        action: {
          ...shared.action!,
          predicate: 'schedule',
          sourceMessageIds: ['m2'],
        },
      },
    ],
  })
  expect(result.candidates.map((candidate) => candidate.result.kind)).toEqual([
    'inference',
    'inference',
  ])
  const eventIds = result.candidates.flatMap((candidate) =>
    candidate.result.kind === 'inference'
      ? [candidate.result.inference.eventId]
      : [],
  )
  expect(new Set(eventIds).size).toBe(2)
})

test('low confidence abstains instead of returning no-work', () => {
  const result = projectFactorizedInference(
    context,
    output({
      ownership: { ...output().ownership, confidence: 0.4 },
    }),
  )
  expect(result).toEqual(expect.objectContaining({ kind: 'abstain' }))
  if (result.kind === 'abstain')
    expect(result.reasons).toContain('ownership_confidence_low')
})

test('incomplete context and impossible completion both abstain', () => {
  const result = projectFactorizedInference(
    { ...context, complete: false, boundary: 'message_limit' },
    output({
      completion: {
        value: { delivered: false, accepted: true, cancelled: false },
        confidence: 0.95,
        evidenceMessageIds: ['m2'],
      },
    }),
  )
  expect(result.kind).toBe('abstain')
  if (result.kind === 'abstain') {
    expect(result.reasons).toContain('context_message_limit')
    expect(result.reasons).toContain('acceptance_without_delivery')
  }
})
