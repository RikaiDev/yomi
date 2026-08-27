import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviseWorkEvent } from './work-event.js'
import { WorkEventRevisionStore } from './work-event-store.js'

test('audit persistence keeps revisions but not decrypted action text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yomi-work-event-'))
  const path = join(directory, 'events.json')
  try {
    const revision = reviseWorkEvent(null, {
      eventId: 'secret-event',
      chatId: 'secret-chat',
      evidence: [
        {
          messageId: 'secret-message',
          chatId: 'secret-chat',
          sentAt: 1,
          speaker: 'other',
        },
      ],
      dialogue: [
        {
          messageId: 'secret-message',
          acts: ['inform', 'answer'],
          confidence: 0.9,
        },
      ],
      createsWork: true,
      workConfidence: 0.9,
      action: {
        predicate: 'apply',
        object: 'private permit',
        expectedOutcome: 'private result',
        dueAt: null,
        confidence: 0.9,
        evidenceMessageIds: ['secret-message'],
      },
      ownership: {
        state: 'owned',
        owners: [
          {
            kind: 'self',
            stableId: 'secret-owner',
            displayName: 'Private Person',
          },
        ],
        confidence: 0.9,
        evidenceMessageIds: ['secret-message'],
      },
      dependency: {
        state: 'none',
        on: null,
        confidence: 0.9,
        evidenceMessageIds: [],
      },
      lifecycle: 'proposed',
      completion: {
        delivered: false,
        accepted: false,
        cancelled: false,
        confidence: 0.9,
        evidenceMessageIds: [],
      },
      sourceModel: 'fixture',
      inferredAt: 2,
    })
    const store = new WorkEventRevisionStore(path)
    await store.append(revision)
    expect(await store.list()).toHaveLength(1)
    const raw = await readFile(path, 'utf8')
    for (const secret of [
      'secret-event',
      'secret-chat',
      'secret-message',
      'private permit',
      'private result',
      'secret-owner',
      'Private Person',
    ]) {
      expect(raw).not.toContain(secret)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent multi-candidate appends cannot overwrite sibling events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yomi-work-event-many-'))
  const path = join(directory, 'events.json')
  try {
    const make = (eventId: string, predicate: string) =>
      reviseWorkEvent(null, {
        eventId,
        chatId: 'chat',
        evidence: [
          {
            messageId: 'shared-message',
            chatId: 'chat',
            sentAt: 1,
            speaker: 'self',
          },
        ],
        dialogue: [
          {
            messageId: 'shared-message',
            acts: ['cancel', 'ask'],
            confidence: 0.9,
          },
        ],
        createsWork: true,
        workConfidence: 0.9,
        action: {
          predicate,
          object: 'private object',
          expectedOutcome: 'private outcome',
          dueAt: null,
          confidence: 0.9,
          evidenceMessageIds: ['shared-message'],
        },
        ownership: {
          state: 'owned',
          owners: [{ kind: 'self', stableId: null, displayName: null }],
          confidence: 0.9,
          evidenceMessageIds: ['shared-message'],
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
          evidenceMessageIds: ['shared-message'],
        },
        sourceModel: 'fixture',
        inferredAt: predicate === 'cancel' ? 2 : 3,
      })
    const store = new WorkEventRevisionStore(path)
    await Promise.all([
      store.append(make('cancel-old', 'cancel')),
      store.append(make('schedule-new', 'schedule')),
    ])
    expect(await store.list()).toHaveLength(2)
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('private object')
    expect(raw).not.toContain('shared-message')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
