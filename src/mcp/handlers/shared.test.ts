import { expect, test } from 'bun:test'
import { jsonText, toonResult, toonText } from './shared.js'

test('jsonText keeps small machine-facing payloads compact and valid', () => {
  const value = { sent: true, messageId: '123', read: false }
  const text = jsonText(value)
  expect(text).toBe('{"sent":true,"messageId":"123","read":false}')
  expect(JSON.parse(text)).toEqual(value)
})

test('toonText compresses repetitive read rows and toonResult wraps it', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    from: `u${i % 3}`,
    text: `message ${i}`,
    createdTime: i,
  }))
  const text = toonText(rows)
  expect(text.length).toBeLessThan(JSON.stringify(rows, null, 2).length)
  expect(toonResult(rows)).toEqual({
    content: [{ type: 'text', text }],
  })
})
