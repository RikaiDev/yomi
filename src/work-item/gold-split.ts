import type { FactorizedGoldRecord } from './gold-contract.js'

export interface ConversationGoldSplit {
  seed: string
  train: FactorizedGoldRecord[]
  validation: FactorizedGoldRecord[]
  test: FactorizedGoldRecord[]
  excludedAcceptanceIds: string[]
}

export interface ConversationGoldSplitOptions {
  seed: string
  acceptanceIds?: Iterable<string>
  validationFraction?: number
  testFraction?: number
}

function labelsFor(record: FactorizedGoldRecord): string[] {
  return [
    `work:${record.createsWork}`,
    ...record.dialogueActs.map((value) => `dialogue:${value}`),
    `ownership:${record.ownership.state}`,
    ...record.ownership.ownerKinds.map((value) => `owner_kind:${value}`),
    `dependency:${record.dependency}`,
    `lifecycle:${record.lifecycle}`,
    `completion:delivered:${record.completion.delivered}`,
    `completion:accepted:${record.completion.accepted}`,
    `completion:cancelled:${record.completion.cancelled}`,
  ]
}

function labelCounts(records: FactorizedGoldRecord[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const record of records) {
    for (const label of labelsFor(record))
      counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return counts
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function conversationId(record: FactorizedGoldRecord): string {
  return record.source?.chatId ?? `synthetic:${record.id}`
}

/**
 * Assign whole conversations, never windows, to partitions. Public acceptance
 * fixtures are removed before grouping so they cannot leak into model fitting.
 */
export function splitFactorizedGoldByConversation(
  records: FactorizedGoldRecord[],
  options: ConversationGoldSplitOptions,
): ConversationGoldSplit {
  const acceptance = new Set(options.acceptanceIds ?? [])
  const excludedAcceptanceIds: string[] = []
  const groups = new Map<string, FactorizedGoldRecord[]>()
  for (const record of records) {
    if (acceptance.has(record.id)) {
      excludedAcceptanceIds.push(record.id)
      continue
    }
    const key = conversationId(record)
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  const validationFraction = options.validationFraction ?? 0.15
  const testFraction = options.testFraction ?? 0.15
  if (
    validationFraction < 0 ||
    testFraction < 0 ||
    validationFraction + testFraction >= 1
  ) {
    throw new Error('Invalid split fractions')
  }
  const validationGroups =
    groups.size >= 3
      ? Math.max(1, Math.round(groups.size * validationFraction))
      : 0
  const testGroups =
    groups.size >= 3 ? Math.max(1, Math.round(groups.size * testFraction)) : 0
  const trainGroups = Math.max(0, groups.size - validationGroups - testGroups)
  const allRecords = [...groups.values()].flat()
  const totals = labelCounts(allRecords)
  const shares = {
    train: 1 - validationFraction - testFraction,
    validation: validationFraction,
    test: testFraction,
  }
  const capacities = {
    train: trainGroups,
    validation: validationGroups,
    test: testGroups,
  }
  const assigned = {
    train: [] as FactorizedGoldRecord[],
    validation: [] as FactorizedGoldRecord[],
    test: [] as FactorizedGoldRecord[],
  }
  const assignedGroups = { train: 0, validation: 0, test: 0 }
  const current = {
    train: new Map<string, number>(),
    validation: new Map<string, number>(),
    test: new Map<string, number>(),
  }
  const ordered = [...groups.entries()].sort(
    ([leftId, left], [rightId, right]) => {
      const rarity = (records: FactorizedGoldRecord[]) =>
        [...new Set(records.flatMap(labelsFor))].reduce(
          (sum, label) => sum + 1 / (totals.get(label) ?? 1),
          0,
        )
      return (
        rarity(right) - rarity(left) ||
        stableHash(`${options.seed}:${leftId}`) -
          stableHash(`${options.seed}:${rightId}`)
      )
    },
  )
  for (const [groupId, records] of ordered) {
    const counts = labelCounts(records)
    const candidates = (['train', 'validation', 'test'] as const).filter(
      (name) => assignedGroups[name] < capacities[name],
    )
    const scored = candidates
      .map((name) => {
        let labelNeed = 0
        for (const [label, count] of counts) {
          const target = (totals.get(label) ?? 0) * shares[name]
          labelNeed +=
            (count * Math.max(0, target - (current[name].get(label) ?? 0))) /
            Math.max(1, target)
        }
        const targetRecords = allRecords.length * shares[name]
        const sizeNeed =
          Math.max(0, targetRecords - assigned[name].length) /
          Math.max(1, targetRecords)
        return {
          name,
          score: labelNeed * 4 + sizeNeed,
          tie: stableHash(`${options.seed}:${groupId}:${name}`),
        }
      })
      .sort((left, right) => right.score - left.score || left.tie - right.tie)
    const destination = scored[0]?.name
    if (!destination)
      throw new Error('No partition has remaining conversation capacity')
    assigned[destination].push(...records)
    assignedGroups[destination] += 1
    for (const [label, count] of counts)
      current[destination].set(
        label,
        (current[destination].get(label) ?? 0) + count,
      )
  }
  return {
    seed: options.seed,
    train: assigned.train,
    validation: assigned.validation,
    test: assigned.test,
    excludedAcceptanceIds: excludedAcceptanceIds.sort(),
  }
}

export function assertNoConversationLeakage(
  split: ConversationGoldSplit,
): void {
  const seen = new Map<string, string>()
  for (const [partition, records] of Object.entries({
    train: split.train,
    validation: split.validation,
    test: split.test,
  })) {
    for (const record of records) {
      const key = conversationId(record)
      const previous = seen.get(key)
      if (previous && previous !== partition)
        throw new Error(
          `Conversation ${key} leaked from ${previous} into ${partition}`,
        )
      seen.set(key, partition)
    }
  }
}
