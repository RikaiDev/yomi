export type GoldDerivationDisposition =
  | 'included'
  | 'split'
  | 'temporarily_excluded'
  | 'root_cause_pending'
  | 'insufficient_evidence'

export type GoldDerivationReason =
  | 'coherent_work_event'
  | 'multiple_work_events'
  | 'context_boundary_truncated'
  | 'missing_decryption'
  | 'media_semantics_unavailable'
  | 'missing_antecedent'
  | 'non_work_social_event'

export interface GoldDerivationRevision {
  schemaVersion: 1
  derivationId: string
  revision: number
  previousRevision: number | null
  conversationId: string
  graphEventId: string
  disposition: GoldDerivationDisposition
  reasons: GoldDerivationReason[]
  evidenceMessageIds: string[]
  derivedGoldIds: string[]
  supersedesDerivationIds: string[]
  contextComplete: boolean
  reviewedAt: number
}

export interface GoldDerivationInput
  extends Omit<
    GoldDerivationRevision,
    'schemaVersion' | 'revision' | 'previousRevision'
  > {}

export function validateGoldDerivation(
  value: GoldDerivationRevision,
): string[] {
  const errors: string[] = []
  if (value.schemaVersion !== 1) errors.push('unsupported schemaVersion')
  if (!value.derivationId) errors.push('derivationId is required')
  if (!Number.isInteger(value.revision) || value.revision < 1)
    errors.push('revision must be positive')
  if (value.revision === 1 && value.previousRevision !== null)
    errors.push('first revision cannot have a predecessor')
  if (value.revision > 1 && value.previousRevision !== value.revision - 1)
    errors.push('revision chain is invalid')
  if (!value.conversationId) errors.push('conversationId is required')
  if (!value.graphEventId) errors.push('graphEventId is required')
  if (value.reasons.length === 0)
    errors.push('at least one derivation reason is required')
  if (
    new Set(value.evidenceMessageIds).size !== value.evidenceMessageIds.length
  )
    errors.push('evidenceMessageIds must be unique')
  if (new Set(value.derivedGoldIds).size !== value.derivedGoldIds.length)
    errors.push('derivedGoldIds must be unique')
  if (value.disposition === 'included' && value.derivedGoldIds.length !== 1)
    errors.push('included context requires exactly one gold record')
  if (value.disposition === 'split' && value.derivedGoldIds.length < 2)
    errors.push('split context requires at least two gold records')
  if (
    !['included', 'split'].includes(value.disposition) &&
    value.derivedGoldIds.length > 0
  )
    errors.push('excluded context cannot produce gold records')
  if (
    !value.contextComplete &&
    !value.reasons.includes('context_boundary_truncated') &&
    !value.reasons.includes('missing_antecedent')
  ) {
    errors.push('incomplete context requires a boundary reason')
  }
  return errors
}

export function createGoldDerivation(
  input: GoldDerivationInput,
): GoldDerivationRevision {
  const revision: GoldDerivationRevision = {
    ...input,
    schemaVersion: 1,
    revision: 1,
    previousRevision: null,
  }
  const errors = validateGoldDerivation(revision)
  if (errors.length > 0) throw new Error(errors.join('; '))
  return revision
}

/** Revisions make exclusions and earlier interpretations explicitly reversible. */
export function reviseGoldDerivation(
  previous: GoldDerivationRevision,
  input: GoldDerivationInput,
): GoldDerivationRevision {
  if (previous.derivationId !== input.derivationId)
    throw new Error('Cannot revise a different derivation')
  if (
    previous.conversationId !== input.conversationId ||
    previous.graphEventId !== input.graphEventId
  ) {
    throw new Error('Derivation source cannot change across revisions')
  }
  const revision: GoldDerivationRevision = {
    ...input,
    schemaVersion: 1,
    revision: previous.revision + 1,
    previousRevision: previous.revision,
  }
  const errors = validateGoldDerivation(revision)
  if (errors.length > 0) throw new Error(errors.join('; '))
  return revision
}
