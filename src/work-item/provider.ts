import type { WorkItemDelivery, WorkItemDraft } from './types.js'

export type WorkItemProviderOperation = 'share' | 'message' | 'issue' | 'review'

export interface WorkItemProviderCapabilities {
  readonly operations: readonly WorkItemProviderOperation[]
  attachments: boolean
  maxAttachments: number
  requiresApproval: boolean
}

export interface ProviderValidation {
  valid: boolean
  errors: string[]
}

export interface ProviderDeliveryResult {
  delivery: WorkItemDelivery
}

export interface WorkItemProvider {
  readonly id: string
  readonly displayName: string
  readonly capabilities: WorkItemProviderCapabilities
  validate(draft: WorkItemDraft): ProviderValidation
  deliver(draft: WorkItemDraft): Promise<ProviderDeliveryResult>
}

export function validateProviderCapabilities(
  provider: WorkItemProvider,
  draft: WorkItemDraft,
): ProviderValidation {
  const errors: string[] = []
  if (!provider.capabilities.operations.includes(draft.action)) {
    errors.push(`Provider ${provider.id} does not support ${draft.action}`)
  }
  const attachmentCount = draft.evidence.reduce(
    (count, evidence) => count + evidence.attachments.length,
    0,
  )
  if (!provider.capabilities.attachments && attachmentCount > 0) {
    errors.push(`Provider ${provider.id} does not support attachments`)
  } else if (attachmentCount > provider.capabilities.maxAttachments) {
    errors.push(
      `Provider ${provider.id} accepts at most ${provider.capabilities.maxAttachments} attachments`,
    )
  }
  // The service passes `sending` after atomically recording approval. A
  // direct provider call still requires the draft to be approved first.
  if (
    provider.capabilities.requiresApproval &&
    draft.status !== 'approved' &&
    draft.status !== 'sending'
  ) {
    errors.push(`Provider ${provider.id} requires an approved work item`)
  }
  return { valid: errors.length === 0, errors }
}
