import { expect, test } from 'bun:test'
import {
  buildAmbientObservations,
  normalizeSquareObservationRows,
} from './ambient-observer.js'

test('normalizes an OpenChat mention of the signed-in member as self-relevant', () => {
  const now = Date.now()
  const rows = normalizeSquareObservationRows(
    { id: 'm-open-chat', memberMid: 'p-me' },
    [
      {
        id: 'square-message',
        fromMid: 'p-owner',
        fromName: 'Owner',
        createdTime: now - 1000,
        text: '@Me can you review this?',
        contentType: 0,
        contentMetadata: {
          MENTION: JSON.stringify({ MENTIONEES: [{ M: 'p-me' }] }),
        },
        isSelf: false,
      },
    ],
  )
  const report = buildAmbientObservations(
    rows,
    new Map([['m-open-chat', 'OpenChat']]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(1)
  expect(report.candidates[0].relevance).toBe('self')
  expect(report.candidates[0].reasons).toContain('mentions_self')
})

test('separates interleaved multilingual hypotheses by semantic vectors', () => {
  const now = new Date().setHours(12, 30, 0, 0)
  const base = new Date().setHours(9, 0, 0, 0)
  const report = buildAmbientObservations(
    [
      {
        messageId: '1',
        chatId: 'c1',
        senderName: 'A',
        sentAt: base,
        text: '驗證失敗',
        mediaType: 'image',
        ocrEligible: true,
        vector: [1, 0, 0],
      },
      {
        messageId: '2',
        chatId: 'c1',
        senderName: 'A',
        sentAt: base + 60_000,
        text: 'Verification keeps failing',
        mediaType: 'image',
        ocrEligible: true,
        vector: [0.98, 0.02, 0],
      },
      {
        messageId: '3',
        chatId: 'c1',
        senderName: 'A',
        sentAt: base + 120_000,
        text: '台風の場合は日程を変更しますか？',
        mediaType: null,
        ocrEligible: true,
        mentionNames: ['Me'],
        mentionsSelf: true,
        vector: [0, 1, 0],
      },
      {
        messageId: '4',
        chatId: 'c1',
        senderName: 'Me',
        sentAt: base + 180_000,
        text: 'Why was the roster not sent through the API?',
        mediaType: null,
        ocrEligible: true,
        isSelf: true,
        vector: [0, 0, 1],
      },
    ],
    new Map([['c1', '智慧醫療']]),
    now,
    base - 1000,
  )
  expect(report.candidates).toHaveLength(3)
  expect(report.candidates.every((item) => item.topic === 'unclassified')).toBe(
    true,
  )
  expect(
    report.candidates.flatMap((item) =>
      item.evidence.map((evidence) => evidence.messageId),
    ),
  ).toEqual(expect.arrayContaining(['1', '2', '3', '4']))
})

test('does not turn a request directed at somebody else into the users work', () => {
  const now = new Date().setHours(12, 30, 0, 0)
  const report = buildAmbientObservations(
    [
      {
        messageId: '1',
        chatId: 'c1',
        senderName: 'A',
        sentAt: now - 1000,
        text: '請問 API 有串接好嗎？',
        mediaType: null,
        ocrEligible: true,
        mentionNames: ['宜君'],
      },
    ],
    new Map([['c1', '旗津']]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(0)
})

test('uses a checkpoint window instead of the current calendar day', () => {
  const now = new Date().setHours(1, 0, 0, 0)
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000
  const report = buildAmbientObservations(
    [
      {
        messageId: '1',
        chatId: 'c1',
        senderName: 'Me',
        sentAt: threeDaysAgo + 1000,
        text: 'Why did this fail?',
        mediaType: null,
        ocrEligible: true,
        isSelf: true,
      },
    ],
    new Map([['c1', '離線期間對話']]),
    now,
    threeDaysAgo,
  )
  expect(report.windowStart).toBe(threeDaysAgo)
  expect(report.candidates).toHaveLength(1)
  expect(report.candidates[0].topic).toBe('unclassified')
})

test('does not promote official-account image bursts into OCR candidates', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: '1',
        chatId: 'u-official',
        senderName: 'Official',
        sentAt: now - 2000,
        text: null,
        mediaType: 'image',
        ocrEligible: false,
      },
      {
        messageId: '2',
        chatId: 'u-official',
        senderName: 'Official',
        sentAt: now - 1000,
        text: null,
        mediaType: 'image',
        ocrEligible: false,
      },
    ],
    new Map([['u-official', '官方帳號']]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(0)
})

test('does not treat ordinary inability or two-image chatter as an incident', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: '1',
        chatId: 'c1',
        senderName: 'A',
        sentAt: now - 2000,
        text: '本週無法參加活動',
        mediaType: 'image',
        ocrEligible: true,
      },
      {
        messageId: '2',
        chatId: 'c1',
        senderName: 'A',
        sentAt: now - 1000,
        text: null,
        mediaType: 'image',
        ocrEligible: true,
      },
    ],
    new Map([['c1', '活動群組']]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(0)
})

