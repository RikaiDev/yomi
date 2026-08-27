import type {
  AmbientEventGraph,
  AmbientGraphMessage,
  AmbientReplyEdge,
} from '../ambient/ambient-event-graph.js'

export interface EventContext {
  schemaVersion: 1
  chatId: string
  anchorMessageIds: string[]
  messages: AmbientGraphMessage[]
  edges: AmbientReplyEdge[]
  complete: boolean
  boundary: 'graph_boundary' | 'message_limit' | 'missing_anchor'
}

export interface EventContextOptions {
  minimumEdgeWeight?: number
  maximumMessages?: number
}

/**
 * Expand anchors over the event graph rather than taking a fixed number of
 * neighbouring messages. Edges are traversed in both directions because a
 * later delivery can revise the meaning of an earlier request.
 */
export function assembleEventContext(
  allMessages: AmbientGraphMessage[],
  graph: AmbientEventGraph,
  anchorMessageIds: string[],
  options: EventContextOptions = {},
): EventContext {
  const minimumWeight = options.minimumEdgeWeight ?? 0.3
  const maximumMessages = Math.max(1, options.maximumMessages ?? 64)
  const byId = new Map(
    allMessages.map((message) => [message.messageId, message]),
  )
  const validAnchors = [...new Set(anchorMessageIds)].filter((id) =>
    byId.has(id),
  )
  const chatId = validAnchors.map((id) => byId.get(id)!.chatId)[0] ?? ''
  if (validAnchors.length === 0) {
    return {
      schemaVersion: 1,
      chatId,
      anchorMessageIds: [],
      messages: [],
      edges: [],
      complete: false,
      boundary: 'missing_anchor',
    }
  }
  const adjacency = new Map<
    string,
    Array<{ id: string; edge: AmbientReplyEdge }>
  >()
  for (const edge of graph.edges.filter(
    (item) => item.weight >= minimumWeight,
  )) {
    const parent = byId.get(edge.parentId)
    const child = byId.get(edge.childId)
    if (
      !parent ||
      !child ||
      parent.chatId !== chatId ||
      child.chatId !== chatId
    )
      continue
    adjacency.set(edge.parentId, [
      ...(adjacency.get(edge.parentId) ?? []),
      { id: edge.childId, edge },
    ])
    adjacency.set(edge.childId, [
      ...(adjacency.get(edge.childId) ?? []),
      { id: edge.parentId, edge },
    ])
  }
  const distance = new Map(validAnchors.map((id) => [id, 0]))
  const queue = [...validAnchors]
  const includedEdges = new Map<string, AmbientReplyEdge>()
  let truncated = false
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      includedEdges.set(`${next.edge.parentId}:${next.edge.childId}`, next.edge)
      if (distance.has(next.id)) continue
      if (distance.size >= maximumMessages) {
        truncated = true
        continue
      }
      distance.set(next.id, (distance.get(current) ?? 0) + 1)
      queue.push(next.id)
    }
  }
  const messages = [...distance.keys()]
    .map((id) => byId.get(id)!)
    .sort((left, right) => left.sentAt - right.sentAt)
  const selected = new Set(messages.map((message) => message.messageId))
  const edges = [...includedEdges.values()].filter(
    (edge) => selected.has(edge.parentId) && selected.has(edge.childId),
  )
  return {
    schemaVersion: 1,
    chatId,
    anchorMessageIds: validAnchors,
    messages,
    edges,
    complete: !truncated,
    boundary: truncated ? 'message_limit' : 'graph_boundary',
  }
}
