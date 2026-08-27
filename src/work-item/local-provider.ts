import {
  type ProviderDeliveryResult,
  type ProviderValidation,
  validateProviderCapabilities,
  type WorkItemProvider,
} from './provider.js'
import type { WorkItemDraft } from './types.js'

/**
 * A local review sink. It deliberately never opens a socket or invokes a
 * system share panel, so preview/delivery can be exercised safely in tests.
 */
export class LocalReviewProvider implements WorkItemProvider {
  readonly id = 'local.review'
  readonly displayName = 'Local review'
  readonly capabilities = {
    operations: ['share', 'message', 'issue', 'review'] as const,
    attachments: true,
    maxAttachments: 100,
    requiresApproval: true,
  }
  private readonly delivered = new Map<string, WorkItemDraft>()

  validate(draft: WorkItemDraft): ProviderValidation {
    return validateProviderCapabilities(this, draft)
  }

  async deliver(draft: WorkItemDraft): Promise<ProviderDeliveryResult> {
    const validation = this.validate(draft)
    if (!validation.valid) throw new Error(validation.errors.join('; '))
    // Keep the in-process object available to a local UI/reviewer only.
    this.delivered.set(draft.id, structuredClone(draft))
    return {
      delivery: {
        providerId: this.id,
        deliveredAt: Date.now(),
        external: false,
        reference: `local-review://${draft.id}`,
      },
    }
  }

  get(id: string): WorkItemDraft | null {
    const draft = this.delivered.get(id)
    return draft ? structuredClone(draft) : null
  }
}
