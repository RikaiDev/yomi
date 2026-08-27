/**
 * Destination-agnostic work item domain.
 *
 * Message text and attachment bytes are intentionally kept in memory only.
 * The persistence projection (see store.ts) contains metadata and digests,
 * never decrypted LINE content.
 */

export type WorkItemId = string

export type WorkItemStatus =
  | 'draft'
  | 'preview'
  | 'approved'
  | 'sending'
  | 'delivered'
  | 'failed'

export type WorkItemAction = 'share' | 'message' | 'issue' | 'review'

/** State projected from an ambient event, independent from delivery status. */
export type WorkItemOwnerState =
  | 'self'
  | 'delegated'
  | 'waiting_external'
  | 'other'

export type WorkItemResolutionState = 'open' | 'resolved' | 'uncertain'
export type WorkItemTitleKey =
  | 'follow_up'
  | 'delegated_task'
  | 'delivery'
  | 'review'

export interface WorkItemSourceRef {
  adapter: string
  platform: 'line' | (string & {})
  conversationId: string
  messageIds: string[]
  latestMessageAt: number
}

export interface WorkItemAttachment {
  id: string
  fileName: string | null
  mimeType: string | null
  byteLength: number | null
  sha256: string | null
  /** A provider may use this in memory; it is never persisted. */
  bytes?: Uint8Array
  /** A provider may use this in memory; it is never persisted. */
  sourceUrl?: string
}

export interface WorkItemEvidence {
  source: WorkItemSourceRef
  /** @deprecated Use source.messageIds[0]. Kept for bridge compatibility. */
  sourceMessageId: string
  senderId: string | null
  senderName: string | null
  sentAt: number
  text: string | null
  attachments: WorkItemAttachment[]
}

export interface WorkItemDraft {
  id: WorkItemId
  createdAt: number
  updatedAt: number
  /** @deprecated Use sources. Kept for older bridges during migration. */
  source?: WorkItemSourceRef
  sources: WorkItemSourceRef[]
  evidence: WorkItemEvidence[]
  summary: string | null
  action: WorkItemAction
  destination: string | null
  assignee: string | null
  labels: string[]
  status: WorkItemStatus
  failure: WorkItemFailure | null
  delivery: WorkItemDelivery | null
  /** Optional because legacy manually-created drafts predate ambient promotion. */
  ownerState?: WorkItemOwnerState
  resolutionState?: WorkItemResolutionState
  titleKey?: WorkItemTitleKey
}

export interface WorkItemFailure {
  code: string
  message: string
  at: number
  retryable: boolean
}

export interface WorkItemDelivery {
  providerId: string
  deliveredAt: number
  external: boolean
  reference: string | null
}

export type WorkItemEvent =
  | { type: 'preview'; at?: number }
  | { type: 'approve'; at?: number }
  | { type: 'send'; at?: number }
  | { type: 'deliver'; at?: number; delivery: WorkItemDelivery }
  | { type: 'fail'; at?: number; failure: WorkItemFailure }
  | { type: 'retry'; at?: number }

const TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  draft: ['preview'],
  preview: ['approved', 'draft'],
  approved: ['sending', 'draft'],
  sending: ['delivered', 'failed'],
  delivered: [],
  failed: ['approved', 'draft'],
}

export function canTransition(
  from: WorkItemStatus,
  to: WorkItemStatus,
): boolean {
  return TRANSITIONS[from].includes(to)
}

export function transitionWorkItem(
  draft: WorkItemDraft,
  event: WorkItemEvent,
  now = Date.now(),
): WorkItemDraft {
  const target: WorkItemStatus =
    event.type === 'preview'
      ? 'preview'
      : event.type === 'approve'
        ? 'approved'
        : event.type === 'send'
          ? 'sending'
          : event.type === 'deliver'
            ? 'delivered'
            : event.type === 'fail'
              ? 'failed'
              : 'approved'
  if (!canTransition(draft.status, target)) {
    throw new Error(`Invalid work item transition: ${draft.status} → ${target}`)
  }
  if (draft.status === 'failed' && event.type !== 'retry') {
    throw new Error('Failed work items must use retry')
  }
  if (event.type === 'retry' && !draft.failure?.retryable) {
    throw new Error('Work item failure is not retryable')
  }
  const updatedAt = event.at ?? now
  return {
    ...draft,
    status: target,
    updatedAt,
    failure:
      event.type === 'fail' || event.type === 'retry'
        ? event.type === 'fail'
          ? event.failure
          : null
        : null,
    delivery: event.type === 'deliver' ? event.delivery : draft.delivery,
  }
}

export function createWorkItemDraft(
  input: Omit<
    WorkItemDraft,
    'status' | 'failure' | 'delivery' | 'updatedAt' | 'sources'
  > &
    Partial<Pick<WorkItemDraft, 'updatedAt' | 'sources'>>,
): WorkItemDraft {
  const sources = input.sources?.length
    ? input.sources
    : input.evidence
        .map((evidence) => evidence.source ?? input.source)
        .filter((source): source is WorkItemSourceRef => Boolean(source))
  return {
    ...input,
    sources,
    source: input.source ?? sources[0],
    updatedAt: input.updatedAt ?? input.createdAt,
    status: 'draft',
    failure: null,
    delivery: null,
  }
}

/** Upgrade a draft received from a pre-collection bridge. */
export function normalizeWorkItemDraft(draft: WorkItemDraft): WorkItemDraft {
  const sources = draft.sources?.length
    ? draft.sources
    : draft.evidence
        .map((evidence) => evidence.source ?? draft.source)
        .filter((source): source is WorkItemSourceRef => Boolean(source))
  if (sources.length === 0)
    throw new Error('Work item has no valid evidence source')
  return { ...draft, sources, source: draft.source ?? sources[0] }
}
