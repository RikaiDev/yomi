import { expect, test } from 'bun:test'
import {
  callHistoryPreview,
  isRenderableSquareMessage,
  messageFallback,
  messagePlaceholder,
  newestMessageWindow,
  richFields,
  sanitizeMessagePreview,
} from './query.js'

test('normalizes provider windows to the newest chronological page', () => {
  const messages = [
    { id: 'old', createdTime: 100 },
    { id: 'latest', createdTime: 400 },
    { id: 'middle', createdTime: 250 },
  ]
  expect(newestMessageWindow(messages, 2).map((message) => message.id)).toEqual(
    ['middle', 'latest'],
  )
})

test('rejects empty Square envelopes but keeps real text and media', () => {
  expect(
    isRenderableSquareMessage({
      id: 'empty',
      createdTime: 100,
      contentType: 0,
      text: '',
      contentMetadata: {},
    }),
  ).toBe(false)
  expect(
    isRenderableSquareMessage({ contentType: 0, text: 'actual message' }),
  ).toBe(true)
  expect(isRenderableSquareMessage({ contentType: 1, text: '' })).toBe(true)
})

test('converts private LINE call-history strings into semantic UI tokens', () => {
  expect(
    callHistoryPreview('Call History : 158000 millisecs, Result: 16', false),
  ).toBe('[yomi:call_duration:158]')
  expect(
    callHistoryPreview('Call History : 0 millisecs, Result: 77', false),
  ).toBe('[yomi:call_missed]')
  expect(
    callHistoryPreview('Call History : 0 millisecs, Result: 77', true),
  ).toBe('[yomi:call_no_answer]')
  expect(callHistoryPreview('unexpected payload', false)).toBe('[yomi:call]')
})

test('sanitizes E2EE envelope previews without leaking key material', () => {
  const envelope = JSON.stringify({
    keyMaterial: 'sensitive-key-material',
    keys: ['sensitive-key'],
    chunks: ['ciphertext'],
  })

  const preview = sanitizeMessagePreview(envelope)
  expect(preview).toBe('')
  expect(preview).not.toContain('keyMaterial')
  expect(preview).not.toContain('sensitive-key')
})

test('extracts real text from a wrapped decrypted payload', () => {
  expect(
    sanitizeMessagePreview(JSON.stringify({ text: '到現場後通知我' })),
  ).toBe('到現場後通知我')
  expect(sanitizeMessagePreview('一般訊息')).toBe('一般訊息')
})

test('raw last-message E2EE envelope is rejected before desktop preview output', () => {
  const rawLastMessage = JSON.stringify({
    keyMaterial: 'hXR-secret',
    ciphertext: 'encrypted-body',
    nonce: 'nonce-value',
  })
  expect(sanitizeMessagePreview(rawLastMessage)).toBe('')
})

test('nested envelope cannot bypass the shared sanitizer', () => {
  const rawMessage = {
    text: JSON.stringify({
      content: { keys: ['secret'], chunks: ['ciphertext'] },
    }),
  }
  expect(sanitizeMessagePreview(rawMessage)).toBe('')
  expect(sanitizeMessagePreview({ text: '這是真正的使用者訊息' })).toBe(
    '這是真正的使用者訊息',
  )
})

test('maps rich message image and safe redirect without exposing metadata', () => {
  const result = richFields({
    contentType: 17,
    contentMetadata: {
      SPEC_REV: '1',
      DOWNLOAD_URL: 'https://obs.line-scdn.net/rich/preview.jpg',
      ALT_TEXT: '活動通知',
      LINE_TAG_REDIRECTOR: 'https://example.com/event',
      MARKUP_JSON: JSON.stringify({
        actions: [{ linkUri: 'javascript:alert(1)' }],
      }),
    },
  })
  expect(result.altText).toBe('活動通知')
  expect(result.mediaUrl).toBe('https://obs.line-scdn.net/rich/preview.jpg')
  expect(result.actionUrl).toBe('https://example.com/event')
  expect(JSON.stringify(result)).not.toContain('SPEC_REV')
})

test('rich message rejects non-web media and action schemes', () => {
  const result = richFields({
    contentMetadata: {
      DOWNLOAD_URL: 'file:///tmp/private.jpg',
      LINE_TAG_REDIRECTOR: 'line://nv/chat',
      MARKUP_JSON: JSON.stringify({
        action: { linkUri: 'javascript:alert(1)' },
      }),
      ALT_TEXT: '提示',
    },
  })
  expect(result.mediaUrl).toBeNull()
  expect(result.actionUrl).toBeNull()
  expect(result.altText).toBe('提示')
})

test('names every known non-text LINE content type without generic fallback copy', () => {
  expect(messagePlaceholder(22)).toBe('[yomi:rich]')
  expect(messagePlaceholder(15)).toBe('[yomi:location]')
  expect(messagePlaceholder(13)).toBe('[yomi:contact]')
  expect(messagePlaceholder(999)).toBe('[yomi:line_content:999]')
})

test('labels authenticated-decryption failures honestly', () => {
  expect(
    messageFallback({
      contentType: 0,
      text: null,
      e2eeDecryptFailure: { reason: 'gcm_auth_failed' },
    }),
  ).toBe('[yomi:decrypt_failed]')
})

test('richFields interprets Flex JSON instead of returning an attachment placeholder', () => {
  const result = richFields({
    contentType: 22,
    contentMetadata: {
      FLEX_JSON: JSON.stringify({
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '本週回饋' },
            { type: 'text', text: 'LINE POINTS 15%' },
          ],
        },
        footer: {
          type: 'button',
          action: {
            type: 'uri',
            label: '查看活動',
            uri: 'https://example.com',
          },
        },
      }),
    },
  })
  expect(result.altText).toBe('本週回饋 · LINE POINTS 15% · 查看活動')
  expect(result.actionUrl).toBe('https://example.com/')
})
