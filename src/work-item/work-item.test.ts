import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LineWorkItemAdapter } from './line-adapter.js'
import { LocalReviewProvider } from './local-provider.js'
import {
  validateProviderCapabilities,
  type WorkItemProvider,
} from './provider.js'
import { WorkItemProviderRegistry } from './registry.js'
import { WorkItemService } from './service.js'
import {
  FileWorkItemStore,
  InMemoryWorkItemStore,
  toPersistedWorkItem,
} from './store.js'
import {
  createWorkItemDraft,
  transitionWorkItem,
  type WorkItemDraft,
} from './types.js'

const adapter = new LineWorkItemAdapter()

function draft(overrides: Partial<WorkItemDraft> = {}): WorkItemDraft {
  return createWorkItemDraft({
    id: 'work-1',
    createdAt: 100,
    source: {
      adapter: 'line.message',
      platform: 'line',
      conversationId: 'chat-1',
      messageIds: ['message-1'],
      latestMessageAt: 100,
    },
    evidence: [
      {
        sourceMessageId: 'message-1',
        senderId: 'u-1',
        senderName: 'Ada',
        sentAt: 100,
        text: 'customer text',
        attachments: [],
      },
    ],
    summary: null,
    action: 'review',
    destination: null,
    assignee: null,
    labels: [],
    ...overrides,
  })
}

