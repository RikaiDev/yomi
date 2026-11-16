import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writePersonaState } from './store.js'

/**
 * The persona state row records when the derivation ran and how much it
 * read, so a caller can tell a fresh graph from a stale one.
 *
 * The write has to use named parameters. The runtime-agnostic SQLite wrapper
 * (./sqlite.ts) drops the second argument of `exec` under bun, so
 * `exec(sql, [params])` silently binds nothing and writes NULLs — the row
 * exists and claims that nothing was ever derived. The failure is invisible
 * at the call site, so it is pinned here.
 *
 * The test uses its own database file and its own handle rather than the
 * module-level connection: the store's handle is cached for the life of the
 * process, and bun runs every test file in one process, so reaching for
 * `getDb()` would write into whatever database the real index lives in.
 */

const dir = mkdtempSync(join(tmpdir(), 'yomi-persona-store-'))
const raw = new Database(join(dir, 'persona-test.db'))
raw.exec(`
  CREATE TABLE persona_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    derivedAt INTEGER,
    messageCount INTEGER,
    roleCount INTEGER
  );
`)

/** The slice of the store's handle this function needs. */
const handle = {
  prepare: (sql: string) => ({
    run: (params: Record<string, unknown>) => raw.query(sql).run(params),
  }),
}

test('the state row records when the derivation ran and how much it read', () => {
  writePersonaState(handle, {
    derivedAt: 1_700_000_000_000,
    messageCount: 1234,
    roleCount: 1,
  })
  const row = raw.query('SELECT * FROM persona_state WHERE id = 1').get() as any
  expect(row.derivedAt).toBe(1_700_000_000_000)
  expect(row.messageCount).toBe(1234)
  expect(row.roleCount).toBe(1)
})

test('the state row is updated, not duplicated, on a second pass', () => {
  writePersonaState(handle, {
    derivedAt: 1_700_000_000_001,
    messageCount: 99,
    roleCount: 0,
  })
  const rows = raw.query('SELECT * FROM persona_state').all() as any[]
  expect(rows.length).toBe(1)
  expect(rows[0].messageCount).toBe(99)
  expect(rows[0].roleCount).toBe(0)
})

test('the state row is never left holding NULLs', () => {
  const row = raw.query('SELECT * FROM persona_state WHERE id = 1').get() as any
  expect(row.derivedAt).not.toBeNull()
  expect(row.messageCount).not.toBeNull()
  expect(row.roleCount).not.toBeNull()
})

afterAll(() => {
  raw.close()
  rmSync(dir, { recursive: true, force: true })
})
