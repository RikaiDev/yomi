import { encode } from '@toon-format/toon'
import { computeInsights, type InsightPackage } from '../../insight/index.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { getDefaultEmbedder } from '../../search/default-embedder.js'
import { getExcludedChatIds } from '../../search/scope.js'
import { createPhiAccumulator, maskInto, phiNote } from '../phi-guard.js'

/**
 * get_insight — return structured attention context for the agent to judge.
 *
 * This is a first-stage tool: it does not decide what needs attention, it
 * assembles a compact context network that can be computed without reading
 * illocutionary force. Nodes are cross-conversation connectors and
 * conversations; `open` are directed edges (last speaker → addressee) for
 * threads whose latest message is not yours, each with reply-rhythm, overdue
 * ratio, a boilerplate-shape hint, an address hint, and a message-id pointer —
 * but no thread text. The agent dereferences the pointer (get_chat_messages)
 * only for the edges it chooses to judge, and decides open-request vs
 * closing-ack, a judgement the topic embedding cannot make. See ../../insight
 * for why the split is drawn exactly there.
 *
 * Denylist-excluded chats (../../search/scope) are removed from every section.
 *
 * @param service - Live LINE service (used for the owner's identity).
 * @param args - Optional focus chat and lookback window.
 * @returns MCP tool result: the JSON context package plus any PHI-masking note.
 */
export async function handleGetInsight(
  service: LineProtocolService,
  args: { chatId?: string; sinceHours?: number },
) {
  const pkg = computeInsights({
    focusChatId: args.chatId,
    sinceHours: args.sinceHours,
    selfMid: service.profile?.mid ?? null,
    embedder: getDefaultEmbedder(),
  })

  const excluded = getExcludedChatIds()
  const filtered: InsightPackage = {
    window: pkg.window,
    relationships: pkg.relationships.filter((r) => !excluded.has(r.chatId)),
    connectors: pkg.connectors,
    open: pkg.open.filter((o) => !excluded.has(o.chatId)),
  }

  if (filtered.window.messages === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'The semantic index is empty — run collect_messages (or any search) first, then retry.',
        },
      ],
    }
  }

  const acc = createPhiAccumulator()
  const masked = maskPackage(filtered, acc)
  // TOON encoding (github.com/toon-format/toon) over a lean projection: uniform
  // arrays become a one-line column header plus CSV rows (~half the tokens of
  // JSON), and the projection drops fields the agent can derive or does not need
  // — long MIDs/pointers, and low-signal one-off conversations.
  const guide =
    'A context network over your local LINE index, encoded as TOON — objects are `key: value`, uniform arrays are `name[count]{columns}:` then one comma-separated row per item. NOT verdicts. `connectors`: people across ≥2 of your chats (hubs; `isBridge` = removing them splits your contact graph). `relationships`: per-conversation engagement (`msgs` total, `yours` from you, `rhythmH` = your usual reply latency in hours) for conversations that matter. `open`: conversations whose latest message is not yours, most overdue vs that rhythm first (`overdueR`), with the last speaker (`from`) and a `preview`. Read each `preview` to judge — who it addresses (a group message may name someone else, who then owns it), open-request vs closing-acknowledgement, and nickname identities — then fetch the thread via get_chat_messages(chatId) only for the few worth it. `typicality` hints boilerplate shape but also buries polite requests, so never filter on it.'
  const content: {
    type: 'text'
    text: string
  }[] = [
    {
      type: 'text',
      text: `${guide}\n\n${encode(roundNumbers(project(masked)))}`,
    },
  ]
  const note = phiNote(acc)
  if (note) {
    content.push(note)
  }
  return { content }
}

/**
 * Project the package to a lean shape for encoding: drop long MIDs and message
 * pointers, drop values the agent can derive (reciprocity, absolute times), and
 * keep only conversations with signal — an open thread, or real back-and-forth
 * (≥5 messages). One-off two-line chats are noise in a "what needs attention"
 * scaffold.
 */
function project(pkg: InsightPackage) {
  const openChatIds = new Set(pkg.open.map((o) => o.chatId))
  return {
    window: pkg.window,
    connectors: pkg.connectors.map((c) => ({
      name: c.name,
      chats: c.chatCount,
      isBridge: c.isBridge,
    })),
    relationships: pkg.relationships
      .filter((r) => openChatIds.has(r.chatId) || r.totalMessages >= 5)
      .map((r) => ({
        chatId: r.chatId,
        name: r.chatName,
        isDM: r.isDM,
        msgs: r.totalMessages,
        yours: r.yourMessages,
        rhythmH: r.rhythmHours,
      })),
    open: pkg.open.map((o) => ({
      chatId: o.chatId,
      name: o.chatName,
      isDM: o.isDM,
      from: o.fromName,
      waitH: o.waitHours,
      overdueR: o.overdueRatio,
      typicality: o.typicality,
      preview: o.preview,
    })),
  }
}

/** Round every number to 2 decimals — full float precision is pure token cost. */
function roundNumbers<T>(value: T): T {
  if (typeof value === 'number') {
    return (Math.round(value * 100) / 100) as T
  }
  if (Array.isArray(value)) {
    return value.map(roundNumbers) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, roundNumbers(v)]),
    ) as T
  }
  return value
}

/** Mask PHI in the free-text previews the package carries. */
function maskPackage(
  pkg: InsightPackage,
  acc: ReturnType<typeof createPhiAccumulator>,
): InsightPackage {
  return {
    ...pkg,
    open: pkg.open.map((o) => ({
      ...o,
      preview: maskInto(acc, o.preview) ?? o.preview,
    })),
  }
}
