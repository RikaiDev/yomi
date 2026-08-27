/** Factorized, revisable projection of work emerging from a conversation event. */
export type DialogueAct =
  | 'inform'
  | 'ask'
  | 'answer'
  | 'directive'
  | 'commit'
  | 'delegate'
  | 'acknowledge'
  | 'deliver'
  | 'accept'
  | 'reject'
  | 'cancel'

export type WorkLifecycle =
  | 'proposed'
  | 'committed'
  | 'in_progress'
  | 'blocked'
  | 'delivered'
  | 'accepted'
  | 'cancelled'
  | 'resolved'
  | 'uncertain'

export type DependencyState =
  | 'none'
  | 'waiting_person'
  | 'waiting_external_system'
  | 'waiting_decision'
  | 'unknown'

export type OwnershipState = 'unassigned' | 'owned' | 'delegated' | 'unknown'

export interface EvidenceRef {
  messageId: string
  chatId: string
  sentAt: number
  speaker: 'self' | 'other'
}

export interface DialogueActEvidence {
  messageId: string
  acts: DialogueAct[]
  confidence: number
}

export interface ActionFrame {
  predicate: string
  object: string | null
  expectedOutcome: string | null
  dueAt: number | null
  confidence: number
  evidenceMessageIds: string[]
}

export interface ParticipantRef {
  kind: 'self' | 'conversation_member' | 'external_party' | 'unknown'
  stableId: string | null
  displayName: string | null
}

export interface OwnershipProjection {
  state: OwnershipState
  owners: ParticipantRef[]
  confidence: number
  evidenceMessageIds: string[]
}

export interface DependencyProjection {
  state: DependencyState
  on: ParticipantRef | null
  confidence: number
  evidenceMessageIds: string[]
}

export interface CompletionProjection {
  delivered: boolean
  accepted: boolean
  cancelled: boolean
  confidence: number
  evidenceMessageIds: string[]
}

export type RevisionReason =
  | 'created'
  | 'evidence_added'
  | 'inference_changed'
  | 'merged'
  | 'split'
  | 'excluded'
  | 'temporarily_excluded'
  | 'root_cause_pending'
  | 'reopened'

export interface WorkEventInference {
  eventId: string
  chatId: string
  evidence: EvidenceRef[]
  dialogue: DialogueActEvidence[]
  createsWork: boolean
  workConfidence: number
  action: ActionFrame | null
  ownership: OwnershipProjection
  dependency: DependencyProjection
  lifecycle: WorkLifecycle
  completion: CompletionProjection
  sourceModel: string
  inferredAt: number
}

