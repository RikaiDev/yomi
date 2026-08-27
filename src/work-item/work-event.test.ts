import { expect, test } from 'bun:test'
import {
  excludeWorkEvent,
  mergeWorkEvents,
  reviseWorkEvent,
  splitWorkEvent,
  type WorkEventInference,
} from './work-event.js'

function inference(
  overrides: Partial<WorkEventInference> = {},
): WorkEventInference {
  return {
    eventId: 'event-1',
    chatId: 'chat-1',
    evidence: [
      { messageId: 'm1', chatId: 'chat-1', sentAt: 1, speaker: 'other' },
    ],
    dialogue: [
      { messageId: 'm1', acts: ['inform', 'answer'], confidence: 0.96 },
    ],
    createsWork: true,
    workConfidence: 0.94,
    action: {
      predicate: 'apply',
      object: 'parking permit',
      expectedOutcome: null,
      dueAt: null,
      confidence: 0.92,
      evidenceMessageIds: ['m1'],
    },
    ownership: {
      state: 'owned',
      owners: [{ kind: 'self', stableId: null, displayName: null }],
      confidence: 0.93,
      evidenceMessageIds: ['m1'],
    },
    dependency: {
      state: 'none',
      on: null,
      confidence: 0.8,
      evidenceMessageIds: [],
    },
    lifecycle: 'proposed',
    completion: {
      delivered: false,
      accepted: false,
      cancelled: false,
      confidence: 0.95,
      evidenceMessageIds: [],
    },
    sourceModel: 'fixture',
    inferredAt: 10,
    ...overrides,
  }
}

test('information can create an owned open action without becoming a request', () => {
  const revision = reviseWorkEvent(null, inference())
  expect(revision.dialogue[0].acts).toEqual(['inform', 'answer'])
  expect(revision.createsWork).toBe(true)
  expect(revision.ownership.state).toBe('owned')
  expect(revision.lifecycle).toBe('proposed')
})

test('acknowledgement evidence does not imply completion', () => {
  const first = reviseWorkEvent(null, inference())
  const second = reviseWorkEvent(
    first,
    inference({
      evidence: [
        { messageId: 'm2', chatId: 'chat-1', sentAt: 2, speaker: 'self' },
      ],
      dialogue: [{ messageId: 'm2', acts: ['acknowledge'], confidence: 0.9 }],
      inferredAt: 20,
    }),
  )
  expect(second.active).toBe(true)
  expect(second.completion.delivered).toBe(false)
  expect(second.reasons).toContain('evidence_added')
})

test('a closed event can be reopened by a later authoritative inference', () => {
  const closed = reviseWorkEvent(
    null,
    inference({
      lifecycle: 'resolved',
      completion: {
        delivered: true,
        accepted: true,
        cancelled: false,
        confidence: 0.9,
        evidenceMessageIds: ['m2'],
      },
    }),
  )
  const reopened = reviseWorkEvent(
    closed,
    inference({ lifecycle: 'in_progress', inferredAt: 30 }),
  )
  expect(reopened.active).toBe(true)
  expect(reopened.reasons).toContain('reopened')
})

test('exclusion is revisioned and reversible by a later inference', () => {
  const first = reviseWorkEvent(null, inference())
  const excluded = excludeWorkEvent(first, true)
  expect(excluded.active).toBe(false)
  expect(excluded.reasons).toEqual(['temporarily_excluded'])
  const restored = reviseWorkEvent(excluded, inference({ inferredAt: 40 }))
  expect(restored.active).toBe(true)
})

test('a mixed hypothesis can split into versioned child events sharing evidence', () => {
  const parent = reviseWorkEvent(
    null,
    inference({
      evidence: [
        { messageId: 'm1', chatId: 'chat-1', sentAt: 1, speaker: 'other' },
        { messageId: 'm2', chatId: 'chat-1', sentAt: 2, speaker: 'self' },
      ],
    }),
  )
  const result = splitWorkEvent(parent, [
    inference({ eventId: 'event-a', evidence: [parent.evidence[0]] }),
    inference({
      eventId: 'event-b',
      evidence: [parent.evidence[0], parent.evidence[1]],
    }),
  ])
  expect(result.superseded.active).toBe(false)
  expect(result.superseded.reasons).toEqual(['split'])
  expect(result.children.map((item) => item.eventId)).toEqual([
    'event-a',
    'event-b',
  ])
  expect(result.children.every((item) => item.reasons.includes('split'))).toBe(
    true,
  )
  expect(
    result.children.every((item) =>
      item.evidence.some((evidence) => evidence.messageId === 'm1'),
    ),
  ).toBe(true)
})

test('two hypotheses can merge while preserving supersession history', () => {
  const left = reviseWorkEvent(null, inference({ eventId: 'left' }))
  const right = reviseWorkEvent(
    null,
    inference({
      eventId: 'right',
      evidence: [
        { messageId: 'm2', chatId: 'chat-1', sentAt: 2, speaker: 'self' },
      ],
    }),
  )
  const result = mergeWorkEvents(
    [left, right],
    inference({
      eventId: 'merged',
      evidence: [...left.evidence, ...right.evidence],
    }),
  )
  expect(
    result.superseded.every(
      (item) => !item.active && item.reasons[0] === 'merged',
    ),
  ).toBe(true)
  expect(result.merged.reasons).toContain('merged')
})
