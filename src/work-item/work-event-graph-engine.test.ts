import { expect, test } from 'bun:test'
import type { EventContext } from './event-context.js'
import type { WorkEventRevision } from './work-event.js'
import {
  WorkEventGraphEngine,
  type WorkEventRevisionSink,
} from './work-event-graph-engine.js'
import type {
  FactorizedEventCandidateOutput,
  FactorizedGraphModelOutput,
} from './work-event-inference.js'

const context: EventContext = {
  schemaVersion: 1,
  chatId: 'chat',
  anchorMessageIds: ['m1'],
  complete: true,
  boundary: 'graph_boundary',
  edges: [],
  messages: [
    {
      messageId: 'm1',
      chatId: 'chat',
      senderName: 'Me',
      sentAt: 1,
      text: 'Cancel today and move to Wednesday',
      isSelf: true,
    },
  ],
}

function candidate(
  candidateKey: string,
  predicate: string,
): FactorizedEventCandidateOutput {
  const cancelled = predicate === 'cancel'
  return {
    candidateKey,
    createsWork: { value: true, confidence: 0.95, evidenceMessageIds: ['m1'] },
    action: {
      predicate,
      object: 'meeting',
      expectedOutcome: `${predicate} meeting`,
      dueAt: null,
      sourceMessageIds: ['m1'],
      confidence: 0.95,
    },
    ownership: {
      value: {
        state: 'owned',
        owners: [{ kind: 'self', stableId: null, displayName: null }],
      },
      confidence: 0.95,
      evidenceMessageIds: ['m1'],
    },
    dependency: {
      value: { state: 'none', on: null },
      confidence: 0.95,
      evidenceMessageIds: [],
    },
    lifecycle: {
      value: cancelled ? 'cancelled' : 'proposed',
      confidence: 0.95,
      evidenceMessageIds: ['m1'],
    },
    completion: {
      value: { delivered: false, accepted: false, cancelled },
      confidence: 0.95,
      evidenceMessageIds: ['m1'],
    },
  }
}

test('engine preserves sibling identities when provider keys and order change', async () => {
  const outputs: FactorizedGraphModelOutput[] = [
    {
      modelId: 'fixture',
      dialogue: [
        { messageId: 'm1', acts: ['cancel', 'ask'], confidence: 0.95 },
      ],
      candidates: [candidate('old', 'cancel'), candidate('new', 'schedule')],
    },
    {
      modelId: 'fixture',
      dialogue: [
        { messageId: 'm1', acts: ['cancel', 'ask'], confidence: 0.95 },
      ],
      candidates: [
        candidate('replacement-renamed', 'schedule'),
        candidate('cancel-renamed', 'cancel'),
      ],
    },
  ]
  const stored: WorkEventRevision[][] = []
  const sink: WorkEventRevisionSink = {
    async appendMany(revisions) {
      stored.push(revisions)
    },
  }
  const engine = new WorkEventGraphEngine(
    {
      id: 'fixture',
      async infer() {
        return outputs.shift()!
      },
    },
    sink,
  )
  const first = await engine.observe(context, undefined, 10)
  const second = await engine.observe(context, undefined, 20)
  expect(first.revisions).toHaveLength(2)
  expect(second.revisions.every((revision) => revision.revision === 2)).toBe(
    true,
  )
  expect(new Set(second.revisions.map((revision) => revision.eventId))).toEqual(
    new Set(first.revisions.map((revision) => revision.eventId)),
  )
  expect(stored).toHaveLength(2)
})

test('abstained candidates neither create nor close revisions', async () => {
  const low = candidate('uncertain', 'review')
  low.createsWork.confidence = 0.2
  const sink: WorkEventRevisionSink = {
    async appendMany() {
      throw new Error('must not persist')
    },
  }
  const engine = new WorkEventGraphEngine(
    {
      id: 'fixture',
      async infer() {
        return { modelId: 'fixture', dialogue: [], candidates: [low] }
      },
    },
    sink,
  )
  const update = await engine.observe(context)
  expect(update.revisions).toEqual([])
  expect(update.projection.candidates[0].result.kind).toBe('abstain')
})
