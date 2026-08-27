import type { FactorizedGoldRecord } from './gold-contract.js'
import type { ConversationGoldSplit } from './gold-split.js'

export interface GoldCoverageIssue {
  partition: 'train' | 'validation' | 'test'
  head:
    | 'work'
    | 'dialogue'
    | 'ownership'
    | 'dependency'
    | 'lifecycle'
    | 'completion'
  label: string
  observed: number
  required: number
}

export const REQUIRED_GOLD_COVERAGE = {
  work: ['true', 'false'],
  dialogue: [
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
  ],
  ownership: ['unassigned', 'owned', 'delegated'],
  dependency: [
    'none',
    'waiting_person',
    'waiting_external_system',
    'waiting_decision',
  ],
  lifecycle: [
    'proposed',
    'committed',
    'in_progress',
    'blocked',
    'delivered',
    'accepted',
    'cancelled',
    'resolved',
  ],
  completion: ['delivered', 'accepted', 'cancelled'],
} as const

export function factorizedCoverageLabels(
  record: FactorizedGoldRecord,
): string[] {
  return [
    `work:${record.createsWork}`,
    ...record.dialogueActs.map((label) => `dialogue:${label}`),
    `ownership:${record.ownership.state}`,
    `dependency:${record.dependency}`,
    `lifecycle:${record.lifecycle}`,
    ...(record.completion.delivered ? ['completion:delivered'] : []),
    ...(record.completion.accepted ? ['completion:accepted'] : []),
    ...(record.completion.cancelled ? ['completion:cancelled'] : []),
  ]
}

function count(
  records: FactorizedGoldRecord[],
  head: keyof typeof REQUIRED_GOLD_COVERAGE,
  label: string,
): number {
  if (head === 'work')
    return records.filter((record) => String(record.createsWork) === label)
      .length
  if (head === 'dialogue')
    return records.filter((record) =>
      record.dialogueActs.includes(label as never),
    ).length
  if (head === 'ownership')
    return records.filter((record) => record.ownership.state === label).length
  if (head === 'dependency')
    return records.filter((record) => record.dependency === label).length
  if (head === 'lifecycle')
    return records.filter((record) => record.lifecycle === label).length
  return records.filter(
    (record) => record.completion[label as keyof typeof record.completion],
  ).length
}

/** Every factorized head must be observable; aggregate sample count is not a gate. */
export function auditGoldCoverage(
  split: ConversationGoldSplit,
): GoldCoverageIssue[] {
  const issues: GoldCoverageIssue[] = []
  for (const partition of ['train', 'validation', 'test'] as const) {
    const records = split[partition]
    const required = partition === 'train' ? 2 : 1
    for (const [head, labels] of Object.entries(
      REQUIRED_GOLD_COVERAGE,
    ) as Array<[keyof typeof REQUIRED_GOLD_COVERAGE, readonly string[]]>) {
      for (const label of labels) {
        const observed = count(records, head, label)
        if (observed < required)
          issues.push({ partition, head, label, observed, required })
      }
    }
  }
  return issues
}

export function assertGoldCoverage(split: ConversationGoldSplit): void {
  const issues = auditGoldCoverage(split)
  if (issues.length > 0) {
    const summary = issues
      .map(
        (issue) =>
          `${issue.partition}.${issue.head}.${issue.label}=${issue.observed}/${issue.required}`,
      )
      .join(', ')
    throw new Error(`Factorized gold coverage gate failed: ${summary}`)
  }
}

export function auditAcceptanceCoverage(
  records: FactorizedGoldRecord[],
): string[] {
  const observed = new Set(records.flatMap(factorizedCoverageLabels))
  return Object.entries(REQUIRED_GOLD_COVERAGE)
    .flatMap(([head, labels]) => labels.map((label) => `${head}:${label}`))
    .filter((label) => !observed.has(label))
}

export function assertAcceptanceCoverage(
  records: FactorizedGoldRecord[],
): void {
  const missing = auditAcceptanceCoverage(records)
  if (missing.length > 0)
    throw new Error(
      `Independent acceptance coverage gate failed: ${missing.join(', ')}`,
    )
}
