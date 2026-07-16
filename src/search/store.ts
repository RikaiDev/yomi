/**
 * Yomi local cross-conversation search index — a node:sqlite FTS5 store
 * over collected LINE messages.
 *
 * This is a SEPARATE concern from the pure-query MCP tools in src/mcp/.
 * The index is only ever written to by collect_messages (see
 * ../search/collector.ts), an explicit caller-invoked operation — never by
 * list_conversations/get_chat_messages/etc, which stay pure-query and never
 * touch this file. Search is keyword-only (FTS5 bm25 ranking); no
 * relationship graph, no affinity scoring, no interaction metrics live
 * here.
 *
 * Keyword search has zero external dependencies (Node.js built-in
 * `node:sqlite`, which bundles FTS5). Semantic search is an additional,
 * optional tier on top: each message's text can also be embedded into a
 * dense vector (stored in the `embeddings` table, see getDb()) and ranked
 * by brute-force cosine similarity in JS — no native vector extension, this
 * is personal-scale (thousands of rows, not millions). The embedder itself
 * is always caller-injected (see ../search/embedder.ts); this file never
 * imports a concrete embedder implementation.
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { yomiDataPath } from '../util/data-dir.js'
import { toSearchText } from './bigram.js'
import type { Embedder } from './embedder.js'
import { type Database, openDatabase } from './sqlite.js'

/**
 * Narrow files to owner-only (0600), skipping any that do not exist.
 *
 * Best-effort: a chmod failure must never take the index down, since the data
 * is still usable and the process may not own the file (e.g. a shared path an
 * operator deliberately set up).
 *
 * @param paths - Files to restrict.
 */
function restrictToOwner(...paths: string[]): void {
  for (const path of paths) {
    try {
      if (existsSync(path)) {
        chmodSync(path, 0o600)
      }
    } catch {
      // Not ours to tighten, or a platform without POSIX modes.
    }
  }
}

// A per-user data directory (see ../util/data-dir.ts), NOT process.cwd() and
// NOT the install directory. This used to resolve relative to the module, which
// put the index inside the installed package — and `npx @rikaidev/yomi` unpacks
// under ~/.npm/_npx/<hash>/, which npm deletes on any cache refresh. The index
// went with it. YOMI_INDEX_DB_PATH still overrides for tests/custom setups.
const DB_PATH =
  process.env.YOMI_INDEX_DB_PATH ?? yomiDataPath('search-index.db')

/** One message as stored in (or retrieved from) the search index. */
export interface MessageRecord {
  chatId: string
  chatName: string | null
  messageId: string
  fromMid: string | null
  fromName: string | null
  text: string
  createdTime: number | null
}

/** One search hit returned by searchMessages. */
export interface SearchResult {
  chatId: string
  chatName: string | null
  messageId: string
  fromName: string | null
  text: string
  createdTime: number | null
}

/** One semantic search hit — a SearchResult plus its cosine similarity score. */
export interface SemanticSearchResult extends SearchResult {
  score: number
}

let db: Database | null = null

/**
 * Open (creating if needed) the Yomi search index database and ensure its
 * schema exists. Memoized: subsequent calls reuse the same connection.
 *
 * Schema: `messages` is the authoritative row store (unique on messageId
 * for dedup). `text` holds the raw message body for display; `search_text`
 * holds the bigram-preprocessed form (see ./bigram.ts) that actually gets
 * indexed — the default unicode61 FTS5 tokenizer has no CJK word
 * segmentation, so a whole Chinese/Japanese/Korean run would otherwise
 * collapse into one opaque token and never match a substring search.
 * `messages_fts` is an external-content FTS5 index over `messages.search_text`,
 * kept in sync by INSERT/UPDATE/DELETE triggers so plain upserts into
 * `messages` automatically maintain the search index.
 *
 * @returns Open node:sqlite database handle.
 */
