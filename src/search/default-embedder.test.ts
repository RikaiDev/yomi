import { expect, test } from 'bun:test'

import {
  DefaultEmbedder,
  setEmbeddingRuntimeForTesting,
} from './default-embedder.js'

/**
 * The tokenizer must be told to pad and truncate.
 *
 * A batch of real messages almost never has the same text length, and an
 * unpadded batch makes the model refuse the ragged tensor outright — so the
 * embedding backlog silently never drains. This test pins the options the
 * embedder passes, without downloading the 197 MB model.
 */
test('every batch call pads and truncates the tokenizer input', async () => {
  const seen: { texts: string[]; options?: Record<string, unknown> }[] = []
  setEmbeddingRuntimeForTesting({
    async tokenizer(texts: string[], options?: Record<string, unknown>) {
      seen.push({ texts, options })
      return { input_ids: [[1, 2, 3]] }
    },
    async model() {
      return {
        sentence_embedding: {
          dims: [2, 4],
          data: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
        },
      }
    },
  })

  try {
    const embedder = new DefaultEmbedder()
    const vectors = await embedder.embed(['短', '長一點的文字內容測試'])
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toHaveLength(4)

    expect(seen).toHaveLength(1)
    expect(seen[0].options?.padding).toBe(true)
    expect(seen[0].options?.truncation).toBe(true)
  } finally {
    setEmbeddingRuntimeForTesting(null)
  }
})

test('a query vector is padded and truncated as well', async () => {
  const seen: { options?: Record<string, unknown> }[] = []
  setEmbeddingRuntimeForTesting({
    async tokenizer(_texts: string[], options?: Record<string, unknown>) {
      seen.push({ options })
      return { input_ids: [[1, 2, 3]] }
    },
    async model() {
      return {
        sentence_embedding: {
          dims: [1, 4],
          data: new Float32Array([0, 1, 0, 1]),
        },
      }
    },
  })

  try {
    const embedder = new DefaultEmbedder()
    const vector = await embedder.embedQuery('簽到表')
    expect(vector).toHaveLength(4)
    expect(seen[0].options?.padding).toBe(true)
    expect(seen[0].options?.truncation).toBe(true)
  } finally {
    setEmbeddingRuntimeForTesting(null)
  }
})
