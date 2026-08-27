import { randomUUID } from 'node:crypto'
import type { WorkItemAdapter } from './adapter.js'
import {
  validateProviderCapabilities,
  type WorkItemProvider,
} from './provider.js'
import type { WorkItemProviderRegistry } from './registry.js'
import type { WorkItemDraftStore } from './store.js'
import {
  createWorkItemDraft,
  transitionWorkItem,
  type WorkItemAction,
  type WorkItemDraft,
} from './types.js'

export interface CreateWorkItemOptions {
  id?: string
  action?: WorkItemAction
  summary?: string | null
  destination?: string | null
  assignee?: string | null
  labels?: string[]
  now?: number
}

export class WorkItemService {
  constructor(
    private readonly store: WorkItemDraftStore,
    private readonly registry?: WorkItemProviderRegistry,
  ) {}

  async create<T>(
    adapter: WorkItemAdapter<T>,
    input: T,
    options: CreateWorkItemOptions = {},
  ): Promise<WorkItemDraft> {
    const normalized = await adapter.normalize(input)
    const now = options.now ?? Date.now()
    const draft = createWorkItemDraft({
      id: options.id ?? `work-${now}-${randomUUID()}`,
      createdAt: now,
      source: normalized.source,
      sources: normalized.sources,
      evidence: normalized.evidence,
      summary: options.summary ?? null,
      action: options.action ?? 'review',
      destination: options.destination ?? null,
      assignee: options.assignee ?? null,
      labels: options.labels ?? [],
    })
    await this.store.save(draft)
    return draft
  }

  async transition(
    id: string,
    event: Parameters<typeof transitionWorkItem>[1],
  ): Promise<WorkItemDraft> {
    const current = await this.store.get(id)
    if (!current || !('evidence' in current))
      throw new Error(`Unknown work item: ${id}`)
    const next = transitionWorkItem(current, event)
    await this.store.save(next)
    return next
  }

  async deliver(
    id: string,
    provider: WorkItemProvider,
  ): Promise<WorkItemDraft> {
    const current = await this.store.get(id)
    if (!current || !('evidence' in current))
      throw new Error(`Unknown work item: ${id}`)
    if (current.destination && current.destination !== provider.id) {
      throw new Error(
        `Work item destination ${current.destination} does not match provider ${provider.id}`,
      )
    }
    const candidate = current.destination
      ? current
      : { ...current, destination: provider.id }
    const capabilityValidation = validateProviderCapabilities(
      provider,
      candidate,
    )
    const providerValidation = provider.validate(candidate)
    const errors = [
      ...capabilityValidation.errors,
      ...providerValidation.errors,
    ]
    if (errors.length > 0) throw new Error(errors.join('; '))
    const sending = transitionWorkItem(candidate, { type: 'send' })
    await this.store.save(sending)
    try {
      const result = await provider.deliver(sending)
      const delivered = transitionWorkItem(sending, {
        type: 'deliver',
        delivery: result.delivery,
      })
      await this.store.save(delivered)
      return delivered
    } catch (error) {
      const failed = transitionWorkItem(sending, {
        type: 'fail',
        failure: {
          code: 'provider_delivery_failed',
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
          retryable: true,
        },
      })
      await this.store.save(failed)
      throw error
    }
  }

  async deliverByProviderId(
    id: string,
    providerId: string,
  ): Promise<WorkItemDraft> {
    if (!this.registry)
      throw new Error('Work item provider registry is not configured')
    return this.deliver(id, this.registry.resolve(providerId))
  }
}
