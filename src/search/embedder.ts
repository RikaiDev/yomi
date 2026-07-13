/**
 * Semantic-search embedder seam for Yomi's search index.
 *
 * This interface is the injection point between the local search index
 * (store.ts, collector.ts) and whatever produces dense vectors. Yomi ships
 * a default implementation (./default-embedder.ts, transformers.js/ONNX) so
 * the MCP server works standalone, but nothing in store.ts/collector.ts
 * imports that default directly — they only depend on this interface, so a
 * host app (e.g. inboxd) can inject its own embedder (its local MLX
 * `generateEmbedding`) instead. See ./default-embedder.ts's doc comment for
 * the exact adapter shape.
 */

export interface Embedder {
  /**
   * A stable label identifying the model that produces these vectors (e.g.
   * `Xenova/bge-small-zh-v1.5`). Stored alongside each vector so stale
   * embeddings from a previously-configured model are never compared
   * against vectors from a different model/dimensionality.
   */
  readonly modelLabel: string

  /**
   * Embed a batch of *stored document* texts into dense vectors. No query
   * instruction prefix — only query-side embedding (see embedQuery) adds
   * one, per the asymmetric retrieval convention some embedding models
   * (e.g. bge, e5) expect.
   *
   * @param texts - Texts to embed.
   * @returns One unit-normalized vector per input text, in the same order.
   */
  embed(texts: string[]): Promise<number[][]>

  /**
   * Embed a single *search query* into a dense vector, applying whatever
   * asymmetric retrieval instruction/prefix the underlying model expects
   * (e.g. bge's "为这个句子生成表示以用于检索相关文章：" or e5's `query: `).
   * Falls back to embed([query])[0] when the model has no such convention.
   *
   * @param query - Raw user search query.
   * @returns Unit-normalized query vector.
   */
  embedQuery(query: string): Promise<number[]>
}
