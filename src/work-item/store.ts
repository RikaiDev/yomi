import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { yomiDataPath } from '../util/data-dir.js'
import type { WorkItemDraft } from './types.js'

export interface PersistedWorkItem {
  id: string
  createdAt: number
  updatedAt: number
  source: {
    adapter: string
    platform: string
    conversationIdHash: string
    messageIdHashes: string[]
    latestMessageAt: number
  }
  evidence: Array<{
    sourceMessageIdHash: string
    senderIdHash: string | null
    senderNameHash: string | null
    sentAt: number
    textSha256: string | null
    attachments: Array<{
      idHash: string
      fileNameSha256: string | null
      mimeType: string | null
      byteLength: number | null
      sha256: string | null
    }>
  }>
  summarySha256: string | null
  action: WorkItemDraft['action']
  destination: string | null
  assignee: string | null
  labels: string[]
  status: WorkItemDraft['status']
  failure: WorkItemDraft['failure']
  delivery: WorkItemDraft['delivery']
}

/** Store that can round-trip in-memory evidence for provider delivery. */
export interface WorkItemDraftStore {
  save(draft: WorkItemDraft): Promise<void>
  get(id: string): Promise<WorkItemDraft | null>
  list(): Promise<WorkItemDraft[]>
}

function digest(value: string | null): string | null {
  if (value === null) return null
  return createHash('sha256').update(value).digest('hex')
}

export function toPersistedWorkItem(draft: WorkItemDraft): PersistedWorkItem {
  const primarySource = draft.source ?? draft.sources[0]
  if (!primarySource) throw new Error('Work item has no source to persist')
  return {
    id: draft.id,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    source: {
      adapter: primarySource.adapter,
      platform: primarySource.platform,
      conversationIdHash: digest(primarySource.conversationId) as string,
      messageIdHashes: primarySource.messageIds.map(
        (messageId) => digest(messageId) as string,
      ),
      latestMessageAt: primarySource.latestMessageAt,
    },
    evidence: draft.evidence.map((evidence) => ({
      sourceMessageIdHash: digest(evidence.sourceMessageId) as string,
      senderIdHash:
        evidence.senderId === null ? null : digest(evidence.senderId),
      senderNameHash:
        evidence.senderName === null ? null : digest(evidence.senderName),
      sentAt: evidence.sentAt,
      textSha256: digest(evidence.text),
      attachments: evidence.attachments.map((attachment) => ({
        idHash: digest(attachment.id) as string,
        fileNameSha256: digest(attachment.fileName),
        mimeType: attachment.mimeType,
        byteLength: attachment.byteLength,
        sha256: attachment.sha256,
      })),
    })),
    summarySha256: digest(draft.summary),
    action: draft.action,
    destination: draft.destination,
    assignee: draft.assignee,
    labels: [...draft.labels],
    status: draft.status,
    failure: draft.failure,
    delivery: draft.delivery,
  }
}

export class InMemoryWorkItemStore implements WorkItemDraftStore {
  private readonly drafts = new Map<string, WorkItemDraft>()

  async save(draft: WorkItemDraft): Promise<void> {
    this.drafts.set(draft.id, structuredClone(draft))
  }

  async get(id: string): Promise<WorkItemDraft | null> {
    const draft = this.drafts.get(id)
    return draft ? structuredClone(draft) : null
  }

  async list(): Promise<WorkItemDraft[]> {
    return [...this.drafts.values()].map((draft) => structuredClone(draft))
  }
}

/** Metadata-only persistence. It intentionally cannot be used to deliver a draft. */
export class FileWorkItemStore {
  private readonly path: string
  private readonly maxItems: number

  constructor(path = yomiDataPath('work-items.json'), maxItems = 200) {
    this.path = path
    this.maxItems = Math.max(1, maxItems)
  }

  async save(draft: WorkItemDraft): Promise<void> {
    const entries = await this.read()
    const persisted = toPersistedWorkItem(draft)
    const next = [
      persisted,
      ...entries.filter((entry) => entry.id !== draft.id),
    ].slice(0, this.maxItems)
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp-${process.pid}`
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 })
    await rename(temporary, this.path)
  }

  async get(id: string): Promise<PersistedWorkItem | null> {
    return (await this.read()).find((entry) => entry.id === id) ?? null
  }

  async list(): Promise<PersistedWorkItem[]> {
    return this.read()
  }

  private async read(): Promise<PersistedWorkItem[]> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      return Array.isArray(value) ? (value as PersistedWorkItem[]) : []
    } catch {
      return []
    }
  }
}
