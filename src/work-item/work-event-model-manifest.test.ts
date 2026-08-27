import { expect, test } from 'bun:test'
import {
  assertProductionEligibleModel,
  productionEligibilityErrors,
  type WorkEventModelManifest,
} from './work-event-model-manifest.js'

const digest = 'a'.repeat(64)
const eligible: WorkEventModelManifest = {
  schemaVersion: 1,
  modelId: 'student-fixture',
  artifactSha256: digest,
  quantization: 'Q4_K_M',
  sourceModel: 'student-source',
  datasetRevision: digest,
  conversationSplit: { passed: true, reportSha256: digest },
  factorizedCoverage: { passed: true, reportSha256: digest },
  publicAcceptance: { passed: true, reportSha256: digest },
  privateAcceptance: { passed: true, reportSha256: digest },
  quantizationValidation: { passed: true, reportSha256: digest },
  targetHardwareBenchmark: { passed: true, reportSha256: digest },
  modelOwnerApproved: true,
}

test('all independent gates are required before constructing a product model', () => {
  expect(() => assertProductionEligibleModel(eligible)).not.toThrow()
  expect(
    productionEligibilityErrors({
      ...eligible,
      privateAcceptance: { passed: false, reportSha256: digest },
      modelOwnerApproved: false,
    }),
  ).toEqual(
    expect.arrayContaining([
      'privateAcceptance_not_passed',
      'model_owner_not_approved',
    ]),
  )
})

test('placeholder report digests cannot satisfy a boolean gate', () => {
  expect(
    productionEligibilityErrors({
      ...eligible,
      publicAcceptance: { passed: true, reportSha256: 'pending' },
    }),
  ).toContain('publicAcceptance_report_digest_invalid')
})
