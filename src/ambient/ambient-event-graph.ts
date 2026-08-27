export interface AmbientGraphMessage {
  messageId: string
  chatId: string
  senderName: string | null
  sentAt: number
  text: string | null
  mediaType?: string | null
  isSelf?: boolean
  mentionsSelf?: boolean
  mentionNames?: string[]
}

export interface AmbientReplyEdge {
  parentId: string
  childId: string
  weight: number
  entropy: number
  reasons: string[]
}

export interface AmbientEventGraph {
  edges: AmbientReplyEdge[]
  descendants(messageIds: Iterable<string>): Set<string>
}

function characterBigrams(value: string | null): Set<string> {
  const normalized = (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
  const values = new Set<string>()
  for (let index = 0; index + 1 < normalized.length; index++) {
    values.add(normalized.slice(index, index + 2))
  }
  return values
}

function overlap(left: string | null, right: string | null): number {
  const a = characterBigrams(left)
  const b = characterBigrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared += 1
  return shared / (a.size + b.size - shared)
}

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * fraction),
  )
  return sorted[index]
}

/** Derive a session scale from each conversation instead of a global fixed window. */
function conversationSessionScale(messages: AmbientGraphMessage[]): number {
  const gaps = messages
    .slice(1)
    .map((message, index) => message.sentAt - messages[index].sentAt)
    .filter((gap) => gap > 0)
  const observed = quantile(gaps, 0.75) * 2.5
  return Math.min(90 * 60_000, Math.max(15 * 60_000, observed || 15 * 60_000))
}

function temporalAffinity(deltaMs: number, sessionScaleMs: number): number {
  return Math.exp(-Math.max(0, deltaMs) / Math.max(1, sessionScaleMs))
}

function normalizedEntropy(weights: number[]): number {
  if (weights.length <= 1) return 0
  const exponentials = weights.map((weight) => Math.exp(weight * 4))
  const total = exponentials.reduce((sum, value) => sum + value, 0)
  const probabilities = exponentials.map((value) => value / total)
  const entropy = -probabilities.reduce(
    (sum, value) => sum + (value > 0 ? value * Math.log(value) : 0),
    0,
  )
  return entropy / Math.log(probabilities.length)
}

function scoreParent(
  parent: AmbientGraphMessage,
  child: AmbientGraphMessage,
  sessionScaleMs: number,
  consecutive: boolean,
): { weight: number; reasons: string[] } {
  const reasons: string[] = []
  const direct = child.chatId.startsWith('u')
  const alternating = parent.isSelf !== child.isSelf
  const parentQuestion = /[?？]/.test(parent.text ?? '')
  const delta = child.sentAt - parent.sentAt
  const withinSession = delta >= 0 && delta <= sessionScaleMs
  let weight = 0

  if (withinSession && consecutive && alternating) {
    weight += 0.18 + 0.2 * temporalAffinity(delta, sessionScaleMs)
    weight += direct ? 0.24 : 0.16
    reasons.push(direct ? 'dyadic_turn' : 'local_turn_exchange')
  } else if (withinSession && consecutive && direct) {
    weight += 0.2 + 0.16 * temporalAffinity(delta, sessionScaleMs)
    reasons.push('dyadic_continuation')
  } else if (
    withinSession &&
    consecutive &&
    parent.isSelf === true &&
    child.isSelf === true
  ) {
    weight += 0.2 + 0.16 * temporalAffinity(delta, sessionScaleMs)
    reasons.push('self_continuation')
  }
  if (parentQuestion && alternating) {
    weight += direct ? 0.52 : 0.34
    reasons.push('adjacency_pair')
  }
  if (parent.senderName && child.mentionNames?.includes(parent.senderName)) {
    weight += 0.52
    reasons.push('mentions_parent')
  }
  if (child.senderName && parent.mentionNames?.includes(child.senderName)) {
    weight += 0.72
    reasons.push('addressed_responder')
  }
  if (parent.mentionsSelf && child.isSelf) {
    weight += 0.7
    reasons.push('self_answers_mention')
  }
  const semanticOverlap = withinSession ? overlap(parent.text, child.text) : 0
  if (
    parent.senderName &&
    parent.senderName === child.senderName &&
    (semanticOverlap >= 0.08 || parent.mediaType || child.mediaType)
  ) {
    weight += 0.18
    reasons.push('same_speaker_continuation')
  }
  if (semanticOverlap > 0) {
    weight += Math.min(0.28, semanticOverlap * 0.4)
    reasons.push('lexical_overlap')
  }
  return { weight, reasons }
}

export function inferAmbientEventGraph(
  messages: AmbientGraphMessage[],
): AmbientEventGraph {
  const edges: AmbientReplyEdge[] = []
  const byChat = new Map<string, AmbientGraphMessage[]>()
  for (const message of messages) {
    const rows = byChat.get(message.chatId) ?? []
    rows.push(message)
    byChat.set(message.chatId, rows)
  }
  for (const rows of byChat.values()) {
    const sorted = [...rows].sort((a, b) => a.sentAt - b.sentAt)
    const sessionScaleMs = conversationSessionScale(sorted)
    for (let index = 1; index < sorted.length; index++) {
      const child = sorted[index]
      const candidates = sorted
        .slice(Math.max(0, index - 100), index)
        .map((parent, candidateIndex, candidates) => ({
          parent,
          ...scoreParent(
            parent,
            child,
            sessionScaleMs,
            candidateIndex === candidates.length - 1,
          ),
        }))
        .filter((candidate) => candidate.weight >= 0.3)
        .sort((a, b) => b.weight - a.weight)
      if (candidates.length === 0) continue
      const entropy = normalizedEntropy(
        candidates.slice(0, 8).map((candidate) => candidate.weight),
      )
      const best = candidates[0]
      const selected = [
        best,
        ...(entropy >= 0.72
          ? candidates
              .slice(1)
              .filter((candidate) => best.weight - candidate.weight <= 0.08)
              .slice(0, 1)
          : []),
      ]
      for (const candidate of selected) {
        edges.push({
          parentId: candidate.parent.messageId,
          childId: child.messageId,
          weight: Number(candidate.weight.toFixed(4)),
          entropy: Number(entropy.toFixed(4)),
          reasons: candidate.reasons,
        })
      }
    }
  }

  const children = new Map<string, string[]>()
  for (const edge of edges) {
    const values = children.get(edge.parentId) ?? []
    values.push(edge.childId)
    children.set(edge.parentId, values)
  }
  return {
    edges,
    descendants(messageIds) {
      const found = new Set<string>()
      const queue = [...messageIds]
      while (queue.length > 0) {
        const current = queue.shift()!
        for (const child of children.get(current) ?? []) {
          if (found.has(child)) continue
          found.add(child)
          queue.push(child)
        }
      }
      return found
    },
  }
}
