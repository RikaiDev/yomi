import { describe, expect, test } from 'bun:test'
import { localizedStickerTitle } from './sticker-meta.js'

describe('localizedStickerTitle', () => {
  const titles = {
    en: 'Flower Friends',
    'zh-Hant': '範例貼圖－春日篇',
    ja: 'サンプルスタンプ',
  }

  test('chooses the Traditional Chinese CDN title', () => {
    expect(localizedStickerTitle(titles, 'zh-TW')).toBe('範例貼圖－春日篇')
    expect(localizedStickerTitle(titles, 'zh_TW')).toBe('範例貼圖－春日篇')
  })

  test('chooses Japanese and English titles', () => {
    expect(localizedStickerTitle(titles, 'ja')).toBe('サンプルスタンプ')
    expect(localizedStickerTitle(titles, 'en')).toBe('Flower Friends')
  })

  test('falls back to English, then first title, then shop title', () => {
    expect(localizedStickerTitle({ ja: '日本語' }, 'zh-TW', 'Shop title')).toBe(
      '日本語',
    )
    expect(localizedStickerTitle({}, 'en', 'Shop title')).toBe('Shop title')
  })
})
