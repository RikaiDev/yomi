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
  contentType?: number
  stickerId?: string | null
  stickerPackageId?: string | null
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

/** One message in the context window returned around a search hit. */
export interface SearchContextMessage extends SearchResult {
  isMatch: boolean
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
      createdTime INTEGER,
      contentType INTEGER DEFAULT 0,
      stickerId TEXT,
      stickerPackageId TEXT
    );
  `)
  // Migrate existing databases: add columns if missing.
  const cols = handle
    .prepare<{ name: string }>('PRAGMA table_info(messages)')
    .all()
    .map((c) => c.name)
  if (!cols.includes('contentType')) {
    handle.exec('ALTER TABLE messages ADD COLUMN contentType INTEGER DEFAULT 0')
  }
  if (!cols.includes('stickerId')) {
    handle.exec('ALTER TABLE messages ADD COLUMN stickerId TEXT')
  }
  if (!cols.includes('stickerPackageId')) {
    handle.exec('ALTER TABLE messages ADD COLUMN stickerPackageId TEXT')
  }
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
  // Facts about people that the owner stated OUTSIDE the indexed LINE
  // conversations — in a chat with an assistant, in a command, or in a note.
  // The persona graph can only find roles that were written down somewhere;
  // when the owner tells a role to the assistant rather than to the person,
  // this table is the only place it can live. Every row keeps the owner's own
  // wording as evidence, exactly like a role read from a message.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS persona_facts (
      id INTEGER PRIMARY KEY,
      subjectMid TEXT,
      subjectName TEXT NOT NULL,
      term TEXT NOT NULL,
      category TEXT NOT NULL,
      evidence TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'named',
      instances INTEGER NOT NULL DEFAULT 1,
      confidence REAL NOT NULL DEFAULT 0.5,
      createdAt INTEGER NOT NULL
    );
  `)
  handle.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS persona_facts_subject_term
    ON persona_facts (subjectName, term);
  `)
  // Migrate: a database written before roles carried their origin, instance
  // count and confidence. A fact recorded then was one the owner stated, so
  // it keeps that meaning rather than being re-labelled as a model's
  // conclusion.
  const factCols = handle
    .prepare<{ name: string }>('PRAGMA table_info(persona_facts)')
    .all()
    .map((c) => c.name)
  if (!factCols.includes('origin')) {
    handle.exec(
      "ALTER TABLE persona_facts ADD COLUMN origin TEXT NOT NULL DEFAULT 'stated'",
    )
  }
  if (!factCols.includes('instances')) {
    handle.exec(
      'ALTER TABLE persona_facts ADD COLUMN instances INTEGER NOT NULL DEFAULT 1',
    )
  }
  if (!factCols.includes('confidence')) {
    handle.exec(
      'ALTER TABLE persona_facts ADD COLUMN confidence REAL NOT NULL DEFAULT 1',
    )
  }
  // Derived evidence, computed from the conversations and written back here
  // so a reader gets the current picture without rescanning the whole
  // corpus. Each row is one piece of quotable evidence about one person.
  //
  // Note what is NOT here: a table of roles. Yomi does not decide what
  // someone is — it hands over the evidence and lets the model reading the
  // tool name them. What the model concludes is remembered separately, in
  // `persona_facts`, with the sentence it based the name on.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS persona_evidence (
      id INTEGER PRIMARY KEY,
      mid TEXT NOT NULL,
      name TEXT,
      kind TEXT NOT NULL,
      form TEXT,
      text TEXT NOT NULL,
      occurrences INTEGER NOT NULL,
      chatId TEXT,
      chatName TEXT,
      derivedAt INTEGER NOT NULL,
      UNIQUE (mid, kind, form, text)
    );
  `)
  // Style rules: the owner's writing rules, written by a model that read the
  // owner's own messages as evidence. The statistics in the style profile are
  // measurements; these rows are judgements, and each one keeps the sentence
  // it was based on, the situation it applies to, and the situation it does
  // not apply to.
  //
  // A rule is never silently rewritten. A contradicting rule supersedes the
  // older one: the old row stays with status 'superseded' so the history of
  // what was believed, and when, is still readable.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS style_rules (
      id INTEGER PRIMARY KEY,
      ruleId TEXT UNIQUE NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      chatId TEXT,
      statement TEXT NOT NULL,
      appliesWhen TEXT,
      doesNotApplyWhen TEXT,
      evidence TEXT NOT NULL,
      counterExample TEXT,
      origin TEXT NOT NULL DEFAULT 'derived',
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      supersedes TEXT,
      createdAt INTEGER NOT NULL
    );
  `)
  handle.exec(`
    CREATE INDEX IF NOT EXISTS style_rules_scope
    ON style_rules (scope, chatId, status);
  `)
  // The personas themselves: one row per person, with what the evidence
  // says about them.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS persona_nodes (
      mid TEXT PRIMARY KEY,
      name TEXT,
      addresses TEXT,
      summary TEXT,
      derivedAt INTEGER NOT NULL
    );
  `)
  // When the derivation last ran, and over how many messages, so a caller can
  // tell a fresh graph from a stale one.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS persona_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      derivedAt INTEGER,
      messageCount INTEGER,
      roleCount INTEGER
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
 * @param handle - Database handle to write to. Defaults to the shared index;
 *   tests pass their own so they never touch the real one.
 * @returns Number of rows upserted.
 */
