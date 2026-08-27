import { expect, test } from 'bun:test'
import { fetchLineMessageMedia, resolvePublicMediaUrl } from './media.js'

test('official public images use their trusted preview and download URLs', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input) => {
    urls.push(String(input))
    return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
  }) as typeof fetch
  const message = {
    id: 'public-image-1',
    contentType: 1,
    contentMetadata: {
      PUBLIC: 'true',
      PREVIEW_URL: 'https://a-alertsline.cdn.hinet.net/images/alert_thumb.jpg',
      DOWNLOAD_URL: 'https://a-alertsline.cdn.hinet.net/images/alert.png',
    },
  }

  try {
    const result = await fetchLineMessageMedia(
      {
        client: { authToken: 'session-token' },
        getRecentMessages: async () => [message],
      },
      'u-official',
      'public-image-1',
      true,
    )
    expect(result.bytes.length).toBe(4)
    expect(result.mimeType).toBe('image/png')
    expect(urls).toEqual([
      'https://a-alertsline.cdn.hinet.net/images/alert_thumb.jpg',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('public media metadata rejects untrusted and non-HTTPS URLs', () => {
  expect(
    resolvePublicMediaUrl(
      {
        contentMetadata: {
          PUBLIC: 'true',
          DOWNLOAD_URL: 'http://a-alertsline.cdn.hinet.net/image.png',
        },
      },
      false,
    ),
  ).toBeNull()
  expect(
    resolvePublicMediaUrl(
      {
        contentMetadata: {
          PUBLIC: 'true',
          DOWNLOAD_URL: 'https://127.0.0.1/private.png',
        },
      },
      false,
    ),
  ).toBeNull()
})

test('legacy image without OID/SID is fetched from OBS by message id', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input) => {
    urls.push(String(input))
    return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  }) as typeof fetch

  try {
    const result = await fetchLineMessageMedia(
      {
        client: { authToken: 'session-token' },
        getRecentMessages: async () => [
          {
            id: 'legacy-image-1',
            contentType: 1,
            contentMetadata: {
              seq: 'legacy-image-1',
              SRC_SVC_CODE: 'talk',
              MEDIA_CONTENT_INFO: JSON.stringify({ extension: 'jpeg' }),
            },
            text: null,
          },
        ],
      },
      'clegacy',
      'legacy-image-1',
      true,
    )
    expect(result.contentType).toBe(1)
    expect(result.bytes.length).toBe(4)
    expect(result.mimeType).toBe('image/jpeg')
    expect(urls).toEqual([
      'https://obs.line-apps.com/r/talk/m/legacy-image-1/preview',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