export function getDb(): Database {
  if (db) {
    return db
  }
  const dir = dirname(DB_PATH)
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const handle = openDatabase(DB_PATH)
  handle.exec('PRAGMA journal_mode = WAL;')
  // This file is every captured message in plaintext — the single most
  // sensitive artifact Yomi produces. It was being created with the default
  // 0644, readable by every other account on the machine. WAL mode means the
  // -wal and -shm siblings hold message data too, so they get the same
  // treatment. Applied on every open, not just creation, so databases that
  // already exist with the old permissions are repaired rather than left
  // exposed for the lifetime of the install.
  restrictToOwner(DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`)
  handle.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      messageId TEXT UNIQUE NOT NULL,
      chatId TEXT NOT NULL,
      chatName TEXT,
      fromMid TEXT,
      fromName TEXT,
      text TEXT NOT NULL,
      search_text TEXT NOT NULL,
      createdTime INTEGER
    );
  `)
  handle.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      search_text,
      content='messages',
      content_rowid='id'
    );
  `)
  handle.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, search_text) VALUES (new.id, new.search_text);
    END;
  `)
  handle.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
    END;
  `)
  handle.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
      INSERT INTO messages_fts(rowid, search_text) VALUES (new.id, new.search_text);
    END;
  `)
  // Semantic search vectors, kept separate from `messages` and keyed by
  // (messageId, model): a Float32 vector BLOB per (message, embedding
  // model) pair. Keying on model means switching embedders never mixes
  // incompatible vectors/dimensionality — old-model rows just go unused
  // until re-embedded, they are never compared against new-model vectors.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      messageId TEXT NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (messageId, model)
    );
  `)
  // Observability/resume cursor for the continuous capture loop (see
  // ../search/capture.ts): a single-row table recording the LINE sync
  // revision counters as of the last successful capture flush. Capture
  // itself is idempotent (collectMessages upserts), so this is not load-
  // bearing for correctness — it exists so a future resume path or
  // diagnostics can see where capture last got to.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS capture_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER,
      globalRevision INTEGER,
      individualRevision INTEGER,
      updatedAt INTEGER
    );
  `)
  db = handle
  return handle
}

/**
 * Upsert a batch of collected messages into the search index, deduping on
 * messageId (LINE's stable per-message identifier). Existing rows are
 * updated in place; the messages_ai/messages_au triggers keep the FTS5
 * index in sync automatically, so callers never touch messages_fts
 * directly.
 *
 * @param rows - Messages to index.
 * @returns Number of rows upserted.
 */
export function upsertMessages(rows: MessageRecord[]): number {
  if (rows.length === 0) {
    return 0
  }
  const handle = getDb()
  const stmt = handle.prepare(`
    INSERT INTO messages (messageId, chatId, chatName, fromMid, fromName, text, search_text, createdTime)
    VALUES ($messageId, $chatId, $chatName, $fromMid, $fromName, $text, $searchText, $createdTime)
    ON CONFLICT(messageId) DO UPDATE SET
      chatId = excluded.chatId,
      chatName = excluded.chatName,
      fromMid = excluded.fromMid,
      fromName = excluded.fromName,
      text = excluded.text,
      search_text = excluded.search_text,
      createdTime = excluded.createdTime;
  `)
  const upsertAll = handle.transaction((batch: MessageRecord[]) => {
    for (const row of batch) {
      stmt.run({
        $messageId: row.messageId,
        $chatId: row.chatId,
        $chatName: row.chatName,
        $fromMid: row.fromMid,
        $fromName: row.fromName,
        $text: row.text,
        $searchText: toSearchText(row.text),
        $createdTime: row.createdTime,
      })
    }
  })
  upsertAll(rows)
  return rows.length
}

/**
 * Count messages currently in the search index. Used to give an honest
 * "index is empty, run collect_messages first" answer instead of silently
 * returning zero results as if the search itself found nothing.
 *
 * @returns Total indexed message count.
 */
export function getIndexedMessageCount(): number {
  const handle = getDb()
  const row = handle
    .prepare<{ count: number }>('SELECT COUNT(*) as count FROM messages;')
    .get()
  return row?.count ?? 0
}

/**
 * Build a safe FTS5 MATCH string from a raw user query: bigram-preprocess
 * it with the same toSearchText used at index time (so a CJK substring
 * lines up with the bigrams stored in search_text), then wrap each
 * resulting token in double quotes and join with spaces. Quoting every
 * token neutralizes FTS5 query-syntax characters (AND, OR, NOT, prefix
 * wildcard, column filters, minus-exclusion, etc.) that could otherwise
 * appear in arbitrary user input and break or hijack
 * the query; space-separated quoted tokens form an implicit AND, which is
 * exactly the "all bigrams present" substring semantics this feature needs.
 *
 * @param query - Raw user search string.
 * @returns Quoted-token MATCH string, or '' when the query has no tokens.
 */
