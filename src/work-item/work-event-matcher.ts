import type { WorkEventInference, WorkEventRevision } from './work-event.js'

export interface WorkEventMatch {
  incomingIndex: number
  previousIndex: number
  score: number
}

function ngrams(value: string, size = 2): Set<string> {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
  if (!normalized) return new Set()
  if (normalized.length <= size) return new Set([normalized])
  return new Set(
    Array.from({ length: normalized.length - size + 1 }, (_, index) =>
      normalized.slice(index, index + size),
    ),
  )
}

function jaccard<T>(left: Set<T>, right: Set<T>): number {
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const value of left) if (right.has(value)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

function actionText(event: WorkEventInference | WorkEventRevision): string {
  if (!event.action) return ''
  return [
    event.action.predicate,
    event.action.object,
    event.action.expectedOutcome,
  ]
    .filter(Boolean)
    .join(' ')
}

export function workEventSimilarity(
  previous: WorkEventRevision,
  incoming: WorkEventInference,
): number {
  if (
    previous.chatId !== incoming.chatId ||
    previous.createsWork !== incoming.createsWork
  )
    return 0
  const evidence = jaccard(
    new Set(previous.evidence.map((item) => item.messageId)),
    new Set(incoming.evidence.map((item) => item.messageId)),
  )
  const action = jaccard(
    ngrams(actionText(previous)),
    ngrams(actionText(incoming)),
  )
  const previousOwners = new Set(
    previous.ownership.owners.map((owner) => owner.kind),
  )
  const incomingOwners = new Set(
    incoming.ownership.owners.map((owner) => owner.kind),
  )
  const ownership = jaccard(previousOwners, incomingOwners)
  return Number((evidence * 0.45 + action * 0.45 + ownership * 0.1).toFixed(4))
}

/** Maximum-weight one-to-one matching keeps sibling events distinct across revisions. */
export function matchWorkEventRevisions(
  previous: WorkEventRevision[],
  incoming: WorkEventInference[],
  minimumScore = 0.55,
): WorkEventMatch[] {
  const candidates = incoming
    .flatMap((next, incomingIndex) =>
      previous.map((prior, previousIndex) => ({
        incomingIndex,
        previousIndex,
        score: workEventSimilarity(prior, next),
      })),
    )
    .filter((match) => match.score >= minimumScore)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.incomingIndex - right.incomingIndex ||
        left.previousIndex - right.previousIndex,
    )
  if (previous.length <= 16 && incoming.length <= 16) {
    const byIncoming = new Map<number, WorkEventMatch[]>()
    for (const candidate of candidates) {
      byIncoming.set(candidate.incomingIndex, [
        ...(byIncoming.get(candidate.incomingIndex) ?? []),
        candidate,
      ])
    }
    const memo = new Map<string, { score: number; matches: WorkEventMatch[] }>()
    const solve = (
      incomingIndex: number,
      claimedMask: number,
    ): { score: number; matches: WorkEventMatch[] } => {
      if (incomingIndex >= incoming.length) return { score: 0, matches: [] }
      const key = `${incomingIndex}:${claimedMask}`
      const cached = memo.get(key)
      if (cached) return cached
      let best = solve(incomingIndex + 1, claimedMask)
      for (const candidate of byIncoming.get(incomingIndex) ?? []) {
        const bit = 1 << candidate.previousIndex
        if ((claimedMask & bit) !== 0) continue
        const rest = solve(incomingIndex + 1, claimedMask | bit)
        const option = {
          score: candidate.score + rest.score,
          matches: [candidate, ...rest.matches],
        }
        if (
          option.score > best.score ||
          (option.score === best.score &&
            option.matches.length > best.matches.length)
        )
          best = option
      }
      memo.set(key, best)
      return best
    }
    return solve(0, 0).matches.sort(
      (left, right) => left.incomingIndex - right.incomingIndex,
    )
  }
  const claimedIncoming = new Set<number>()
  const claimedPrevious = new Set<number>()
  const matches: WorkEventMatch[] = []
  for (const candidate of candidates) {
    if (
      claimedIncoming.has(candidate.incomingIndex) ||
      claimedPrevious.has(candidate.previousIndex)
    )
      continue
    claimedIncoming.add(candidate.incomingIndex)
    claimedPrevious.add(candidate.previousIndex)
    matches.push(candidate)
  }
  return matches.sort((left, right) => left.incomingIndex - right.incomingIndex)
}