export interface WorkEventRevision extends WorkEventInference {
  schemaVersion: 1
  revision: number
  previousRevision: number | null
  active: boolean
  reasons: RevisionReason[]
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function evidenceUnion(
  previous: EvidenceRef[],
  incoming: EvidenceRef[],
): EvidenceRef[] {
  return [
    ...new Map(
      [...previous, ...incoming].map((item) => [item.messageId, item]),
    ).values(),
  ].sort((left, right) => left.sentAt - right.sentAt)
}

/**
 * Append a new authoritative revision without making lifecycle monotonic.
 * A later event window may disprove an earlier completion and reopen work.
 */
export function reviseWorkEvent(
  previous: WorkEventRevision | null,
  inference: WorkEventInference,
  explicitReasons: RevisionReason[] = [],
): WorkEventRevision {
  if (!previous) {
    return {
      ...inference,
      schemaVersion: 1,
      revision: 1,
      previousRevision: null,
      active: inference.createsWork,
      reasons: ['created', ...explicitReasons],
    }
  }
  if (previous.eventId !== inference.eventId) {
    throw new Error('Cannot revise a different work event')
  }
  const evidence = evidenceUnion(previous.evidence, inference.evidence)
  const evidenceAdded = evidence.length > previous.evidence.length
  const inferenceChanged = !sameValue(
    {
      dialogue: previous.dialogue,
      createsWork: previous.createsWork,
      action: previous.action,
      ownership: previous.ownership,
      dependency: previous.dependency,
      lifecycle: previous.lifecycle,
      completion: previous.completion,
    },
    {
      dialogue: inference.dialogue,
      createsWork: inference.createsWork,
      action: inference.action,
      ownership: inference.ownership,
      dependency: inference.dependency,
      lifecycle: inference.lifecycle,
      completion: inference.completion,
    },
  )
  const wasClosed = ['accepted', 'cancelled', 'resolved'].includes(
    previous.lifecycle,
  )
  const isOpen = ['proposed', 'committed', 'in_progress', 'blocked'].includes(
    inference.lifecycle,
  )
  const reasons = [
    ...(evidenceAdded ? (['evidence_added'] as RevisionReason[]) : []),
    ...(inferenceChanged ? (['inference_changed'] as RevisionReason[]) : []),
    ...(wasClosed && isOpen ? (['reopened'] as RevisionReason[]) : []),
    ...explicitReasons,
  ]
  return {
    ...inference,
    evidence,
    schemaVersion: 1,
    revision: previous.revision + 1,
    previousRevision: previous.revision,
    active:
      inference.createsWork &&
      !['accepted', 'cancelled', 'resolved'].includes(inference.lifecycle),
    reasons: [...new Set(reasons)],
  }
}

export function excludeWorkEvent(
  previous: WorkEventRevision,
  temporary = false,
): WorkEventRevision {
  return {
    ...previous,
    revision: previous.revision + 1,
    previousRevision: previous.revision,
    active: false,
    reasons: [temporary ? 'temporarily_excluded' : 'excluded'],
  }
}

export interface SplitWorkEventResult {
  superseded: WorkEventRevision
  children: WorkEventRevision[]
}

export function splitWorkEvent(
  previous: WorkEventRevision,
  childInferences: WorkEventInference[],
): SplitWorkEventResult {
  if (childInferences.length < 2)
    throw new Error('A split requires at least two child events')
  const previousEvidence = new Set(
    previous.evidence.map((item) => item.messageId),
  )
  const childIds = new Set<string>()
  for (const child of childInferences) {
    if (childIds.has(child.eventId))
      throw new Error('Split children require distinct event ids')
    childIds.add(child.eventId)
    if (child.evidence.length === 0)
      throw new Error('Split child requires evidence')
    for (const evidence of child.evidence) {
      if (!previousEvidence.has(evidence.messageId))
        throw new Error(
          'Split child contains evidence outside the parent event',
        )
    }
  }
  const superseded: WorkEventRevision = {
    ...previous,
    revision: previous.revision + 1,
    previousRevision: previous.revision,
    active: false,
    reasons: ['split'],
  }
  return {
    superseded,
    children: childInferences.map((child) => ({
      ...reviseWorkEvent(null, child, ['split']),
      previousRevision: previous.revision,
    })),
  }
}

export interface MergeWorkEventsResult {
  superseded: WorkEventRevision[]
  merged: WorkEventRevision
}

export function mergeWorkEvents(
  previous: WorkEventRevision[],
  mergedInference: WorkEventInference,
): MergeWorkEventsResult {
  if (previous.length < 2)
    throw new Error('A merge requires at least two source events')
  const sourceEvidence = new Set(
    previous.flatMap((event) => event.evidence.map((item) => item.messageId)),
  )
  for (const evidence of mergedInference.evidence) {
    if (!sourceEvidence.has(evidence.messageId))
      throw new Error('Merged event contains unknown evidence')
  }
  return {
    superseded: previous.map((event) => ({
      ...event,
      revision: event.revision + 1,
      previousRevision: event.revision,
      active: false,
      reasons: ['merged'],
    })),
    merged: reviseWorkEvent(null, mergedInference, ['merged']),
  }
}
