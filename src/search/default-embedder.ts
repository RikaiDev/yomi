/**
 * Yomi's default semantic-search embedder — a local, offline ONNX model
 * via transformers.js (@huggingface/transformers), used when no host app
 * injects its own Embedder (see ./embedder.ts).
 *
 * Model: Xenova/bge-small-zh-v1.5 (BAAI general embedding, small, Chinese-
 * primary but multilingual-capable; 512-dim). Chosen because Yomi's data
 * is LINE messages, which for this project are predominantly Chinese.
 *
 * bun compatibility note: transformers.js picks a Node-flavored backend
 * under bun (it detects a Node-like `process`), which only accepts device
 * "cpu" | "coreml" | "webgpu" — "wasm" throws "Unsupported device". "cpu"
 * routes through onnxruntime-node, and it works under bun WITHOUT running
 * onnxruntime-node's postinstall script (bun blocks postinstalls by
 * default; the packaged binary still loads fine here) — verified: model
 * loads, embeds Chinese text, returns 512-dim unit-normalized vectors.
 * If bge-small-zh-v1.5 ever fails to load in some environment, fall back to
 * Xenova/multilingual-e5-small (384-dim, e5 prefix convention: query
 * embeds get `query: `, document embeds get `passage: `).
 *
 * Retrieval convention: bge models are asymmetric — the QUERY gets an
 * instruction prefix, stored documents do not. Using the model's official
 * recommended instruction for retrieval tasks.
 */

import type { Embedder } from './embedder.js'

const MODEL_ID = 'Xenova/bge-small-zh-v1.5'
const BGE_QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：'

/** Minimal shape of the transformers.js feature-extraction pipeline this module calls. */
type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array | number[] }>

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null

/**
 * Lazily load (and memoize) the transformers.js feature-extraction
 * pipeline for MODEL_ID. First call downloads/caches the ONNX model;
 * subsequent calls reuse the same pipeline instance.
 *
 * @returns Promise resolving to the feature-extraction pipeline.
 */
function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = import('@huggingface/transformers')
      .then(
        ({ pipeline }) =>
          pipeline('feature-extraction', MODEL_ID, {
            device: 'cpu',
          }) as unknown as Promise<FeatureExtractionPipeline>,
      )
      .catch((error) => {
        // Reset the memo on failure so a later call can retry (e.g. the
        // first attempt failed offline, network comes back later) instead
        // of permanently caching a rejected promise.
        pipelinePromise = null
        throw error
      })
  }
  return pipelinePromise
}

/**
 * Split a pipeline output tensor (flat data + dims [batch, hidden]) into
 * one number[] vector per input row.
 *
 * @param output - Raw pipeline output.
 * @returns One vector array per row.
 */
function splitRows(output: {
  dims: number[]
  data: Float32Array | number[]
}): number[][] {
  const [rows, hidden] = output.dims
  const data = output.data
  const vectors: number[][] = []
  for (let i = 0; i < rows; i++) {
    vectors.push(Array.from(data.slice(i * hidden, (i + 1) * hidden)))
  }
  return vectors
}

/**
 * Default Yomi embedder backed by transformers.js/ONNX, running fully
 * local and offline after the first model download. Model load happens on
 * first embed() or embedQuery() call, not at construction, so importing
 * this module never triggers a download by itself.
 */
export class DefaultEmbedder implements Embedder {
  readonly modelLabel = MODEL_ID

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return []
    }
    const extractor = await getPipeline()
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    return splitRows(output)
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vector] = await this.embed([`${BGE_QUERY_INSTRUCTION}${query}`])
    return vector
  }
}

let defaultEmbedder: DefaultEmbedder | null = null

/**
 * Get the process-wide singleton DefaultEmbedder instance. Constructing it
 * is cheap (no model load); the underlying pipeline only loads lazily on
 * first use.
 *
 * @returns Shared DefaultEmbedder instance.
 */
export function getDefaultEmbedder(): DefaultEmbedder {
  if (!defaultEmbedder) {
    defaultEmbedder = new DefaultEmbedder()
  }
  return defaultEmbedder
}
