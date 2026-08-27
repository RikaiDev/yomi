import type { EventContext } from './event-context.js'
import type {
  DependencyProjection,
  DialogueActEvidence,
  OwnershipProjection,
  WorkEventInference,
  WorkLifecycle,
} from './work-event.js'

const DIALOGUE_ACTS = new Set([
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
const OWNERSHIP_STATES = new Set([
  'unassigned',
  'owned',
  'delegated',
  'unknown',
])
const PARTICIPANT_KINDS = new Set([
  'self',
  'conversation_member',
  'external_party',
  'unknown',
])
const DEPENDENCY_STATES = new Set([
  'none',
  'waiting_person',
  'waiting_external_system',
  'waiting_decision',
  'unknown',
])
const LIFECYCLES = new Set([
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

export interface ModelField<T> {
  value: T
  confidence: number
  evidenceMessageIds: string[]
}

export interface FactorizedModelOutput {
  dialogue: DialogueActEvidence[]
  createsWork: ModelField<boolean>
  action: null | {
    predicate: string
    object: string | null
    expectedOutcome: string | null
    dueAt: number | null
    sourceMessageIds: string[]
    confidence: number
  }
  ownership: ModelField<
    Omit<OwnershipProjection, 'confidence' | 'evidenceMessageIds'>
  >
  dependency: ModelField<
    Omit<DependencyProjection, 'confidence' | 'evidenceMessageIds'>
  >
  lifecycle: ModelField<WorkLifecycle>
  completion: ModelField<{
    delivered: boolean
    accepted: boolean
    cancelled: boolean
  }>
  modelId: string
}

export interface FactorizedEventCandidateOutput
  extends Omit<FactorizedModelOutput, 'dialogue' | 'modelId'> {
  candidateKey: string
}

export interface FactorizedGraphModelOutput {
  dialogue: DialogueActEvidence[]
  candidates: FactorizedEventCandidateOutput[]
  modelId: string
}

export interface InferenceThresholds {
  createsWork: number
  action: number
  ownership: number
  dependency: number
  lifecycle: number
  completion: number
}

export type FactorizedInferenceResult =
  | { kind: 'inference'; inference: WorkEventInference }
  | { kind: 'abstain'; reasons: string[]; modelId: string }

export interface FactorizedGraphInferenceResult {
  dialogue: DialogueActEvidence[]
  candidates: Array<{
    candidateKey: string
    result: FactorizedInferenceResult
  }>
  modelId: string
}

const DEFAULT_THRESHOLDS: InferenceThresholds = {
  createsWork: 0.82,
  action: 0.78,
  ownership: 0.8,
  dependency: 0.76,
  lifecycle: 0.82,
  completion: 0.86,
}

export interface FactorizedWorkEventProvider {
  readonly id: string
  infer(context: EventContext): Promise<FactorizedGraphModelOutput>
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validConfidence(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function validEvidenceArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  )
}

/** Runtime boundary for untrusted JSON emitted by a local model. */
export function validateFactorizedGraphModelOutput(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['model_output_not_object']
  if (typeof value.modelId !== 'string' || !value.modelId)
    errors.push('model_id_invalid')
  if (!Array.isArray(value.dialogue)) errors.push('dialogue_invalid')
  else
    for (const item of value.dialogue) {
      if (
        !isRecord(item) ||
        typeof item.messageId !== 'string' ||
        !Array.isArray(item.acts) ||
        item.acts.some((act) => !DIALOGUE_ACTS.has(act)) ||
        !validConfidence(item.confidence)
      )
        errors.push('dialogue_item_invalid')
    }
  if (!Array.isArray(value.candidates)) errors.push('candidates_invalid')
  else
    for (const candidate of value.candidates) {
      if (
        !isRecord(candidate) ||
        typeof candidate.candidateKey !== 'string' ||
        !candidate.candidateKey
      ) {
        errors.push('candidate_key_invalid')
        continue
      }
      for (const name of [
        'createsWork',
        'ownership',
        'dependency',
        'lifecycle',
        'completion',
      ]) {
        const field = candidate[name]
        if (
          !isRecord(field) ||
          !validConfidence(field.confidence) ||
          !validEvidenceArray(field.evidenceMessageIds)
        )
          errors.push(`${name}_field_invalid`)
      }
      if (
        !isRecord(candidate.createsWork) ||
        typeof candidate.createsWork.value !== 'boolean'
      )
        errors.push('creates_work_value_invalid')
      if (candidate.action !== null) {
        if (
          !isRecord(candidate.action) ||
          typeof candidate.action.predicate !== 'string' ||
          !candidate.action.predicate ||
          !validEvidenceArray(candidate.action.sourceMessageIds) ||
          candidate.action.sourceMessageIds.length === 0 ||
          !validConfidence(candidate.action.confidence)
        )
          errors.push('action_invalid')
      }
      const ownership = candidate.ownership?.value
      if (
        !isRecord(ownership) ||
        !OWNERSHIP_STATES.has(ownership.state) ||
        !Array.isArray(ownership.owners) ||
        ownership.owners.some(
          (owner: unknown) =>
            !isRecord(owner) || !PARTICIPANT_KINDS.has(owner.kind),
        )
      )
        errors.push('ownership_value_invalid')
      const dependency = candidate.dependency?.value
      if (!isRecord(dependency) || !DEPENDENCY_STATES.has(dependency.state))
        errors.push('dependency_value_invalid')
      if (
        !isRecord(candidate.lifecycle) ||
        !LIFECYCLES.has(candidate.lifecycle.value)
      )
        errors.push('lifecycle_value_invalid')
      const completion = candidate.completion?.value
      if (
        !isRecord(completion) ||
        ['delivered', 'accepted', 'cancelled'].some(
          (key) => typeof completion[key] !== 'boolean',
        )
      )
        errors.push('completion_value_invalid')
    }
  return [...new Set(errors)]
}

function validEvidence(ids: string[], available: Set<string>): boolean {
  return ids.length === 0 || ids.every((id) => available.has(id))
}

/** Validate, calibrate and project model output. It never converts uncertainty into no-work. */
export function projectFactorizedInference(
  context: EventContext,
  output: FactorizedModelOutput,
  thresholds: InferenceThresholds = DEFAULT_THRESHOLDS,
  inferredAt = Date.now(),
): FactorizedInferenceResult {
  const reasons: string[] = []
  const available = new Set(
    context.messages.map((message) => message.messageId),
  )
  if (!context.complete) reasons.push(`context_${context.boundary}`)
  if (output.dialogue.some((item) => !available.has(item.messageId)))
    reasons.push('dialogue_evidence_outside_context')
  if (!validEvidence(output.createsWork.evidenceMessageIds, available))
    reasons.push('work_evidence_outside_context')
  if (output.createsWork.confidence < thresholds.createsWork)
    reasons.push('work_confidence_low')
  if (output.createsWork.value && !output.action)
    reasons.push('work_action_missing')
  if (output.action) {
    if (output.action.sourceMessageIds.length === 0)
      reasons.push('action_source_missing')
    if (!validEvidence(output.action.sourceMessageIds, available))
      reasons.push('action_source_outside_context')
    if (output.action.confidence < thresholds.action)
      reasons.push('action_confidence_low')
  }
  for (const [name, field, threshold] of [
    ['ownership', output.ownership, thresholds.ownership],
    ['dependency', output.dependency, thresholds.dependency],
    ['lifecycle', output.lifecycle, thresholds.lifecycle],
    ['completion', output.completion, thresholds.completion],
  ] as const) {
    if (field.confidence < threshold) reasons.push(`${name}_confidence_low`)
    if (!validEvidence(field.evidenceMessageIds, available))
      reasons.push(`${name}_evidence_outside_context`)
  }
  if (output.completion.value.accepted && !output.completion.value.delivered)
    reasons.push('acceptance_without_delivery')
  if (
    output.lifecycle.value === 'accepted' &&
    !output.completion.value.accepted
  )
    reasons.push('accepted_lifecycle_without_evidence')
  if (
    output.lifecycle.value === 'cancelled' &&
    !output.completion.value.cancelled
  )
    reasons.push('cancelled_lifecycle_without_evidence')
  if (reasons.length > 0)
    return { kind: 'abstain', reasons, modelId: output.modelId }

  return {
    kind: 'inference',
    inference: {
      eventId: context.anchorMessageIds.slice().sort().join(':'),
      chatId: context.chatId,
      evidence: context.messages.map((message) => ({
        messageId: message.messageId,
        chatId: message.chatId,
        sentAt: message.sentAt,
        speaker: message.isSelf ? 'self' : 'other',
      })),
      dialogue: output.dialogue,
      createsWork: output.createsWork.value,
      workConfidence: output.createsWork.confidence,
      action: output.action
        ? {
            predicate: output.action.predicate,
            object: output.action.object,
            expectedOutcome: output.action.expectedOutcome,
            dueAt: output.action.dueAt,
            confidence: output.action.confidence,
            evidenceMessageIds: output.action.sourceMessageIds,
          }
        : null,
      ownership: {
        ...output.ownership.value,
        confidence: output.ownership.confidence,
        evidenceMessageIds: output.ownership.evidenceMessageIds,
      },
      dependency: {
        ...output.dependency.value,
        confidence: output.dependency.confidence,
        evidenceMessageIds: output.dependency.evidenceMessageIds,
      },
      lifecycle: output.lifecycle.value,
      completion: {
        ...output.completion.value,
        confidence: output.completion.confidence,
        evidenceMessageIds: output.completion.evidenceMessageIds,
      },
      sourceModel: output.modelId,
      inferredAt,
    },
  }
}

/** Project every hypothesis independently; one utterance may support several events. */
export function projectFactorizedGraphInference(
  context: EventContext,
  output: FactorizedGraphModelOutput,
  thresholds: InferenceThresholds = DEFAULT_THRESHOLDS,
  inferredAt = Date.now(),
): FactorizedGraphInferenceResult {
  const validationErrors = validateFactorizedGraphModelOutput(output)
  if (validationErrors.length > 0) {
    return {
      dialogue: [],
      candidates: [
        {
          candidateKey: '',
          result: {
            kind: 'abstain',
            reasons: validationErrors.map((error) => `model_output_${error}`),
            modelId:
              typeof output?.modelId === 'string' ? output.modelId : 'unknown',
          },
        },
      ],
      modelId: typeof output?.modelId === 'string' ? output.modelId : 'unknown',
    }
  }
  const keys = new Set<string>()
  const candidates = output.candidates.map((candidate) => {
    if (!candidate.candidateKey || keys.has(candidate.candidateKey)) {
      return {
        candidateKey: candidate.candidateKey,
        result: {
          kind: 'abstain',
          reasons: ['candidate_key_invalid'],
          modelId: output.modelId,
        } as FactorizedInferenceResult,
      }
    }
    keys.add(candidate.candidateKey)
    const result = projectFactorizedInference(
      context,
      { ...candidate, dialogue: output.dialogue, modelId: output.modelId },
      thresholds,
      inferredAt,
    )
    if (result.kind === 'inference') {
      result.inference.eventId = `${context.anchorMessageIds.slice().sort().join(':')}:${candidate.candidateKey}`
    }
    return { candidateKey: candidate.candidateKey, result }
  })
  return { dialogue: output.dialogue, candidates, modelId: output.modelId }
}