test('LINE adapter normalizes CLI message and attachment metadata', () => {
  const bytes = new TextEncoder().encode('image')
  const normalized = adapter.normalize({
    id: 'm-1',
    conversationId: 'c-1',
    fromMid: 'u-1',
    fromName: 'Ada',
    timestamp: 123,
    text: 'please check this',
    attachments: [{ fileName: 'photo.png', mimeType: 'image/png', bytes }],
  })
  expect(normalized.source.messageIds).toEqual(['m-1'])
  expect(normalized.evidence[0].text).toBe('please check this')
  expect(normalized.evidence[0].attachments[0]).toMatchObject({
    fileName: 'photo.png',
    mimeType: 'image/png',
    byteLength: 5,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
  expect(normalized.evidence[0].attachments[0].bytes).toEqual(bytes)
})

test('LINE adapter rejects an unscoped message', () => {
  expect(() =>
    adapter.normalize({ id: 'm-1', text: 'missing chat id' }),
  ).toThrow('conversationId')
})

test('LINE adapter normalizes a selected batch chronologically and deduplicates ids', () => {
  const normalized = adapter.normalize([
    { id: 'late', conversationId: 'c-1', timestamp: 300, text: 'late' },
    { id: 'early', conversationId: 'c-1', timestamp: 100, text: 'early' },
    { id: 'late', conversationId: 'c-1', timestamp: 300, text: 'duplicate' },
  ])
  expect(normalized.sources).toHaveLength(1)
  expect(normalized.sources[0].messageIds).toEqual(['early', 'late'])
  expect(normalized.sources[0].latestMessageAt).toBe(300)
  expect(normalized.evidence.map((item) => item.text)).toEqual([
    'early',
    'late',
  ])
})

test('LINE adapter preserves evidence from multiple conversations', () => {
  const normalized = adapter.normalize([
    { id: 'same-id', conversationId: 'c-1', timestamp: 100 },
    { id: 'same-id', conversationId: 'c-2', timestamp: 200 },
  ])
  expect(normalized.sources.map((source) => source.conversationId)).toEqual([
    'c-1',
    'c-2',
  ])
  expect(normalized.evidence).toHaveLength(2)
})

test('state machine enforces preview, approval, delivery, and retry', () => {
  const initial = draft()
  const preview = transitionWorkItem(initial, { type: 'preview' }, 110)
  const approved = transitionWorkItem(preview, { type: 'approve' }, 120)
  const sending = transitionWorkItem(approved, { type: 'send' }, 130)
  const failed = transitionWorkItem(sending, {
    type: 'fail',
    at: 140,
    failure: { code: 'offline', message: 'offline', at: 140, retryable: true },
  })
  expect(failed.status).toBe('failed')
  const retried = transitionWorkItem(failed, { type: 'retry' }, 150)
  expect(retried.status).toBe('approved')
  expect(retried.failure).toBeNull()
  expect(() => transitionWorkItem(initial, { type: 'send' })).toThrow('Invalid')
  expect(() => transitionWorkItem(initial, { type: 'approve' })).toThrow(
    'Invalid',
  )
  const permanentFailure = transitionWorkItem(sending, {
    type: 'fail',
    failure: {
      code: 'permanent',
      message: 'permanent',
      at: 141,
      retryable: false,
    },
  })
  expect(() => transitionWorkItem(permanentFailure, { type: 'retry' })).toThrow(
    'not retryable',
  )
  expect(() =>
    transitionWorkItem(permanentFailure, { type: 'approve' }),
  ).toThrow('must use retry')
})

test('provider registry resolves unique providers', () => {
  const provider = new LocalReviewProvider()
  const registry = new WorkItemProviderRegistry().register(provider)
  expect(registry.resolve('local.review')).toBe(provider)
  expect(registry.list()).toHaveLength(1)
  expect(() => registry.register(provider)).toThrow('already registered')
  expect(() => registry.resolve('discord')).toThrow('Unknown')
})

test('provider capability validation is explicit and destination independent', () => {
  const provider: WorkItemProvider = {
    id: 'future.issue',
    displayName: 'Future issue provider',
    capabilities: {
      operations: ['issue'],
      attachments: false,
      maxAttachments: 0,
      requiresApproval: true,
    },
    validate: () => ({ valid: true, errors: [] }),
    deliver: async () => {
      throw new Error('must not deliver in validation test')
    },
  }
  const invalid = validateProviderCapabilities(
    provider,
    draft({ action: 'share' }),
  )
  expect(invalid.valid).toBe(false)
  expect(invalid.errors).toEqual(
    expect.arrayContaining(['Provider future.issue does not support share']),
  )
})

test('local provider delivers only after approval and never marks external delivery', async () => {
  const provider = new LocalReviewProvider()
  const registry = new WorkItemProviderRegistry().register(provider)
  const store = new InMemoryWorkItemStore()
  const service = new WorkItemService(store, registry)
  const created = await service.create(
    adapter,
    {
      id: 'm-1',
      conversationId: 'c-1',
      text: 'private',
    },
    { id: 'work-local', now: 100 },
  )
  await expect(service.deliver(created.id, provider)).rejects.toThrow(
    'requires an approved',
  )
  await service.transition(created.id, { type: 'preview' })
  await service.transition(created.id, { type: 'approve' })
  const delivered = await service.deliverByProviderId(
    created.id,
    'local.review',
  )
  expect(delivered.status).toBe('delivered')
  expect(delivered.delivery).toMatchObject({
    external: false,
    providerId: 'local.review',
  })
  expect(provider.get(created.id)?.evidence[0].text).toBe('private')
  expect(delivered.destination).toBe('local.review')
})

test('provider validation and destination mismatch do not mutate status', async () => {
  const store = new InMemoryWorkItemStore()
  const service = new WorkItemService(store)
  const created = await service.create(
    adapter,
    { id: 'm-3', conversationId: 'c-1', text: 'no mutation' },
    { id: 'work-validation', destination: 'other.provider', now: 100 },
  )
  await service.transition(created.id, { type: 'preview' })
  await service.transition(created.id, { type: 'approve' })
  await expect(
    service.deliver(created.id, new LocalReviewProvider()),
  ).rejects.toThrow('does not match provider')
  expect((await store.get(created.id))?.status).toBe('approved')
  expect((await store.get(created.id))?.destination).toBe('other.provider')
})

test('provider failure is persisted as retryable and can be retried', async () => {
  const store = new InMemoryWorkItemStore()
  const provider: WorkItemProvider = {
    id: 'failing',
    displayName: 'Failing provider',
    capabilities: {
      operations: ['review'],
      attachments: true,
      maxAttachments: 10,
      requiresApproval: false,
    },
    validate: () => ({ valid: true, errors: [] }),
    deliver: async () => {
      throw new Error('temporary')
    },
  }
  const service = new WorkItemService(store)
  const created = await service.create(
    adapter,
    {
      id: 'm-2',
      conversationId: 'c-1',
      text: 'retry me',
    },
    { id: 'work-fail', now: 100 },
  )
  await service.transition(created.id, { type: 'preview' })
  await service.transition(created.id, { type: 'approve' })
  await expect(service.deliver(created.id, provider)).rejects.toThrow(
    'temporary',
  )
  expect((await store.get(created.id))?.status).toBe('failed')
  expect((await store.get(created.id))?.failure?.retryable).toBe(true)
  await service.transition(created.id, { type: 'retry' })
  expect((await store.get(created.id))?.status).toBe('approved')
})

test('file store is bounded and strips plaintext evidence and transient attachment data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yomi-work-item-'))
  const path = join(directory, 'work-items.json')
  const store = new FileWorkItemStore(path, 1)
  const first = draft({
    id: 'first',
    evidence: [
      {
        ...draft().evidence[0],
        attachments: [
          {
            id: 'a',
            fileName: 'secret.png',
            mimeType: 'image/png',
            byteLength: 3,
            sha256: 'abc',
            bytes: new Uint8Array([1, 2, 3]),
            sourceUrl: 'https://secret.invalid',
          },
        ],
      },
    ],
  })
  await store.save(first)
  await store.save(draft({ id: 'second' }))
  const raw = await readFile(path, 'utf8')
  expect(raw).not.toContain('customer text')
  expect(raw).not.toContain('Ada')
  expect(raw).not.toContain('u-1')
  expect(raw).not.toContain('secret.png')
  expect(raw).not.toContain('secret.invalid')
  expect(await store.list()).toHaveLength(1)
  expect(toPersistedWorkItem(first).evidence[0].textSha256).toBeTruthy()
  expect(toPersistedWorkItem(first).evidence[0].senderNameHash).toBe(
    createHash('sha256').update('Ada').digest('hex'),
  )
})
