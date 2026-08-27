import {
  type CreateWorkItemOptions,
  InMemoryWorkItemStore,
  LineWorkItemAdapter,
  type LineWorkItemInput,
  LocalReviewProvider,
  WorkItemProviderRegistry,
  WorkItemService,
} from '../work-item/index.js'
import type { WorkItemDraft } from '../work-item/types.js'

/**
 * Read-only/create-draft bridge for the desktop and CLI callers. It never
 * sends to a destination; callers must explicitly select a provider and
 * approve the draft before delivery.
 */
export async function cliCreateWorkItemDraftJson(
  input: LineWorkItemInput,
  options: CreateWorkItemOptions = {},
) {
  const service = new WorkItemService(new InMemoryWorkItemStore())
  return service.create(new LineWorkItemAdapter(), input, options)
}

export type WorkItemCliOperation = 'preview' | 'approve' | 'local-review'

/** Execute only local Work Item transitions; no external provider is registered. */
export async function cliWorkItemOperationJson(
  operation: WorkItemCliOperation,
  draft: WorkItemDraft,
) {
  const store = new InMemoryWorkItemStore()
  const provider = new LocalReviewProvider()
  const registry = new WorkItemProviderRegistry().register(provider)
  const service = new WorkItemService(store, registry)
  await store.save(draft)
  if (operation === 'local-review') {
    return service.deliverByProviderId(draft.id, 'local.review')
  }
  return service.transition(draft.id, {
    type: operation === 'preview' ? 'preview' : 'approve',
  })
}