test('does not promote a personal image burst into work', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [1, 2, 3, 4].map((value) => ({
      messageId: String(value),
      chatId: 'u-family',
      senderName: 'Family',
      sentAt: now - (5 - value) * 1000,
      text: value === 4 ? 'These are for auntie' : null,
      mediaType: value === 4 ? null : 'image',
      ocrEligible: true,
    })),
    new Map([['u-family', 'Family']]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(0)
})

test('does not promote @All announcements or another persons order into work', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'announcement',
        chatId: 'c-community',
        senderName: 'Organizer',
        sentAt: now - 2000,
        text: '@All Thank you for supporting the scholarship fundraiser',
        mediaType: null,
        ocrEligible: true,
        mentionNames: ['All'],
      },
      {
        messageId: 'order',
        chatId: 'c-orders',
        senderName: 'Store',
        sentAt: now - 1000,
        text: '@Buyer change pickup to 17:30, four drinks',
        mediaType: null,
        ocrEligible: true,
        mentionNames: ['Buyer'],
      },
    ],
    new Map([
      ['c-community', 'Community'],
      ['c-orders', 'Orders'],
    ]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(0)
})

test('does not treat a one-line social mention as a work candidate', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'welcome',
        chatId: 'c-social',
        senderName: 'A',
        sentAt: now - 1000,
        text: '@Friend welcome to the group',
        mediaType: null,
        ocrEligible: true,
        mentionNames: ['Friend'],
      },
    ],
    new Map([['c-social', 'Social group']]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(0)
})

test('captures a self-authored question as waiting-for-reply evidence', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'outbound',
        chatId: 'u-peer',
        senderName: 'Me',
        sentAt: now - 1000,
        text: 'Could we reschedule for next Wednesday?',
        mediaType: null,
        ocrEligible: true,
        isSelf: true,
      },
    ],
    new Map([['u-peer', 'Peer']]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(1)
  expect(report.candidates[0].reasons).toContain('outbound_question')
  expect(report.candidates[0].relevance).toBe('self')
  expect(report.candidates[0].responseState).toBe('waiting')
})

test('treats an inbound one-to-one question as implicitly directed to the user', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'direct-question',
        chatId: 'u-peer',
        senderName: 'Peer',
        sentAt: now - 1000,
        text: 'Has your desk location been confirmed?',
        mediaType: null,
        ocrEligible: true,
        isSelf: false,
      },
    ],
    new Map([['u-peer', 'Peer']]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(1)
  expect(report.candidates[0].relevance).toBe('self')
  expect(report.candidates[0].responseState).toBe('waiting')
  expect(report.candidates[0].reasons).toContain('direct_message_question')
})

test('does not treat an unassigned group question as implicitly directed to the user', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'group-question',
        chatId: 'c-group',
        senderName: 'Member',
        sentAt: now - 1000,
        text: 'Has the location been confirmed?',
        mediaType: null,
        ocrEligible: true,
        isSelf: false,
      },
    ],
    new Map([['c-group', 'Group']]),
    now,
    now - 60_000,
  )
  expect(report.candidates).toHaveLength(0)
})

