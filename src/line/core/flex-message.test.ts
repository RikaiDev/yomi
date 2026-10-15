import { expect, test } from 'bun:test'
import {
  interpretFlexMessage,
  interpretFlexPayload,
  processFlexMessage,
  resolveImagemapImageUrl,
} from './flex-message.js'

test('appends a supported LINE imagemap resolution to its base URL', () => {
  expect(
    resolveImagemapImageUrl(
      'https://vos.line-scdn.net/img-bucket-real/images/example',
      1040,
    ),
  ).toBe('https://vos.line-scdn.net/img-bucket-real/images/example/700')
  expect(
    resolveImagemapImageUrl(
      'https://vos.line-scdn.net/img-bucket-real/images/example/700',
      700,
      640,
    ),
  ).toBe('https://vos.line-scdn.net/img-bucket-real/images/example/700')
})

const sample = {
  type: 'carousel',
  contents: [
    {
      type: 'bubble',
      hero: { type: 'image', url: 'https://example.com/hero.jpg' },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '本週 LINE POINTS' },
          { type: 'text', text: '最高回饋 15%' },
        ],
      },
      footer: {
        type: 'button',
        action: {
          type: 'uri',
          label: '立即查看',
          uri: 'https://example.com/points',
        },
      },
    },
  ],
}

test('interprets Flex in visual order with image and action', () => {
  expect(interpretFlexPayload(sample)).toEqual({
    summary: '本週 LINE POINTS · 最高回饋 15% · 立即查看',
    imageUrl: 'https://example.com/hero.jpg',
    actionUrl: 'https://example.com/points',
    actionLabels: ['立即查看'],
  })
})

test('reads Flex JSON from inbound LINE metadata', () => {
  expect(
    interpretFlexMessage({
      contentMetadata: { FLEX_JSON: JSON.stringify(sample) },
    }).summary,
  ).toContain('最高回饋 15%')
})

test('preserves the LINE image drawing-area contract', () => {
  const document = processFlexMessage({
    contentMetadata: {
      FLEX_JSON: JSON.stringify({
        type: 'bubble',
        size: 'mega',
        hero: {
          type: 'image',
          url: 'https://example.com/hero.jpg',
          size: 'full',
          aspectRatio: '20:13',
          aspectMode: 'cover',
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          paddingAll: 'lg',
          contents: [
            {
              type: 'text',
              text: 'Title',
              size: 'xl',
              weight: 'bold',
              wrap: true,
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          paddingAll: 'lg',
          contents: [
            {
              type: 'button',
              style: 'primary',
              height: 'sm',
              action: {
                type: 'uri',
                label: 'Open',
                uri: 'https://example.com',
              },
            },
          ],
        },
      }),
    },
  })
  const hero = document?.root?.children[0]
  expect(document?.root?.size).toBe('mega')
  expect(document?.root?.backgroundColor).toBe('#FFFFFF')
  expect(hero?.aspectRatio).toBe('20:13')
  expect(hero?.aspectMode).toBe('cover')
  expect(hero?.block).toBe('hero')
  expect(document?.root?.children[1]?.block).toBe('body')
  expect(document?.root?.children[2]?.block).toBe('footer')
  expect(document?.root?.children[1]?.paddingAll).toBe('lg')
  expect(document?.root?.children[1]?.children[0]?.weight).toBe('bold')
  expect(document?.root?.children[2]?.children[0]?.style).toBe('primary')
  expect(document?.root?.children[2]?.children[0]?.height).toBe('sm')
  expect(document?.layoutVersion).toBe(1)
  expect(document?.layoutFingerprint).toMatch(/^[0-9a-f]{64}$/)
  expect(hero?.resolved.aspectRatio).toBeCloseTo(20 / 13)
  expect(document?.root?.children[1]?.resolved.paddingTop).toBe(12)
  expect(document?.root?.children[2]?.children[0]?.resolved.buttonStyle).toBe(
    'primary',
  )
})

test('processes legacy rich imagemap into a multi-action document', () => {
  const document = processFlexMessage({
    contentMetadata: {
      ALT_TEXT: 'LINE POINTS activity',
      DOWNLOAD_URL: 'https://example.com/card.jpg',
      MARKUP_JSON: JSON.stringify({
        canvas: { width: 1040, height: 1040, initialScene: 'scene1' },
        actions: {
          left: {
            type: 'web',
            text: 'Mission',
            params: { linkUri: 'https://example.com/mission' },
          },
          right: {
            type: 'web',
            text: 'LINE GO',
            params: { linkUri: 'https://example.com/go' },
          },
        },
        scenes: {
          scene1: {
            listeners: [
              { action: 'left', params: [0, 0, 520, 1040] },
              { action: 'right', params: [520, 0, 520, 1040] },
            ],
          },
        },
      }),
    },
  })
  expect(document?.kind).toBe('imagemap')
  expect(document?.regions).toHaveLength(2)
  expect(document?.regions.map((region) => region.action.label)).toEqual([
    'Mission',
    'LINE GO',
  ])
})

test('rejects unsafe Flex action schemes', () => {
  expect(
    interpretFlexPayload({
      type: 'button',
      action: {
        type: 'uri',
        label: '不要執行',
        uri: 'javascript:alert(1)',
      },
    }).actionUrl,
  ).toBeNull()
})

test('does not expose machine-only uri labels as visible copy', () => {
  const result = interpretFlexPayload({
    type: 'bubble',
    hero: { type: 'image', url: 'https://example.com/card.jpg' },
    action: { type: 'uri', label: 'uri', uri: 'https://example.com/open' },
  })
  expect(result.summary).toBe('')
  expect(result.actionUrl).toBe('https://example.com/open')
})
