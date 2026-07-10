/**
 * Yomi conversation scoping — a DENYLIST of chats excluded from capture.
 *
 * Default behavior is capture-everything: every conversation is indexed by
 * ../search/collector.ts unless its chatId appears in the `excluded_chats`
 * table this module owns. Excluding a chat does two things, not one:
 *   1. Blocks future capture — collectMessages drops excluded chatIds
 *      before fetching (see ../search/collector.ts).
 *   2. Purges past capture — deleteMessagesForChats removes that chat's
 *      already-indexed messages AND their embeddings, so excluding a
 *      conversation actually removes what was already learned about it
 *      rather than just freezing the index in place. A denylist that only
 *      blocked future capture while leaving old data behind would be fake
 *      privacy.
 *
 * Shares the same bun:sqlite connection as ../search/store.ts via the
 * exported getDb(), so this table lives in the same search-index.db file
 * rather than a second database.
 */

import { getDb } from './store.js';

let tableEnsured = false;

/**
 * Create the `excluded_chats` table if it does not already exist. Memoized
 * per process (mirrors getDb()'s own memoization) so every public function
 * in this module can safely call it without repeating the DDL on every
 * invocation.
 */
function ensureExcludedTable(): void {
  if (tableEnsured) {
    return;
  }
  const handle = getDb();
  handle.run(`
    CREATE TABLE IF NOT EXISTS excluded_chats (
      chatId TEXT PRIMARY KEY NOT NULL
    );
  `);
  tableEnsured = true;
}

/**
 * Build a `(?, ?, ...)` placeholder group sized to `values.length`, for use
 * in an `IN (...)` clause. Callers must pass `values` itself (in the same
 * order) as the bound parameters — this never string-interpolates the
 * values themselves, only the `?` count.
 *
 * @param values - Values the IN-clause will be matched against.
 * @returns Placeholder group, e.g. `(?, ?, ?)`.
 */
function buildPlaceholders(values: unknown[]): string {
  return `(${values.map(() => '?').join(', ')})`;
}

/**
 * List every chatId currently on the exclusion denylist.
 *
 * @returns Set of excluded chatIds (empty when the denylist is empty).
 */
export function getExcludedChatIds(): Set<string> {
  ensureExcludedTable();
  const handle = getDb();
  const rows = handle.query('SELECT chatId FROM excluded_chats;').all() as { chatId: string }[];
  return new Set(rows.map(row => row.chatId));
}

/**
 * Add chatIds to the exclusion denylist. Idempotent: chatIds already
 * present are silently skipped (INSERT OR IGNORE), never duplicated or
 * erroring.
 *
 * @param chatIds - Chat MIDs to exclude from future capture.
 * @returns Number of chatIds now covered by this call (rows inserted or
 *   already present among the input).
 */
export function addExcludedChatIds(chatIds: string[]): number {
  if (chatIds.length === 0) {
    return 0;
  }
  ensureExcludedTable();
  const handle = getDb();
  const stmt = handle.prepare('INSERT OR IGNORE INTO excluded_chats (chatId) VALUES (?);');
  const insertAll = handle.transaction((ids: string[]) => {
    for (const id of ids) {
      stmt.run(id);
    }
  });
  insertAll(chatIds);
  return chatIds.length;
}

/**
 * Remove chatIds from the exclusion denylist, re-allowing future capture.
 * Does NOT re-fetch or re-index anything that was previously purged — the
 * next `collect_messages`/`search_messages` auto-collect will pick the
 * chat back up.
 *
 * @param chatIds - Chat MIDs to remove from the denylist.
 * @returns Number of rows actually removed.
 */
export function removeExcludedChatIds(chatIds: string[]): number {
  if (chatIds.length === 0) {
    return 0;
  }
  ensureExcludedTable();
  const handle = getDb();
  const placeholders = buildPlaceholders(chatIds);
  const result = handle.run(`DELETE FROM excluded_chats WHERE chatId IN ${placeholders};`, chatIds);
  return result.changes;
}

/**
 * Purge already-indexed data for the given chats: their embeddings, then
 * their messages, in one transaction. This is what makes exclusion an
 * actual privacy action rather than just a future-capture filter — a chat
 * that gets excluded loses what was already learned about it, not just
 * what would have been learned next. The `messages_fts` external-content
 * index stays in sync automatically via the AFTER DELETE trigger on
 * `messages` (see ../search/store.ts), so it is never touched directly
 * here.
 *
 * @param chatIds - Chat MIDs whose indexed messages + embeddings should be deleted.
 * @returns Number of `messages` rows deleted.
 */
export function deleteMessagesForChats(chatIds: string[]): number {
  if (chatIds.length === 0) {
    return 0;
  }
  const handle = getDb();
  const placeholders = buildPlaceholders(chatIds);
  const purge = handle.transaction((ids: string[]) => {
    // Count the target rows FIRST: the DELETE's own `.changes` on `messages`
    // is inflated by the AFTER DELETE trigger that maintains messages_fts
    // (one fts write per deleted row), so it cannot serve as the purged
    // count. An explicit COUNT is trigger-independent and honest.
    const counted = handle.query(
      `SELECT COUNT(*) as c FROM messages WHERE chatId IN ${placeholders};`,
    ).get(...ids) as { c: number } | null;
    handle.run(
      `DELETE FROM embeddings WHERE messageId IN (SELECT messageId FROM messages WHERE chatId IN ${placeholders});`,
      ids,
    );
    handle.run(`DELETE FROM messages WHERE chatId IN ${placeholders};`, ids);
    return counted?.c ?? 0;
  });
  return purge(chatIds);
}
