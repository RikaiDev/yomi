import { expect, test } from 'bun:test'
import type { Embedder } from '../search/embedder.js'
import { scoreAttentionBatch } from './policy.js'

class IntentTestEmbedder implements Embedder {
  readonly modelLabel = 'test-semantic-transformer'
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      if (
        text.includes('行銷廣告') ||
        text.includes('疑問句包裝') ||
        text.includes('品牌優惠活動')
      )
        return [0, 0, 0, 0, 0, 1]
      if (
        text.includes('期限') ||
        text.includes('緊急事故') ||
        text.includes('明早前完成')
      )
        return [0, 1, 0, 0, 0, 0]
      if (
        text.includes('提出問題') ||
        text.includes('工作交辦') ||
        text.includes('請你核對')
      )
        return [1, 0, 0, 0, 0, 0]
      if (text.includes('帳單') || text.includes('交易失敗'))
        return [0, 0, 1, 0, 0, 0]
      if (text.includes('重要進度') || text.includes('關鍵人物'))
        return [0, 0, 0, 1, 0, 0]
      return [0, 0, 0, 0, 1, 0]
    })
  }
  async embedQuery(text: string): Promise<number[]> {
    return (await this.embed([text]))[0]
  }
}

const embedder = new IntentTestEmbedder()

test('official rhetorical promotion is filtered semantically', async () => {
  const [result] = await scoreAttentionBatch(
    [
      {
        id: 'synthetic-official-promotion',
        text: '品牌優惠活動開始了，你參加了嗎？',
        unreadCount: 3,
        isMuted: false,
        isOfficial: true,
      },
    ],
    embedder,
  )
  expect(result.tier).toBe('filtered')
  expect(result.reason).toBe('promotion')
})

test('official dated event is not treated as the user deadline', async () => {
  const [result] = await scoreAttentionBatch(
    [
      {
        id: 'synthetic-official-scheduled-event',
        text: '公開展示活動即將開始',
        unreadCount: 1,
        isMuted: false,
        isOfficial: true,
      },
    ],
    embedder,
  )
  expect(result.tier).toBe('filtered')
})

test('official media without alt text is not promoted as important', async () => {
  const [result] = await scoreAttentionBatch(
    [
      {
        id: 'official-image',
        text: '[yomi:image]',
        unreadCount: 1,
        isMuted: false,
        isOfficial: true,
      },
    ],
    embedder,
  )
  expect(result.tier).toBe('filtered')
  expect(result.reason).toBe('ordinary')
})

test('official event announcements stay out of attention unless transactional', async () => {
  const [result] = await scoreAttentionBatch(
    [
      {
        id: 'official-event',
        text: '下月舉辦公開交流活動，現場提供宣傳贈品',
        unreadCount: 2,
        isMuted: false,
        isOfficial: true,
      },
    ],
    embedder,
  )
  expect(result.tier).toBe('filtered')
})

test('semantic deadline outranks ordinary unread traffic', async () => {
  const [result] = await scoreAttentionBatch(
    [
      {
        id: 'u2',
        text: '這份報告請在明早前完成',
        unreadCount: 1,
        isMuted: false,
      },
    ],
    embedder,
  )
  expect(result.tier).toBe('now')
  expect(result.reason).toBe('deadline')
})

test('explicit priority and mute remain deterministic controls', async () => {
  const [priority, muted] = await scoreAttentionBatch(
    [
      {
        id: 'u3',
        text: '普通訊息',
        unreadCount: 0,
        isMuted: false,
        explicitPriority: true,
      },
      { id: 'u4', text: '請你核對', unreadCount: 9, isMuted: true },
    ],
    embedder,
  )
  expect(priority.tier).toBe('now')
  expect(muted.tier).toBe('filtered')
})
