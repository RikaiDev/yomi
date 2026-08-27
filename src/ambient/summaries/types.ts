/**
 * Types for Hierarchical Summaries (10-minute Episodes & 6-hour Rollups).
 */

import type { DialogueAct } from '../../work-item/work-event.js'

export interface EpisodeSummary {
  episodeId: string
  chatId: string
  minSentAt: number
  maxSentAt: number
  messageIds: string[]
  participantNames: string[]
  dialogueActs: DialogueAct[]
  ownerHints: string[]
  responseState: 'waiting' | 'received' | 'observing'
  hasMentionsSelf: boolean
  hasQuestions: boolean
  hasMedia: boolean
  candidateCount: number
  digest: string
  engineVersion: number
}

export interface RollupSummary {
  rollupId: string
  windowStart: number
  windowEnd: number
  activeChatIds: string[]
  episodeIds: string[]
  totalEvents: number
  unresolvedFrontierCount: number
  topics: string[]
  digest: string
  engineVersion: number
}
