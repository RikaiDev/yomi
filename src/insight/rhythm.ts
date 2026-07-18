/**
 * Reply rhythm of a conversation, at the level of turns rather than messages.
 *
 * "How long you normally take to reply to someone" is what makes a wait
 * *overdue* — a fixed hour threshold is wrong, because some threads run in
 * seconds and others in days. The naive estimate (median gap between every
 * incoming→your-message pair) is corrupted by bursts: inside a rapid exchange
 * the gaps are near-zero, dragging the median to zero.
 *
 * So messages are first collapsed into turns (maximal runs by the same side,
 * you vs. the other party), and a reply latency is measured only across a real
 * turn hand-off: from the end of the other side's turn to the start of yours.
 * The median of those latencies is the relationship's rhythm.
 */

/** Minimal shape needed to compute rhythm: who sent it and when. */
export interface TimedMessage {
  fromMid: string | null
  createdTime: number
}

/**
 * Median turn hand-off latency (in hours) from the other party to you — the
 * relationship's reply rhythm. Null when the conversation contains no such
 * hand-off (e.g. you never replied, or only you have spoken).
 *
 * @param messages - The conversation's messages, any order.
 * @param selfMid - The account owner's MID.
 * @returns Median reply latency in hours, or null if not estimable.
 */
export function replyRhythmHours(
  messages: TimedMessage[],
  selfMid: string | null,
): number | null {
  const sorted = [...messages].sort((a, b) => a.createdTime - b.createdTime)
  // Collapse into turns keyed by self vs. other.
  const turns: { self: boolean; first: number; last: number }[] = []
  for (const m of sorted) {
    const self = m.fromMid === selfMid
    const top = turns[turns.length - 1]
    if (!top || top.self !== self) {
      turns.push({ self, first: m.createdTime, last: m.createdTime })
    } else {
      top.last = m.createdTime
    }
  }

  const HOUR = 3_600_000
  const latencies: number[] = []
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].self && !turns[i - 1].self) {
      latencies.push((turns[i].first - turns[i - 1].last) / HOUR)
    }
  }
  if (latencies.length === 0) {
    return null
  }
  latencies.sort((a, b) => a - b)
  return latencies[Math.floor(latencies.length / 2)]
}
