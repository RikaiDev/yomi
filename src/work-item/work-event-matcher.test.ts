import { expect, test } from 'bun:test'
import { reviseWorkEvent, type WorkEventInference } from './work-event.js'
import { matchWorkEventRevisions } from './work-event-matcher.js'

function inference(
  eventId: string,
  predicate: string,
  evidence: string,
): WorkEventInference {
  return {
    eventId,
    chatId: 'chat',
    evidence: [
      { messageId: evidence, chatId: 'chat', sentAt: 1, speaker: 'self' },
    ],
    dialogue: [{ messageId: evidence, acts: ['inform'], confidence: 0.9 }],
    createsWork: true,
    workConfidence: 0.9,
    action: {
      predicate,
      object: 'meeting slot',
      expectedOutcome: `${predicate} meeting`,
      dueAt: null,
      confidence: 0.9,
      evidenceMessageIds: [evidence],
    },
    ownership: {
      state: 'owned',
      owners: [{ kind: 'self', stableId: null, displayName: null }],
      confidence: 0.9,
      evidenceMessageIds: [evidence],
    },
    dependency: {
      state: 'none',
      on: null,
      confidence: 0.9,
      evidenceMessageIds: [],
    },
    lifecycle: predicate === 'cancel' ? 'cancelled' : 'proposed',
    completion: {
      delivered: false,
      accepted: false,
      cancelled: predicate === 'cancel',
      confidence: 0.9,
      evidenceMessageIds: [evidence],
    },
    sourceModel: 'fixture',
    inferredAt: 1,
  }
}

test('shared evidence siblings match by action rather than array order', () => {
  const previous = [
    reviseWorkEvent(null, inference('old-cancel', 'cancel', 'shared')),
    reviseWorkEvent(null, inference('old-schedule', 'schedule', 'shared')),
  ]
  const incoming = [
    inference('new-schedule', 'schedule', 'shared'),
    inference('new-cancel', 'cancel', 'shared'),
  ]
  expect(
    matchWorkEventRevisions(previous, incoming).map((match) => [
      match.incomingIndex,
      match.previousIndex,
    ]),
  ).toEqual([
    [0, 1],
    [1, 0],
  ])
})

test('a later correction can match and reopen the same event', () => {
  const previous = reviseWorkEvent(null, inference('event', 'revise', 'm1'))
  const incoming = inference('provisional', 'revise', 'm1')
  incoming.lifecycle = 'in_progress'
  expect(matchWorkEventRevisions([previous], [incoming])).toEqual([
    { incomingIndex: 0, previousIndex: 0, score: 1 },
  ])
})

test('unrelated actions without shared evidence remain separate', () => {
  const previous = reviseWorkEvent(null, inference('event', 'archive', 'm1'))
  expect(
    matchWorkEventRevisions([previous], [inference('new', 'schedule', 'm2')]),
  ).toEqual([])
})
