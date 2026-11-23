/**
 * Yomi's default semantic-search embedder — a local, offline ONNX model
 * via transformers.js (@huggingface/transformers), used when no host app
 * injects its own Embedder (see ./embedder.ts).
 *
 * Model: onnx-community/embeddinggemma-2-ONNX (Google EmbeddingGemma 2).
 * Text-only path is loaded for LINE message/search workloads (vision and
 * audio encoders are disabled to reduce download and resident memory).
 *
 * Retrieval convention (EmbeddingGemma 2):
 * - query:  `task: search result | query: {query}`
 * - document/message: `title: none | text: {content}`
 * The query gets the task prefix; stored documents do not use the query
 * instruction. Embeddings are mean-pooled and L2-normalized (768-dim).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Embedder } from './embedder.js'

const MODEL_ID = 'onnx-community/embeddinggemma-2-ONNX'
const QUERY_PREFIX = 'task: search result | query: '
const DOCUMENT_PREFIX = 'title: none | text: '

type DType = 'q4' | 'q8' | 'fp16' | 'fp32'

/** Minimal tensor shape returned by transformers.js text model. */
interface EmbeddingOutput {
  sentence_embedding: {
    dims: number[]
    data: Float32Array | number[]
  }
}

/** Minimal text-only embedding runtime used by this module. */
export interface TextEmbeddingRuntime {
  tokenizer: (
    texts: string[],
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  model: (inputs: Record<string, unknown>) => Promise<EmbeddingOutput>
}

let runtimePromise: Promise<TextEmbeddingRuntime> | null = null

/**
 * Tokenizer options every batch call uses.
 *
 * Padding and truncation are not optional here: a batch of messages almost
 * never has the same text length, and an unpadded batch makes the tokenizer
 * return ragged tensors that the model refuses ("Unable to create tensor …
 * activate truncation and/or padding"). That failure is quiet in effect —
 * every mixed-length batch throws, so the index stays keyword-only forever
 * while the code looks healthy. With padding enabled, mean pooling still
 * respects the attention mask: the same text embedded on its own and inside a
 * padded batch yields identical vectors.
 */
const TOKENIZER_OPTIONS = { padding: true, truncation: true } as const

/**
 * Resolve embedder dtype from environment, defaulting to q4 for lower memory.
 */
function resolveDType(): DType {
  const raw = (process.env.YOMI_EMBED_DTYPE || 'q4').toLowerCase()
  if (raw === 'q4' || raw === 'q8' || raw === 'fp16' || raw === 'fp32') {
    return raw
  }
  return 'q4'
}

/**
 * Lazily load and memoize the text-only EmbeddingGemma 2 runtime.
 * Vision/audio configs are nulled so only the text encoder is loaded.
 */
function getRuntime(): Promise<TextEmbeddingRuntime> {
  if (!runtimePromise) {
    runtimePromise = import('@huggingface/transformers')
      .then(async (mod) => {
        const { AutoConfig, AutoModel, AutoTokenizer, env } = mod as any
        env.cacheDir =
          process.env.YOMI_MODEL_CACHE_DIR ||
          (process.platform === 'darwin'
            ? join(homedir(), 'Library', 'Caches', 'Yomi', 'models')
            : join(process.env.LOCALAPPDATA || homedir(), 'Yomi', 'models'))

        const config = await AutoConfig.from_pretrained(MODEL_ID)
        config.vision_config = null
        config.audio_config = null

        const dtype = resolveDType()
        const [tokenizer, model] = await Promise.all([
          AutoTokenizer.from_pretrained(MODEL_ID),
          AutoModel.from_pretrained(MODEL_ID, {
            config,
            device: 'cpu',
            dtype,
          }),
        ])

        return { tokenizer, model } as TextEmbeddingRuntime
      })
      .catch((error) => {
        runtimePromise = null
        throw error
      })
  }
  return runtimePromise
}

/**
 * Split a model output tensor (flat data + dims [batch, hidden]) into one
 * vector per input row.
 */
function splitRows(output: EmbeddingOutput['sentence_embedding']): number[][] {
  const [rows, hidden] = output.dims
  const data = output.data
  const vectors: number[][] = []
  for (let i = 0; i < rows; i++) {
    vectors.push(Array.from(data.slice(i * hidden, (i + 1) * hidden)))
  }
  return vectors
}

/**
 * Format a stored message/document for EmbeddingGemma 2 retrieval.
 */
function formatDocument(text: string): string {
  return `${DOCUMENT_PREFIX}${text ?? ''}`
}

/**
 * Default Yomi embedder backed by transformers.js/ONNX (EmbeddingGemma 2),
 * running locally after first model download. Model load is lazy.
 */
export class DefaultEmbedder implements Embedder {
  readonly modelLabel = `${MODEL_ID}:${resolveDType()}:text`

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return []
    }
    const runtime = await getRuntime()
    const inputs = await runtime.tokenizer(
      texts.map(formatDocument),
      TOKENIZER_OPTIONS,
    )
    const output = await runtime.model(inputs)
    return splitRows(output.sentence_embedding)
  }

  async embedQuery(query: string): Promise<number[]> {
    const runtime = await getRuntime()
    const inputs = await runtime.tokenizer(
      [`${QUERY_PREFIX}${query}`],
      TOKENIZER_OPTIONS,
    )
    const output = await runtime.model(inputs)
    const [vector] = splitRows(output.sentence_embedding)
    return vector
  }
}

/**
 * Install a stand-in embedding runtime, for tests that need to exercise the
 * embedder without downloading the model. Passing null restores the real
 * runtime.
 *
 * @param runtime - Runtime to use, or null to go back to the real one.
 */
export function setEmbeddingRuntimeForTesting(
  runtime: TextEmbeddingRuntime | null,
): void {
  runtimePromise = runtime ? Promise.resolve(runtime) : null
}

let defaultEmbedder: DefaultEmbedder | null = null

/**
 * Get the process-wide singleton DefaultEmbedder instance.
 */
export function getDefaultEmbedder(): DefaultEmbedder {
  if (!defaultEmbedder) {
    defaultEmbedder = new DefaultEmbedder()
  }
  return defaultEmbedder
}