export function upsertMessages(
  rows: MessageRecord[],
  handle?: Database,
): number {
  if (rows.length === 0) {
    return 0
  }
  const db = handle ?? getDb()
  const stmt = db.prepare(`
    INSERT INTO messages (messageId, chatId, chatName, fromMid, fromName, text, search_text, createdTime, contentType, stickerId, stickerPackageId)
    VALUES ($messageId, $chatId, $chatName, $fromMid, $fromName, $text, $searchText, $createdTime, $contentType, $stickerId, $stickerPackageId)
    ON CONFLICT(messageId) DO UPDATE SET
      chatId = excluded.chatId,
      chatName = excluded.chatName,
      fromMid = excluded.fromMid,
      fromName = excluded.fromName,
      text = excluded.text,
      search_text = excluded.search_text,
      createdTime = excluded.createdTime,
      contentType = excluded.contentType,
      stickerId = excluded.stickerId,
      stickerPackageId = excluded.stickerPackageId;
  `)
  const upsertAll = db.transaction((batch: MessageRecord[]) => {
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
        $contentType: row.contentType ?? 0,
        $stickerId: row.stickerId ?? null,
        $stickerPackageId: row.stickerPackageId ?? null,
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
 * Return a small chronological window around one search hit. Ranking stays at
 * message level; context is attached only after winners are known, so nearby
 * filler can explain a result without polluting retrieval scores.
 */
export function getMessageContext(
  messageId: string,
  radius = 2,
): SearchContextMessage[] {
  const handle = getDb()
  const target = handle
    .prepare<{ chatId: string }>(
      'SELECT chatId FROM messages WHERE messageId = $messageId;',
    )
    .get({ $messageId: messageId })
  if (!target) return []
  const rows = handle
    .prepare<SearchResult>(`
      SELECT chatId, chatName, messageId, fromName, text, createdTime
      FROM messages
      WHERE chatId = $chatId
      ORDER BY CASE WHEN createdTime IS NULL THEN 1 ELSE 0 END, createdTime, id;
    `)
    .all({ $chatId: target.chatId })
  const index = rows.findIndex((row) => row.messageId === messageId)
  if (index < 0) return []
  return rows
    .slice(Math.max(0, index - radius), index + radius + 1)
    .map((row) => ({ ...row, isMatch: row.messageId === messageId }))
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
 * Remove embeddings that do not belong to the active model. This makes model
 * upgrades (e.g. different model label or vector dimension) automatic: stale
 * vectors are discarded so they are never compared against incompatible
 * vectors and can be re-embedded from stored message text.
 *
 * @param model - Active embedder model label to keep.
 * @returns Number of stale embedding rows deleted.
 */
export function pruneStaleEmbeddings(model: string): number {
  const handle = getDb()
  const stmt = handle.prepare('DELETE FROM embeddings WHERE model != $model;')
  const result = stmt.run({ $model: model }) as { changes?: number } | void
  return Number((result as any)?.changes ?? 0)
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
 * @param handle - Database handle to write to. Defaults to the shared index;
 *   tests pass their own so they never touch the real one.
 * @returns Number of rows upserted.
 */
export function upsertEmbeddings(
  rows: { messageId: string; vector: number[] }[],
  model: string,
  handle?: Database,
): number {
  if (rows.length === 0) {
    return 0
  }
  const db = handle ?? getDb()
  const stmt = db.prepare(`
    INSERT INTO embeddings (messageId, model, dim, vector)
    VALUES ($messageId, $model, $dim, $vector)
    ON CONFLICT(messageId, model) DO UPDATE SET
      dim = excluded.dim,
      vector = excluded.vector;
  `)
  const upsertAll = db.transaction(
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
 * @param handle - Database handle to read from. Defaults to the shared index.
 * @returns Number of stored vectors for that model.
 */
export function getEmbeddingCount(model: string, handle?: Database): number {
  const db = handle ?? getDb()
  const row = db
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
 * @param limit - Maximum number of rows to return. The worker embeds in small
 *   idle batches, so it asks for one batch at a time instead of materialising
 *   the whole backlog on every tick.
 * @param handle - Database handle to read from. Defaults to the shared index.
 * @returns messageId + text for every indexed message missing a vector for that model.
 */
export function getMessagesMissingEmbedding(
  model: string,
  limit?: number,
  handle?: Database,
): { messageId: string; text: string }[] {
  const db = handle ?? getDb()
  const bounded = typeof limit === 'number' && limit > 0
  const sql = `
    SELECT m.messageId as messageId, m.text as text
    FROM messages m
    LEFT JOIN embeddings e ON e.messageId = m.messageId AND e.model = $model
    WHERE e.messageId IS NULL AND length(m.text) > 0
    ${bounded ? 'LIMIT $limit' : ''};
  `
  return db
    .prepare<{ messageId: string; text: string }>(sql)
    .all(bounded ? { $model: model, $limit: limit } : { $model: model })
}

/**
 * Newest indexed message time per chat — the watermark the incremental
 * capture compares LINE's per-chat activity against, so a chat that has not
 * moved since the last index is not re-fetched on every process start.
 *
 * @param handle - Database handle to read from. Defaults to the shared index.
 * @returns Map of chat MID to the newest indexed message time (epoch ms).
 */
export function getMaxIndexedMessageTimeByChat(
  handle?: Database,
): Map<string, number> {
  const db = handle ?? getDb()
  const rows = db
    .prepare<{ chatId: string; maxTime: number }>(`
    SELECT chatId as chatId, MAX(COALESCE(createdTime, 0)) as maxTime
    FROM messages
    GROUP BY chatId;
  `)
    .all()
  const result = new Map<string, number>()
  for (const row of rows) {
    result.set(row.chatId, Number(row.maxTime) || 0)
  }
  return result
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
function cosineSimilarity(a: Float32Array, b: ArrayLike<number>): number {
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

const SEMANTIC_SCAN_MAX = 20000
const SEMANTIC_SCORE_CHUNK = 2000

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
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
    WHERE e.model = $model
    ORDER BY m.createdTime DESC
    LIMIT $limit;
  `)
    .all({ $model: embedder.modelLabel, $limit: SEMANTIC_SCAN_MAX })

  const scored: SemanticSearchResult[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const { vector, ...result } = row
    const decoded = decodeVector(vector)
    if (decoded.length !== queryVector.length) {
      continue
    }
    scored.push({
      ...result,
      score: cosineSimilarity(decoded, queryVector),
    })
    if ((i + 1) % SEMANTIC_SCORE_CHUNK === 0 && i + 1 < rows.length) {
      await yieldToEventLoop()
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/**
 * One indexed message together with its stored embedding, decoded back into a
 * Float32Array. This is the raw material the insight layer (../insight) needs:
 * it clusters messages by cosine over these vectors plus their send times, so
 * unlike searchMessages/semanticSearch it hands back the vector itself rather
 * than a pre-ranked hit list.
 */
export interface MessageVectorRow {
  messageId: string
  chatId: string
  chatName: string | null
  fromMid: string | null
  fromName: string | null
  text: string
  createdTime: number
  vector: Float32Array
}

/**
 * Load every indexed message that has an embedding for `model`, newest-window
 * first bounded by `sinceMs`, with its vector decoded. Empty-text and
 * timestamp-less rows are excluded — clustering needs both a vector to compare
 * and a time to gate on, and a row missing either can only add noise.
 *
 * This is a full scan of the embedded corpus (personal-scale: thousands of
 * rows), left to the caller to cluster; the store deliberately holds no
 * opinion on thresholds or windowing beyond the `sinceMs` cutoff.
 *
 * @param model - Embedder.modelLabel whose vectors to load.
 * @param sinceMs - Optional lower bound on createdTime (epoch ms); omit for all.
 * @returns Messages with decoded vectors, oldest first.
 */
export function getMessagesWithVectors(
  model: string,
  sinceMs?: number,
): MessageVectorRow[] {
  const handle = getDb()
  const rows = handle
    .prepare<{
      messageId: string
      chatId: string
      chatName: string | null
      fromMid: string | null
      fromName: string | null
      text: string
      createdTime: number
      vector: Uint8Array
    }>(`
    SELECT m.messageId as messageId, m.chatId as chatId, m.chatName as chatName,
           m.fromMid as fromMid, m.fromName as fromName, m.text as text,
           m.createdTime as createdTime, e.vector as vector
    FROM embeddings e
    JOIN messages m ON m.messageId = e.messageId
    WHERE e.model = $model
      AND m.createdTime IS NOT NULL
      AND ($since IS NULL OR m.createdTime >= $since)
      AND length(m.text) > 0
    ORDER BY m.createdTime ASC;
  `)
    .all({ $model: model, $since: sinceMs ?? null })

  return rows.map((row) => {
    const { vector, ...rest } = row
    return { ...rest, vector: decodeVector(vector) }
  })
}

/**
 * Persist the current capture cursor, overwriting the single stored row.
 *
 * @param state - Capture cursor to persist.
 */
/**
 * A fact about a person, as stated by the account owner.
 */
export interface PersonaFactRecord {
  /** The person's LINE MID, when it is known. */
  subjectMid: string | null
  /** The person's name, as the owner wrote it. */
  subjectName: string
  /** The role word, e.g. "wife" or "finance". */
  term: string
  /** The role category the term belongs to. */
  category: string
  /** The owner's own sentence, verbatim. */
  evidence: string
  /** Whether the owner stated it outright, or a model named it. */
  origin: string
  /** How many independent instances back it. */
  instances: number
  /** Confidence in [0,1], as the namer assessed it. */
  confidence: number
}

/**
 * Store a stated fact about a person.
 *
 * The row is unique on (subjectName, term), so restating a fact updates the
 * evidence rather than piling up duplicates.
 *
 * @param fact - The fact to store.
 * @returns The row id of the stored fact.
 */
export function upsertPersonaFact(fact: PersonaFactRecord): number {
  const now = Date.now()
  const handle = getDb()
  handle
    .prepare(
      `INSERT INTO persona_facts (subjectMid, subjectName, term, category, evidence, origin, instances, confidence, createdAt)
     VALUES ($subjectMid, $subjectName, $term, $category, $evidence, $origin, $instances, $confidence, $createdAt)
     ON CONFLICT(subjectName, term) DO UPDATE SET
       subjectMid = excluded.subjectMid,
       category = excluded.category,
       evidence = excluded.evidence,
       origin = excluded.origin,
       instances = excluded.instances,
       confidence = excluded.confidence,
       createdAt = excluded.createdAt`,
    )
    .run({
      $subjectMid: fact.subjectMid,
      $subjectName: fact.subjectName,
      $term: fact.term,
      $category: fact.category,
      $evidence: fact.evidence,
      $origin: fact.origin,
      $instances: fact.instances,
      $confidence: fact.confidence,
      $createdAt: now,
    })
  const row = handle
    .prepare<{ id: number }>(
      'SELECT id FROM persona_facts WHERE subjectName = $subjectName AND term = $term',
    )
    .get({ $subjectName: fact.subjectName, $term: fact.term })
  return row?.id ?? 0
}

/**
 * Read every stated fact about people.
 *
 * @returns The stored facts, newest first.
 */
export function listPersonaFacts(): PersonaFactRecord[] {
  return getDb()
    .prepare<PersonaFactRecord>(
      `SELECT subjectMid, subjectName, term, category, evidence, origin, instances, confidence
       FROM persona_facts
       ORDER BY createdAt DESC;`,
    )
    .all()
}

/**
 * Remove a stated fact about a person.
 *
 * @param subjectName - The person's name, as it was stored.
 * @param term - The role word, as it was stored.
 * @returns The number of rows removed.
 */
export function deletePersonaFact(subjectName: string, term: string): number {
  const handle = getDb()
  const before = handle
    .prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM persona_facts WHERE subjectName = $subjectName AND term = $term',
    )
    .get({ $subjectName: subjectName, $term: term })
  handle
    .prepare(
      'DELETE FROM persona_facts WHERE subjectName = $subjectName AND term = $term',
    )
    .run({ $subjectName: subjectName, $term: term })
  return Number(before?.count ?? 0)
}

/**
 * The slice of the database handle the style-rule functions need.
 *
 * Taking the handle as an argument lets a test exercise the rules against a
 * throwaway database instead of the owner's own index.
 */
export interface StyleRuleHandle {
  prepare: <T = Record<string, unknown>>(
    sql: string,
  ) => {
    run: (params?: Record<string, unknown>) => unknown
    all: (params?: Record<string, unknown>) => T[]
    get: (params?: Record<string, unknown>) => T | undefined
  }
}

/** One style rule as stored in the `style_rules` table. */
export interface StyleRuleRecord {
  /** Stable identifier, so a later rule can supersede this one. */
  ruleId: string
  /** 'global' or 'chat'. */
  scope: string
  /** The conversation this rule is scoped to, when scope is 'chat'. */
  chatId: string | null
  /** The rule itself, in the writer's words. */
  statement: string
  /** When the rule applies. */
  appliesWhen: string | null
  /** When the rule does not apply. */
  doesNotApplyWhen: string | null
  /** The owner's own sentence the rule was read from, verbatim. */
  evidence: string
  /** A case where the rule does not hold, when one is known. */
  counterExample: string | null
  /** 'stated' when the owner said the rule outright, 'derived' otherwise. */
  origin: string
  /** Confidence in [0,1]. */
  confidence: number
  /** 'active' or 'superseded'. */
  status: string
  /** The rule this one replaces, when it replaces one. */
  supersedes: string | null
  /** When the rule was recorded. */
  createdAt: number
}

/**
 * Store a style rule.
 *
 * The row is unique on ruleId, so re-recording the same rule updates it in
 * place. A rule that supersedes another one marks the older row
 * 'superseded' rather than deleting it — the history stays readable.
 *
 * @param rule - The rule to store.
 * @returns The row id of the stored rule.
 */
export function upsertStyleRule(
  rule: StyleRuleRecord,
  handle: StyleRuleHandle = getDb(),
): number {
  const now = Date.now()
  handle
    .prepare(
      `INSERT INTO style_rules (ruleId, scope, chatId, statement, appliesWhen, doesNotApplyWhen, evidence, counterExample, origin, confidence, status, supersedes, createdAt)
     VALUES ($ruleId, $scope, $chatId, $statement, $appliesWhen, $doesNotApplyWhen, $evidence, $counterExample, $origin, $confidence, $status, $supersedes, $createdAt)
     ON CONFLICT(ruleId) DO UPDATE SET
       scope = excluded.scope,
       chatId = excluded.chatId,
       statement = excluded.statement,
       appliesWhen = excluded.appliesWhen,
       doesNotApplyWhen = excluded.doesNotApplyWhen,
       evidence = excluded.evidence,
       counterExample = excluded.counterExample,
       origin = excluded.origin,
       confidence = excluded.confidence,
       status = excluded.status,
       supersedes = excluded.supersedes,
       createdAt = excluded.createdAt`,
    )
    .run({
      $ruleId: rule.ruleId,
      $scope: rule.scope,
      $chatId: rule.chatId,
      $statement: rule.statement,
      $appliesWhen: rule.appliesWhen,
      $doesNotApplyWhen: rule.doesNotApplyWhen,
      $evidence: rule.evidence,
      $counterExample: rule.counterExample,
      $origin: rule.origin,
      $confidence: rule.confidence,
      $status: rule.status,
      $supersedes: rule.supersedes,
      $createdAt: now,
    })
  if (rule.supersedes) {
    handle
      .prepare(
        `UPDATE style_rules SET status = 'superseded' WHERE ruleId = $supersedes`,
      )
      .run({ $supersedes: rule.supersedes })
  }
  const row = handle
    .prepare<{ id: number }>(
      'SELECT id FROM style_rules WHERE ruleId = $ruleId',
    )
    .get({ $ruleId: rule.ruleId })
  return row?.id ?? 0
}

/**
 * Read the style rules.
 *
 * Superseded rules are excluded unless asked for: they stay in the table so
 * the history of what was believed is still readable, but a reader wants the
 * rules in force.
 *
 * @param options - Which rules to read.
 * @returns The matching rules, newest first.
 */
export function listStyleRules(
  options: { includeSuperseded?: boolean; chatId?: string } = {},
  handle: StyleRuleHandle = getDb(),
): StyleRuleRecord[] {
  if (options.chatId) {
    return handle
      .prepare<StyleRuleRecord>(
        `SELECT ruleId, scope, chatId, statement, appliesWhen, doesNotApplyWhen, evidence, counterExample, origin, confidence, status, supersedes, createdAt
         FROM style_rules
         WHERE (scope = 'global' OR chatId = $chatId)
           AND ($includeSuperseded = 1 OR status = 'active')
         ORDER BY createdAt DESC;`,
      )
      .all({
        $chatId: options.chatId,
        $includeSuperseded: options.includeSuperseded ? 1 : 0,
      })
  }
  return handle
    .prepare<StyleRuleRecord>(
      `SELECT ruleId, scope, chatId, statement, appliesWhen, doesNotApplyWhen, evidence, counterExample, origin, confidence, status, supersedes, createdAt
       FROM style_rules
       WHERE ($includeSuperseded = 1 OR status = 'active')
       ORDER BY createdAt DESC;`,
    )
    .all({ $includeSuperseded: options.includeSuperseded ? 1 : 0 })
}

/** One piece of evidence as stored in the `persona_evidence` table. */
export interface PersonaEvidenceRecord {
  mid: string
  name: string | null
  kind: string
  form: string | null
  text: string
  occurrences: number
  chatId: string | null
  chatName: string | null
  derivedAt: number
}

/** One person as stored in the `persona_nodes` table. */
export interface PersonaNodeRecord {
  mid: string
  name: string | null
  /** JSON array of address forms. */
  addresses: string | null
  /** JSON array of role summaries. */
  summary: string | null
  derivedAt: number
}

/**
 * Replace the derived evidence wholesale.
 *
 * The derivation always runs over the whole corpus, so its output replaces
 * the previous output: evidence that is no longer supported disappears
 * instead of lingering as a stale claim.
 *
 * @param evidence - The derived evidence.
 * @param nodes - The derived personas.
 * @param messageCount - How many messages the derivation read.
 */
export function replacePersonaEvidence(
  evidence: PersonaEvidenceRecord[],
  nodes: PersonaNodeRecord[],
  messageCount: number,
): void {
  const handle = getDb()
  const now = Date.now()
  handle.exec('DELETE FROM persona_evidence;')
  handle.exec('DELETE FROM persona_nodes;')
  const insertEvidence = handle.prepare(
    `INSERT INTO persona_evidence (mid, name, kind, form, text, occurrences, chatId, chatName, derivedAt)
     VALUES ($mid, $name, $kind, $form, $text, $occurrences, $chatId, $chatName, $derivedAt)`,
  )
  for (const item of evidence) {
    insertEvidence.run({
      $mid: item.mid,
      $name: item.name,
      $kind: item.kind,
      $form: item.form,
      $text: item.text,
      $occurrences: item.occurrences,
      $chatId: item.chatId,
      $chatName: item.chatName,
      $derivedAt: now,
    })
  }
  const insertNode = handle.prepare(
    `INSERT INTO persona_nodes (mid, name, addresses, summary, derivedAt)
     VALUES ($mid, $name, $addresses, $summary, $derivedAt)`,
  )
  for (const node of nodes) {
    insertNode.run({
      $mid: node.mid,
      $name: node.name,
      $addresses: node.addresses,
      $summary: node.summary,
      $derivedAt: now,
    })
  }
  writePersonaState(handle, {
    derivedAt: now,
    messageCount,
    roleCount: evidence.length,
  })
}

/**
 * Record when the derivation ran and how much it read.
 *
 * The write uses named parameters on purpose. The runtime wrapper drops the
 * second argument of `exec` under bun, so `exec(sql, [params])` silently
 * binds nothing and writes NULLs — the row would exist and claim that
 * nothing was ever derived. A handle is taken as an argument so this can be
 * exercised against a throwaway database instead of the user's own index.
 *
 * @param handle - The database handle to write to.
 * @param state - When the derivation ran, and how much it read.
 */
export function writePersonaState(
  handle: Pick<Database, 'prepare'>,
  state: { derivedAt: number; messageCount: number; roleCount: number },
): void {
  handle
    .prepare(
      `INSERT INTO persona_state (id, derivedAt, messageCount, roleCount)
     VALUES (1, $derivedAt, $messageCount, $roleCount)
     ON CONFLICT(id) DO UPDATE SET
       derivedAt = excluded.derivedAt,
       messageCount = excluded.messageCount,
       roleCount = excluded.roleCount`,
    )
    .run({
      $derivedAt: state.derivedAt,
      $messageCount: state.messageCount,
      $roleCount: state.roleCount,
    })
}

/**
 * Read every piece of derived evidence.
 *
 * @returns The evidence, most substantial first.
 */
export function listPersonaEvidence(): PersonaEvidenceRecord[] {
  return getDb()
    .prepare<PersonaEvidenceRecord>(
      `SELECT mid, name, kind, form, text, occurrences, chatId, chatName, derivedAt
       FROM persona_evidence
       ORDER BY occurrences DESC, mid;`,
    )
    .all()
}

/**
 * Read every derived persona.
 *
 * @returns The personas, by MID.
 */
export function listPersonaNodes(): PersonaNodeRecord[] {
  return getDb()
    .prepare<PersonaNodeRecord>(
      `SELECT mid, name, addresses, summary, derivedAt
       FROM persona_nodes
       ORDER BY derivedAt DESC;`,
    )
    .all()
}

/**
 * Read when the derivation last ran.
 *
 * @returns The derivation state, or null when it never ran.
 */
export function getPersonaState(): {
  derivedAt: number | null
  messageCount: number
  roleCount: number
} | null {
  const row = getDb()
    .prepare<{
      derivedAt: number | null
      messageCount: number | null
      roleCount: number | null
    }>(
      'SELECT derivedAt, messageCount, roleCount FROM persona_state WHERE id = 1;',
    )
    .get()
  if (!row) {
    return null
  }
  return {
    derivedAt: row.derivedAt ?? null,
    messageCount: Number(row.messageCount ?? 0),
    roleCount: Number(row.roleCount ?? 0),
  }
}

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