function buildMatchQuery(query: string): string {
  const searchText = toSearchText(query)
  if (!searchText) {
    return ''
  }
  return searchText
    .split(' ')
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ')
}

/**
 * Full-text search the collected message index, ranked by FTS5 bm25
 * relevance (best match first). Searches ONLY already-collected messages —
 * callers should check getIndexedMessageCount() first to distinguish "no
 * matches" from "nothing indexed yet".
 *
 * The query is bigram-preprocessed with the same toSearchText applied at
 * index time, so CJK substrings (no native word boundaries) match the same
 * way Latin words do. When preprocessing yields no tokens at all (e.g. a
 * punctuation-only query), this falls back to a plain LIKE substring scan
 * over the raw `messages.text` rather than returning an empty result.
 *
 * @param query - Search query. Plain keywords (Latin or CJK) work.
 * @param limit - Maximum number of results (default 20).
 * @returns Matching messages, best relevance first.
 */
export function searchMessages(query: string, limit = 20): SearchResult[] {
  const handle = getDb()
  const matchQuery = buildMatchQuery(query)
  if (!matchQuery) {
    const rows = handle
      .prepare<SearchResult>(`
      SELECT chatId, chatName, messageId, fromName, text, createdTime
      FROM messages
      WHERE text LIKE '%' || $query || '%'
      ORDER BY id DESC
      LIMIT $limit;
    `)
      .all({ $query: query, $limit: limit })
    return rows
  }
  const rows = handle
    .prepare<SearchResult>(`
    SELECT m.chatId as chatId, m.chatName as chatName, m.messageId as messageId,
           m.fromName as fromName, m.text as text, m.createdTime as createdTime
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    WHERE messages_fts MATCH $query
    ORDER BY bm25(messages_fts)
    LIMIT $limit;
  `)
    .all({ $query: matchQuery, $limit: limit })
  return rows
}

/**
 * Serialize a unit-normalized embedding vector to a compact BLOB (raw
 * Float32 bytes) for storage.
 *
 * @param vector - Embedding vector.
 * @returns Buffer suitable for a node:sqlite BLOB parameter.
 */
function encodeVector(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer)
}

/**
 * Deserialize a stored BLOB back into a Float32Array vector.
 *
 * @param blob - Raw BLOB bytes read back from the `embeddings` table.
 * @returns Decoded Float32Array vector.
 */
function decodeVector(blob: Uint8Array): Float32Array {
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
  )
}

/**
 * Upsert a batch of message embeddings for one embedder model, keyed on
 * (messageId, model). Called by the collector after upsertMessages, with
 * whatever Embedder the caller injected — this function has no opinion on
 * which model produced the vectors, it only records the label alongside
 * them so semanticSearch can compare like with like.
 *
 * @param rows - messageId + vector pairs to store.
 * @param model - Embedder.modelLabel that produced these vectors.
 * @returns Number of rows upserted.
 */
export function upsertEmbeddings(
  rows: { messageId: string; vector: number[] }[],
  model: string,
): number {
  if (rows.length === 0) {
    return 0
  }
  const handle = getDb()
  const stmt = handle.prepare(`
    INSERT INTO embeddings (messageId, model, dim, vector)
    VALUES ($messageId, $model, $dim, $vector)
    ON CONFLICT(messageId, model) DO UPDATE SET
      dim = excluded.dim,
      vector = excluded.vector;
  `)
  const upsertAll = handle.transaction(
    (batch: { messageId: string; vector: number[] }[]) => {
      for (const row of batch) {
        stmt.run({
          $messageId: row.messageId,
          $model: model,
          $dim: row.vector.length,
          $vector: encodeVector(row.vector),
        })
      }
    },
  )
  upsertAll(rows)
  return rows.length
}

/**
 * Count vectors currently stored for a given embedder model. Used to
 * decide whether semantic search has anything to rank over for the
 * currently-configured embedder, distinct from getIndexedMessageCount()
 * (which counts raw messages regardless of embedding status).
 *
 * @param model - Embedder.modelLabel to count vectors for.
 * @returns Number of stored vectors for that model.
 */
export function getEmbeddingCount(model: string): number {
  const handle = getDb()
  const row = handle
    .prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM embeddings WHERE model = $model;',
    )
    .get({ $model: model })
  return row?.count ?? 0
}

