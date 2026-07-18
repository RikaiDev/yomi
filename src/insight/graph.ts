/**
 * Graph primitives for the relationship layer.
 *
 * "Who bridges your conversations?" is a classical graph question: build the
 * person co-occurrence graph (people are nodes, an edge joins two people who
 * share a chat) and find its articulation points. A node whose removal raises
 * the connected-component count is a cut vertex — a person the structure of your
 * contact network depends on, the bridge between otherwise-separate groups —
 * defined structurally rather than by counting.
 *
 * Undirected graph, adjacency list, iterative traversal (recursion would risk a
 * stack overflow on a long chain). Personal-scale, plain arrays.
 */

/** An undirected edge between two node indices. */
export interface Edge {
  a: number
  b: number
}

/** Build an adjacency list for `n` nodes from an edge list. */
function adjacency(n: number, edges: Edge[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const { a, b } of edges) {
    if (a === b) {
      continue
    }
    adj[a].push(b)
    adj[b].push(a)
  }
  return adj
}

/**
 * Articulation points (cut vertices) of the graph, by iterative Tarjan DFS.
 * A node is an articulation point if removing it increases the number of
 * connected components.
 *
 * @param n - Number of nodes.
 * @param edges - Undirected edges.
 * @returns Set of node indices that are articulation points.
 */
export function articulationPoints(n: number, edges: Edge[]): Set<number> {
  const adj = adjacency(n, edges)
  const disc = new Array<number>(n).fill(-1)
  const low = new Array<number>(n).fill(0)
  const isArt = new Set<number>()
  let timer = 0

  for (let s = 0; s < n; s++) {
    if (disc[s] !== -1) {
      continue
    }
    // Iterative DFS: frame carries the node, its parent, and an index into its
    // adjacency list (the resume point after visiting a child).
    const stack: { u: number; parent: number; i: number }[] = [
      { u: s, parent: -1, i: 0 },
    ]
    let rootChildren = 0
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const { u, parent } = frame
      if (frame.i === 0) {
        disc[u] = low[u] = timer++
      }
      if (frame.i < adj[u].length) {
        const v = adj[u][frame.i]
        frame.i++
        if (v === parent) {
          continue
        }
        if (disc[v] === -1) {
          if (u === s) {
            rootChildren++
          }
          stack.push({ u: v, parent: u, i: 0 })
        } else {
          low[u] = Math.min(low[u], disc[v])
        }
      } else {
        stack.pop()
        if (parent !== -1) {
          low[parent] = Math.min(low[parent], low[u])
          // A non-root parent is a cut vertex if a child cannot reach above it.
          if (parent !== s && low[u] >= disc[parent]) {
            isArt.add(parent)
          }
        }
      }
    }
    // The root is a cut vertex iff it has more than one DFS child.
    if (rootChildren > 1) {
      isArt.add(s)
    }
  }
  return isArt
}
