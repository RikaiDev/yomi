import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { yomiDataPath } from '../util/data-dir.js'
import type { WorkEventRevision } from './work-event.js'

interface PersistedWorkEventRevision {
  eventIdHash: string
  chatIdHash: string
  schemaVersion: 1
  revision: number
  previousRevision: number | null
  active: boolean
  evidence: Array<{
    messageIdHash: string
    sentAt: number
    speaker: 'self' | 'other'
  }>
  dialogue: WorkEventRevision['dialogue']
  createsWork: boolean
  workConfidence: number
  action: null | {
    predicateHash: string
    objectHash: string | null
    expectedOutcomeHash: string | null
    dueAt: number | null
    confidence: number
    evidenceMessageIdHashes: string[]
  }
  ownership: Omit<
    WorkEventRevision['ownership'],
    'owners' | 'evidenceMessageIds'
  > & {
    owners: Array<{
      kind: 'self' | 'conversation_member' | 'external_party' | 'unknown'
      stableIdHash: string | null
      displayNameHash: string | null
    }>
    evidenceMessageIdHashes: string[]
  }
  dependency: Omit<
    WorkEventRevision['dependency'],
    'on' | 'evidenceMessageIds'
  > & {
    on: null | {
      kind: 'self' | 'conversation_member' | 'external_party' | 'unknown'
      stableIdHash: string | null
      displayNameHash: string | null
    }
    evidenceMessageIdHashes: string[]
  }
  lifecycle: WorkEventRevision['lifecycle']
  completion: WorkEventRevision['completion']
  sourceModel: string
  inferredAt: number
  reasons: WorkEventRevision['reasons']
}

interface WorkEventFile {
  schemaVersion: 1
  revisions: PersistedWorkEventRevision[]
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function persist(revision: WorkEventRevision): PersistedWorkEventRevision {
  return {
    eventIdHash: digest(revision.eventId),
    chatIdHash: digest(revision.chatId),
    schemaVersion: 1,
    revision: revision.revision,
    previousRevision: revision.previousRevision,
    active: revision.active,
    evidence: revision.evidence.map((item) => ({
      messageIdHash: digest(item.messageId),
      sentAt: item.sentAt,
      speaker: item.speaker,
    })),
    dialogue: revision.dialogue.map((item) => ({
      ...item,
      messageId: digest(item.messageId),
    })),
    createsWork: revision.createsWork,
    workConfidence: revision.workConfidence,
    action: revision.action
      ? {
          predicateHash: digest(revision.action.predicate),
          objectHash: revision.action.object
            ? digest(revision.action.object)
            : null,
          expectedOutcomeHash: revision.action.expectedOutcome
            ? digest(revision.action.expectedOutcome)
            : null,
          dueAt: revision.action.dueAt,
          confidence: revision.action.confidence,
          evidenceMessageIdHashes:
            revision.action.evidenceMessageIds.map(digest),
        }
      : null,
    ownership: {
      state: revision.ownership.state,
      confidence: revision.ownership.confidence,
      evidenceMessageIdHashes:
        revision.ownership.evidenceMessageIds.map(digest),
      owners: revision.ownership.owners.map((owner) => ({
        kind: owner.kind,
        stableIdHash: owner.stableId ? digest(owner.stableId) : null,
        displayNameHash: owner.displayName ? digest(owner.displayName) : null,
      })),
    },
    dependency: {
      state: revision.dependency.state,
      confidence: revision.dependency.confidence,
      evidenceMessageIdHashes:
        revision.dependency.evidenceMessageIds.map(digest),
      on: revision.dependency.on
        ? {
            kind: revision.dependency.on.kind,
            stableIdHash: revision.dependency.on.stableId
              ? digest(revision.dependency.on.stableId)
              : null,
            displayNameHash: revision.dependency.on.displayName
              ? digest(revision.dependency.on.displayName)
              : null,
          }
        : null,
    },
    lifecycle: revision.lifecycle,
    completion: {
      ...revision.completion,
      evidenceMessageIds: revision.completion.evidenceMessageIds.map(digest),
    },
    sourceModel: revision.sourceModel,
    inferredAt: revision.inferredAt,
    reasons: revision.reasons,
  }
}

/** Metadata-only audit history; decrypted text remains in the secure UI cache. */
export class WorkEventRevisionStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path = yomiDataPath('work-event-revisions.json'),
    private readonly maxRevisions = 2000,
  ) {}

  async append(revision: WorkEventRevision): Promise<void> {
    await this.appendMany([revision])
  }

  async appendMany(incoming: WorkEventRevision[]): Promise<void> {
    if (incoming.length === 0) return
    const run = async (): Promise<void> => {
      const current = await this.read()
      const rows = incoming.map(persist)
      const incomingKeys = new Set(
        rows.map((row) => `${row.eventIdHash}:${row.revision}`),
      )
      const revisions = [
        ...rows,
        ...current.filter(
          (item) => !incomingKeys.has(`${item.eventIdHash}:${item.revision}`),
        ),
      ]
        .sort((left, right) => right.inferredAt - left.inferredAt)
        .slice(0, this.maxRevisions)
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp-${process.pid}`
      await writeFile(
        temporary,
        JSON.stringify({ schemaVersion: 1, revisions } satisfies WorkEventFile),
        { mode: 0o600 },
      )
      await rename(temporary, this.path)
    }
    this.writeQueue = this.writeQueue.then(run, run)
    await this.writeQueue
  }

  async list(): Promise<PersistedWorkEventRevision[]> {
    await this.writeQueue
    return this.read()
  }

  private async read(): Promise<PersistedWorkEventRevision[]> {
    try {
      const value = JSON.parse(
        await readFile(this.path, 'utf8'),
      ) as WorkEventFile
      return value.schemaVersion === 1 && Array.isArray(value.revisions)
        ? value.revisions
        : []
    } catch {
      return []
    }
  }
}