/**
 * List indexed messages that have no embedding for the given model — the
 * text still needed to embed them. This is what makes embedding coverage
 * self-healing: a message can enter the index keyword-only (collected
 * before an embedder was wired, or during a run where the model failed to
 * load) and later be embedded from its stored text alone, with no need to
 * re-fetch it from LINE. Empty-text rows are excluded (nothing to embed).
 *
 * @param model - Embedder.modelLabel to check coverage for.
 * @returns messageId + text for every indexed message missing a vector for that model.
 */
export function getMessagesMissingEmbedding(
  model: string,
): { messageId: string; text: string }[] {
  const handle = getDb()
  return handle
    .prepare<{ messageId: string; text: string }>(`
    SELECT m.messageId as messageId, m.text as text
    FROM messages m
    LEFT JOIN embeddings e ON e.messageId = m.messageId AND e.model = $model
    WHERE e.messageId IS NULL AND length(m.text) > 0;
  `)
    .all({ $model: model })
}

/**
 * Cosine similarity between two equal-length vectors. Both stored and
 * query vectors are unit-normalized at embed time, so this reduces to a
 * plain dot product — kept as an explicit cosine for clarity and so the
 * function stays correct even if that normalization invariant ever
 * changes.
 *
 * @param a - First vector.
 * @param b - Second vector.
 * @returns Cosine similarity in [-1, 1].
 */
function cosineSimilarity(a: Float32Array, b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < b.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Semantic search: embed the query with the caller-injected Embedder, then
 * brute-force cosine-similarity-rank all stored vectors for that model.
 * Personal-scale (thousands of rows) — no vector index, just a JS scan.
 *
 * Callers should check getEmbeddingCount(embedder.modelLabel) > 0 first
 * (or catch embed() throwing) to distinguish "no semantic index yet" from
 * "genuinely no matches", and fall back to searchMessages() accordingly —
 * this function itself does not fall back, so tiering stays a caller
 * decision (see ../mcp/search-handlers.ts).
 *
 * @param query - Raw user search query.
 * @param limit - Maximum number of results (default 20).
 * @param embedder - Injected embedder (default: DefaultEmbedder, or a host-supplied one).
 * @returns Matching messages, best cosine similarity first.
 */
export async function semanticSearch(
  query: string,
  limit: number,
  embedder: Embedder,
): Promise<SemanticSearchResult[]> {
  const queryVector = await embedder.embedQuery(query)
  const handle = getDb()
  const rows = handle
    .prepare<SearchResult & { vector: Uint8Array }>(`
    SELECT m.chatId as chatId, m.chatName as chatName, m.messageId as messageId,
           m.fromName as fromName, m.text as text, m.createdTime as createdTime,
           e.vector as vector
    FROM embeddings e
    JOIN messages m ON m.messageId = e.messageId
    WHERE e.model = $model;
  `)
    .all({ $model: embedder.modelLabel })

  const scored = rows.map((row) => {
    const { vector, ...result } = row
    return {
      ...result,
      score: cosineSimilarity(decodeVector(vector), queryVector),
    }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** Persisted LINE sync cursor for the continuous capture loop (see ../search/capture.ts). */
export interface CaptureState {
  revision: number
  globalRevision: number
  individualRevision: number
  updatedAt: number
}

/**
 * Read the persisted capture cursor, if any has been saved yet.
 *
 * @returns The persisted capture state, or null before capture has ever flushed.
 */
export function getCaptureState(): CaptureState | null {
  const row = getDb()
    .prepare(
      'SELECT revision, globalRevision, individualRevision, updatedAt FROM capture_state WHERE id = 1',
    )
    .get() as any
  return row
    ? {
        revision: row.revision ?? 0,
        globalRevision: row.globalRevision ?? 0,
        individualRevision: row.individualRevision ?? 0,
        updatedAt: row.updatedAt ?? 0,
      }
    : null
}

/**
 * Persist the current capture cursor, overwriting the single stored row.
 *
 * @param state - Capture cursor to persist.
 */
export function saveCaptureState(state: {
  revision: number
  globalRevision: number
  individualRevision: number
  updatedAt: number
}): void {
  getDb().exec(
    'INSERT INTO capture_state (id, revision, globalRevision, individualRevision, updatedAt) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, globalRevision = excluded.globalRevision, individualRevision = excluded.individualRevision, updatedAt = excluded.updatedAt',
    [
      state.revision,
      state.globalRevision,
      state.individualRevision,
      state.updatedAt,
    ],
  )
}
