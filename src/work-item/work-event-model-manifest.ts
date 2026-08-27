export interface WorkEventModelGateEvidence {
  passed: boolean
  reportSha256: string
}

export interface WorkEventModelManifest {
  schemaVersion: 1
  modelId: string
  artifactSha256: string
  quantization: string
  sourceModel: string
  datasetRevision: string
  conversationSplit: WorkEventModelGateEvidence
  factorizedCoverage: WorkEventModelGateEvidence
  publicAcceptance: WorkEventModelGateEvidence
  privateAcceptance: WorkEventModelGateEvidence
  quantizationValidation: WorkEventModelGateEvidence
  targetHardwareBenchmark: WorkEventModelGateEvidence
  modelOwnerApproved: boolean
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value)
}

export function productionEligibilityErrors(
  manifest: WorkEventModelManifest,
): string[] {
  const errors: string[] = []
  if (manifest.schemaVersion !== 1) errors.push('manifest_schema_unsupported')
  if (!manifest.modelId) errors.push('model_id_missing')
  if (!validDigest(manifest.artifactSha256))
    errors.push('artifact_digest_invalid')
  if (!manifest.quantization) errors.push('quantization_missing')
  if (!manifest.sourceModel) errors.push('source_model_missing')
  if (!manifest.datasetRevision) errors.push('dataset_revision_missing')
  for (const [name, evidence] of Object.entries({
    conversationSplit: manifest.conversationSplit,
    factorizedCoverage: manifest.factorizedCoverage,
    publicAcceptance: manifest.publicAcceptance,
    privateAcceptance: manifest.privateAcceptance,
    quantizationValidation: manifest.quantizationValidation,
    targetHardwareBenchmark: manifest.targetHardwareBenchmark,
  })) {
    if (!evidence?.passed) errors.push(`${name}_not_passed`)
    if (!evidence || !validDigest(evidence.reportSha256))
      errors.push(`${name}_report_digest_invalid`)
  }
  if (!manifest.modelOwnerApproved) errors.push('model_owner_not_approved')
  return errors
}

export function assertProductionEligibleModel(
  manifest: WorkEventModelManifest,
): void {
  const errors = productionEligibilityErrors(manifest)
  if (errors.length > 0)
    throw new Error(
      `Work-event model is not production eligible: ${errors.join(', ')}`,
    )
}
