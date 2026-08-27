import type {
  DependencyState,
  DialogueAct,
  OwnershipState,
  WorkLifecycle,
} from './work-event.js'

export interface FactorizedGoldRecord {
  id: string
  language: string
  context: Array<{ speaker: 'self' | 'other'; text: string }>
  targetIndex: number
  dialogueActs: DialogueAct[]
  createsWork: boolean
  action: null | {
    predicate: string
    object: string | null
    expectedOutcome: string | null
  }
  ownership: {
    state: OwnershipState
    ownerKinds: Array<
      'self' | 'conversation_member' | 'external_party' | 'unknown'
    >
  }
  dependency: DependencyState
  lifecycle: WorkLifecycle
  completion: { delivered: boolean; accepted: boolean; cancelled: boolean }
  /** Action-bearing messages; surrounding context may overlap across split events. */
  evidenceIndexes?: number[]
  evidenceMessageIds?: string[]
  source?: { chatId: string; graphEventId: string; graphVersion?: number }
}

const ACTS = new Set<DialogueAct>([
  'inform',
  'ask',
  'answer',
  'directive',
  'commit',
  'delegate',
  'acknowledge',
  'deliver',
  'accept',
  'reject',
  'cancel',
])
const OWNERSHIP = new Set<OwnershipState>([
  'unassigned',
  'owned',
  'delegated',
  'unknown',
])
const OWNER_KINDS = new Set([
  'self',
  'conversation_member',
  'external_party',
  'unknown',
])
const DEPENDENCIES = new Set<DependencyState>([
  'none',
  'waiting_person',
  'waiting_external_system',
  'waiting_decision',
  'unknown',
])
const LIFECYCLES = new Set<WorkLifecycle>([
  'proposed',
  'committed',
  'in_progress',
  'blocked',
  'delivered',
  'accepted',
  'cancelled',
  'resolved',
  'uncertain',
])

export function validateFactorizedGold(value: FactorizedGoldRecord): string[] {
  const errors: string[] = []
  if (!value.id) errors.push('id is required')
  if (!Array.isArray(value.context) || value.context.length === 0)
    errors.push('context is required')
  if (
    !Number.isInteger(value.targetIndex) ||
    value.targetIndex < 0 ||
    value.targetIndex >= value.context.length
  )
    errors.push('targetIndex is outside context')
  if (
    !value.dialogueActs.length ||
    value.dialogueActs.some((act) => !ACTS.has(act))
  )
    errors.push('dialogueActs are invalid')
  if (value.createsWork && !value.action)
    errors.push('work requires an action frame')
  if (!OWNERSHIP.has(value.ownership.state)) errors.push('ownership is invalid')
  if (
    !Array.isArray(value.ownership.ownerKinds) ||
    value.ownership.ownerKinds.length === 0 ||
    value.ownership.ownerKinds.some((kind) => !OWNER_KINDS.has(kind))
  )
    errors.push('ownerKinds are invalid')
  if (!DEPENDENCIES.has(value.dependency)) errors.push('dependency is invalid')
  if (!LIFECYCLES.has(value.lifecycle)) errors.push('lifecycle is invalid')
  if (value.completion.accepted && !value.completion.delivered)
    errors.push('acceptance requires delivery')
  if (value.lifecycle === 'delivered' && !value.completion.delivered)
    errors.push('delivered lifecycle requires delivery evidence')
  if (value.lifecycle === 'accepted' && !value.completion.accepted)
    errors.push('accepted lifecycle requires acceptance evidence')
  if (value.lifecycle === 'cancelled' && !value.completion.cancelled)
    errors.push('cancelled lifecycle requires cancellation evidence')
  if (value.evidenceIndexes) {
    if (value.evidenceIndexes.length === 0)
      errors.push('evidenceIndexes cannot be empty')
    if (new Set(value.evidenceIndexes).size !== value.evidenceIndexes.length)
      errors.push('evidenceIndexes must be unique')
    if (
      value.evidenceIndexes.some(
        (index) =>
          !Number.isInteger(index) ||
          index < 0 ||
          index >= value.context.length,
      )
    ) {
      errors.push('evidenceIndexes are outside context')
    }
    if (!value.evidenceIndexes.includes(value.targetIndex))
      errors.push('evidenceIndexes must include targetIndex')
  }
  if (value.evidenceMessageIds) {
    if (value.evidenceMessageIds.length === 0)
      errors.push('evidenceMessageIds cannot be empty')
    if (
      new Set(value.evidenceMessageIds).size !== value.evidenceMessageIds.length
    )
      errors.push('evidenceMessageIds must be unique')
    if (
      value.evidenceIndexes &&
      value.evidenceMessageIds.length !== value.evidenceIndexes.length
    ) {
      errors.push('evidence index and message id counts differ')
    }
  }
  return errors
}
