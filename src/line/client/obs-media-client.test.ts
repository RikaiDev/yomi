import { expect, test } from 'bun:test'
import { downloadLineMessageData } from './obs-media-client.js'

test('legacy Talk media uses OBS message route, not a TalkService method', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init })
    return new Response(Uint8Array.from([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg; charset=binary' },
    })
  }) as typeof fetch

  try {
    const result = await downloadLineMessageData(
      {
        authToken: 'session-token',
      },
      { messageId: '628227866605650533', preview: true },
    )
    expect(result.bytes).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(result.mimeType).toBe('image/jpeg')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      'https://obs.line-apps.com/r/talk/m/628227866605650533/preview',
    )
    expect(calls[0]?.init?.method).toBe('GET')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('x-line-access')).toBe('session-token')
    expect(headers.get('x-line-application')).toBeTruthy()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('legacy Talk media routes original content without preview suffix', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    calls.push(String(input))
    return new Response(Uint8Array.from([0x25, 0x50, 0x44, 0x46]), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })
  }) as typeof fetch

  try {
    const result = await downloadLineMessageData(
      { authToken: 'session-token' },
      { messageId: '628227866605650533' },
    )
    expect(result.bytes.length).toBe(4)
    expect(result.mimeType).toBe('application/pdf')
    expect(calls).toEqual([
      'https://obs.line-apps.com/r/talk/m/628227866605650533',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Square media uses the g2 OBS namespace', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    calls.push(String(input))
    return new Response(Uint8Array.from([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  }) as typeof fetch

  try {
    await downloadLineMessageData(
      { authToken: 'session-token' },
      { messageId: 'square-message-1', preview: true, square: true },
    )
    expect(calls).toEqual([
      'https://obs.line-apps.com/r/g2/m/square-message-1/preview',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