test('closes a direct-message question when the user answers after the old cluster window', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'question',
        chatId: 'u-peer',
        senderName: 'Peer',
        sentAt: now - 30 * 60 * 1000,
        text: 'Has your location been confirmed?',
        mediaType: null,
        ocrEligible: true,
        isSelf: false,
      },
      {
        messageId: 'answer',
        chatId: 'u-peer',
        senderName: 'Me',
        sentAt: now - 8 * 60 * 1000,
        text: 'Not yet; please ask the coordinator.',
        mediaType: null,
        ocrEligible: true,
        isSelf: true,
      },
    ],
    new Map([['u-peer', 'Peer']]),
    now,
    now - 60 * 60 * 1000,
  )
  expect(report.candidates).toHaveLength(1)
  expect(report.candidates[0].responseState).toBe('received')
  expect(report.candidates[0].reasons).toContain('graph_response_received')
  expect(report.candidates[0].evidence.map((item) => item.messageId)).toEqual([
    'question',
    'answer',
  ])
})

test('ranks an explicit mention of the signed-in user as self-relevant', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'mention-self',
        chatId: 'c-work',
        senderName: 'A',
        sentAt: now - 1000,
        text: '@Me can you check this?',
        mediaType: null,
        ocrEligible: true,
        mentionNames: ['Me'],
        mentionsSelf: true,
      },
    ],
    new Map([['c-work', 'Work']]),
    now,
    now - 60_000,
  )
  expect(report.candidates[0].relevance).toBe('self')
  expect(report.candidates[0].reasons).toContain('mentions_self')
})

test('attaches a sticker response to a recent self-authored question', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'question',
        chatId: 'u-peer',
        senderName: 'Me',
        sentAt: now - 18 * 60 * 1000,
        text: 'Can we move this to Wednesday or Thursday?',
        mediaType: null,
        ocrEligible: true,
        isSelf: true,
      },
      {
        messageId: 'sticker',
        chatId: 'u-peer',
        senderName: 'Peer',
        sentAt: now - 60 * 1000,
        text: null,
        mediaType: 'sticker',
        ocrEligible: true,
        isSelf: false,
        sourceUrl: 'https://example.invalid/sticker.png',
      },
    ],
    new Map([['u-peer', 'Peer']]),
    now,
    now - 60 * 60 * 1000,
  )
  expect(report.candidates).toHaveLength(1)
  expect(report.candidates[0].evidence.map((item) => item.messageId)).toEqual([
    'question',
    'sticker',
  ])
  expect(report.candidates[0].responseState).toBe('received')
})

test('marks a directed question with a later sender response as followed up', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'ask',
        chatId: 'c-team',
        senderName: 'Requester',
        sentAt: now - 2000,
        text: '@Me is this ready?',
        mediaType: null,
        ocrEligible: true,
        mentionNames: ['Me'],
        mentionsSelf: true,
      },
      {
        messageId: 'answer',
        chatId: 'c-team',
        senderName: 'Me',
        sentAt: now - 1000,
        text: 'I checked it.',
        mediaType: null,
        ocrEligible: true,
        isSelf: true,
      },
    ],
    new Map([['c-team', 'Team']]),
    now,
    now - 60_000,
  )
  expect(report.candidates[0].responseState).toBe('received')
  expect(report.candidates[0].reasons).toContain('directed_response')
})

test('links a direct mention response across episode boundaries', () => {
  const now = Date.now()
  const report = buildAmbientObservations(
    [
      {
        messageId: 'request',
        chatId: 'c-team',
        senderName: 'Requester',
        sentAt: now - 4 * 60 * 60 * 1000,
        text: '@Me is the integration ready?',
        mediaType: null,
        ocrEligible: true,
        mentionNames: ['Me'],
        mentionsSelf: true,
      },
      {
        messageId: 'response',
        chatId: 'c-team',
        senderName: 'Me',
        sentAt: now - 60 * 60 * 1000,
        text: 'The code is ready; end-to-end testing is blocked.',
        mediaType: null,
        ocrEligible: true,
        isSelf: true,
      },
      {
        messageId: 'demo',
        chatId: 'c-team',
        senderName: 'Me',
        sentAt: now - 59 * 60 * 1000,
        text: null,
        mediaType: 'video',
        ocrEligible: true,
        isSelf: true,
      },
    ],
    new Map([['c-team', 'Team']]),
    now,
    now - 5 * 60 * 60 * 1000,
  )
  expect(report.candidates).toHaveLength(1)
  expect(report.candidates[0].responseState).toBe('received')
  expect(report.candidates[0].reasons).toContain('graph_response_received')
  expect(report.candidates[0].evidence.map((item) => item.messageId)).toEqual([
    'request',
    'response',
    'demo',
  ])
})
