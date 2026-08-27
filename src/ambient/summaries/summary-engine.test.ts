import { expect, test } from 'bun:test'
import type { LineActivityEvent } from '../journal/types.js'
import { buildEpisodeSummaries, buildRollupSummary } from './summary-engine.js'

function makeEvent(
  id: string,
  chatId: string,
  sentAt: number,
  text: string,
  extra: Partial<LineActivityEvent> = {},
): LineActivityEvent {
  return {
    eventId: `evt-${id}`,
    chatId,
    messageId: id,
    opRevision: null,
    senderMid: 'u-sender',
    senderName: 'Sender',
    sentAt,
    contentType: 'text',
    text,
    metadata: {},
    isSelf: false,
    mentionsSelf: false,
    ocrEligible: false,
    ...extra,
  }
}

test('buildEpisodeSummaries splits by episode gap and infers dialogue acts', () => {
  const base = 1_000_000
  const e1 = makeEvent('1', 'chat-1', base, 'Hello, can you help?')
  const e2 = makeEvent('2', 'chat-1', base + 5000, 'Sure, what do you need?')
  // e3 is 50 minutes later -> new episode
  const e3 = makeEvent(
    '3',
    'chat-1',
    base + 50 * 60 * 1000,
    'Here is the report',
    {
      contentType: 'file',
    },
  )

  const episodes = buildEpisodeSummaries([e1, e2, e3])
  expect(episodes).toHaveLength(2)

  expect(episodes[0].dialogueActs).toContain('ask')
  expect(episodes[0].messageIds).toEqual(['1', '2'])

  expect(episodes[1].dialogueActs).toContain('deliver')
  expect(episodes[1].hasMedia).toBe(true)
  expect(episodes[1].messageIds).toEqual(['3'])
})

test('buildEpisodeSummaries tracks waiting vs received response state for self questions', () => {
  const base = 1_000_000
  // Outbound question with no response
  const e1 = makeEvent('1', 'chat-1', base, 'Did we finish the deploy?', {
    isSelf: true,
  })
  const ep1 = buildEpisodeSummaries([e1])
  expect(ep1[0].responseState).toBe('waiting')

  // Outbound question followed by another sender's reply
  const e2 = makeEvent(
    '2',
    'chat-1',
    base + 10_000,
    'Yes, deployed successfully!',
    {
      isSelf: false,
      senderName: 'Alice',
    },
  )
  const ep2 = buildEpisodeSummaries([e1, e2])
  expect(ep2[0].responseState).toBe('received')
})

test('buildRollupSummary aggregates episodes across 6-hour windows', () => {
  const base = 1_000_000
  const e1 = makeEvent('1', 'chat-1', base, 'Task 1', { mentionsSelf: true })
  const e2 = makeEvent('2', 'chat-2', base + 1000, 'Task 2')

  const episodes = buildEpisodeSummaries([e1, e2])
  const rollup = buildRollupSummary(
    base - 1000,
    base + 6 * 3600 * 1000,
    episodes,
  )

  expect(rollup.totalEvents).toBe(2)
  expect(rollup.activeChatIds).toContain('chat-1')
  expect(rollup.activeChatIds).toContain('chat-2')
  expect(rollup.unresolvedFrontierCount).toBe(1) // chat-1 has mentionsSelf
})
