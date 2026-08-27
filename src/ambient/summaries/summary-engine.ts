import { createHash } from 'node:crypto'
import type { DialogueAct } from '../../work-item/work-event.js'
import type { LineActivityEvent } from '../journal/types.js'
import type { EpisodeSummary, RollupSummary } from './types.js'

export const CURRENT_SUMMARY_ENGINE_VERSION = 1
const EPISODE_GAP_MS = 45 * 60 * 1000 // 45 minutes
const ROLLUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

function computeDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function inferDialogueActs(events: LineActivityEvent[]): DialogueAct[] {
  const acts = new Set<DialogueAct>()
  for (const event of events) {
    const text = event.text ?? ''
    const isQuestion = /[?？]/.test(text)
    if (isQuestion) {
      acts.add('ask')
    }
    if (['image', 'video', 'file'].includes(event.contentType)) {
      acts.add('deliver')
    }
    if (event.mentionsSelf || (event.metadata.mentionMids?.length ?? 0) > 0) {
      acts.add('directive')
    }
    if (event.contentType === 'sticker') {
      acts.add('acknowledge')
    }
    if (text.length > 0 && !isQuestion) {
      acts.add('inform')
    }
  }
  return [...acts]
}

export function buildEpisodeSummaries(
  events: LineActivityEvent[],
  engineVersion = CURRENT_SUMMARY_ENGINE_VERSION,
): EpisodeSummary[] {
  if (events.length === 0) return []

  const byChat = new Map<string, LineActivityEvent[]>()
  for (const event of events) {
    const list = byChat.get(event.chatId) ?? []
    list.push(event)
    byChat.set(event.chatId, list)
  }

  const summaries: EpisodeSummary[] = []

  for (const [chatId, chatEvents] of byChat) {
    const sorted = [...chatEvents].sort((a, b) => a.sentAt - b.sentAt)
    let currentEpisode: LineActivityEvent[] = []

    const flush = () => {
      if (currentEpisode.length === 0) return
      const minSentAt = currentEpisode[0].sentAt
      const maxSentAt = currentEpisode[currentEpisode.length - 1].sentAt
      const messageIds = currentEpisode.map((e) => e.messageId)
      const participantNames = [
        ...new Set(
          currentEpisode
            .map((e) => e.senderName)
            .filter((n): n is string => Boolean(n)),
        ),
      ]
      const ownerHints = [
        ...new Set(
          currentEpisode.flatMap((e) => e.metadata.mentionNames ?? []),
        ),
      ]
      const hasMentionsSelf = currentEpisode.some((e) => e.mentionsSelf)
      const hasQuestions = currentEpisode.some((e) =>
        /[?？]/.test(e.text ?? ''),
      )
      const hasMedia = currentEpisode.some((e) =>
        ['image', 'video', 'file', 'audio'].includes(e.contentType),
      )
      const dialogueActs = inferDialogueActs(currentEpisode)

      const hasSelfQuestion = currentEpisode.some(
        (e) => e.isSelf && /[?？]/.test(e.text ?? ''),
      )
      const selfQuestionIdx = currentEpisode.findIndex(
        (e) => e.isSelf && /[?？]/.test(e.text ?? ''),
      )
      const hasReplyAfterSelfQuestion =
        selfQuestionIdx >= 0 &&
        currentEpisode.slice(selfQuestionIdx + 1).some((e) => !e.isSelf)

      const responseState: EpisodeSummary['responseState'] =
        hasReplyAfterSelfQuestion
          ? 'received'
          : hasSelfQuestion
            ? 'waiting'
            : 'observing'

      const digest = computeDigest(
        `${chatId}:${minSentAt}:${messageIds.join(',')}`,
      )
      const episodeId = `ep-${chatId.slice(0, 8)}-${minSentAt}`

      summaries.push({
        episodeId,
        chatId,
        minSentAt,
        maxSentAt,
        messageIds,
        participantNames,
        dialogueActs,
        ownerHints,
        responseState,
        hasMentionsSelf,
        hasQuestions,
        hasMedia,
        candidateCount: hasMentionsSelf || hasSelfQuestion ? 1 : 0,
        digest,
        engineVersion,
      })

      currentEpisode = []
    }

    for (const event of sorted) {
      if (
        currentEpisode.length > 0 &&
        event.sentAt - currentEpisode[currentEpisode.length - 1].sentAt >
          EPISODE_GAP_MS
      ) {
        flush()
      }
      currentEpisode.push(event)
    }
    flush()
  }

  return summaries.sort((a, b) => a.minSentAt - b.minSentAt)
}

export function buildRollupSummary(
  windowStart: number,
  windowEnd: number,
  episodes: EpisodeSummary[],
  engineVersion = CURRENT_SUMMARY_ENGINE_VERSION,
): RollupSummary {
  const matching = episodes.filter(
    (ep) => ep.maxSentAt >= windowStart && ep.minSentAt <= windowEnd,
  )

  const activeChatIds = [...new Set(matching.map((ep) => ep.chatId))]
  const episodeIds = matching.map((ep) => ep.episodeId)
  const totalEvents = matching.reduce(
    (sum, ep) => sum + ep.messageIds.length,
    0,
  )
  const unresolvedFrontierCount = matching.filter(
    (ep) => ep.responseState === 'waiting' || ep.hasMentionsSelf,
  ).length

  const topics = matching
    .filter((ep) => ep.dialogueActs.length > 0)
    .map((ep) => `${ep.chatId}:${ep.dialogueActs.join('+')}`)
    .slice(0, 10)

  const rollupId = `rollup-${Math.floor(windowStart / ROLLUP_INTERVAL_MS)}`
  const digest = computeDigest(
    `${rollupId}:${episodeIds.join(',')}:${totalEvents}`,
  )

  return {
    rollupId,
    windowStart,
    windowEnd,
    activeChatIds,
    episodeIds,
    totalEvents,
    unresolvedFrontierCount,
    topics,
    digest,
    engineVersion,
  }
}
