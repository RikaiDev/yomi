import type { WorkItemEvidence, WorkItemSourceRef } from './types.js'

export interface WorkItemAdapterResult {
  source: WorkItemSourceRef
  sources: WorkItemSourceRef[]
  evidence: WorkItemEvidence[]
}

/** Converts a source product's message shape into the stable work-item domain. */
export interface WorkItemAdapter<TInput = unknown> {
  readonly id: string
  readonly platform: string
  canNormalize(input: unknown): input is TInput
  normalize(
    input: TInput,
  ): WorkItemAdapterResult | Promise<WorkItemAdapterResult>
}
