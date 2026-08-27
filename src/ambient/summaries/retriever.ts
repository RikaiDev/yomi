import type { LineActivityJournalStore } from '../journal/journal-store.js'
import type { LineActivityEvent } from '../journal/types.js'
import { buildEpisodeSummaries, buildRollupSummary } from './summary-engine.js'
import type { EpisodeSummary, RollupSummary } from './types.js'

export interface RetrievalQuery {
  since?: number
  until?: number
  chatId?: string
  onlyActionable?: boolean
}

export interface RetrievalCandidate {
  episode: EpisodeSummary
  events: LineActivityEvent[]
}

export class CoarseToFineRetriever {
  constructor(private readonly journalStore: LineActivityJournalStore) {}

  /**
   * Coarse step: Scan 6-hour Rollup windows and return summary of activity.
   */
  async retrieveRollups(
    since: number,
    until: number,
    windowSpanMs = 6 * 60 * 60 * 1000,
  ): Promise<RollupSummary[]> {
    const rawEvents = await this.journalStore.query({ since, until })
    const episodes = buildEpisodeSummaries(rawEvents)

    const rollups: RollupSummary[] = []
    let currentStart = since
    while (currentStart < until) {
      const currentEnd = Math.min(until, currentStart + windowSpanMs)
      rollups.push(buildRollupSummary(currentStart, currentEnd, episodes))
      currentStart += windowSpanMs
    }

    return rollups
  }

  /**
   * Medium step: Find candidate episodes matching query criteria.
   */
  async retrieveEpisodes(
    query: RetrievalQuery = {},
  ): Promise<EpisodeSummary[]> {
    const rawEvents = await this.journalStore.query({
      since: query.since,
      until: query.until,
      chatId: query.chatId,
    })
    const episodes = buildEpisodeSummaries(rawEvents)

    if (query.onlyActionable) {
      return episodes.filter(
        (ep) =>
          ep.hasMentionsSelf ||
          ep.responseState === 'waiting' ||
          ep.candidateCount > 0,
      )
    }

    return episodes
  }

  /**
   * Fine step: Given an EpisodeSummary, load exact raw LineActivityEvent records
   * from the encrypted journal.
   */
  async retrieveConnectedEvidence(
    episode: EpisodeSummary,
  ): Promise<RetrievalCandidate> {
    const events = await this.journalStore.query({
      chatId: episode.chatId,
      since: episode.minSentAt,
      until: episode.maxSentAt,
    })

    const filtered = events.filter((e) =>
      episode.messageIds.includes(e.messageId),
    )
    return {
      episode,
      events: filtered,
    }
  }
}
