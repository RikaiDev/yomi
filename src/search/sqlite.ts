/**
 * Runtime-agnostic SQLite wrapper — uses bun:sqlite in bun, node:sqlite in node.
 *
 * The APIs differ:
 *   - bun: Database  → .run(sql, params?)  .query(sql).get(params?)  .query(sql).all(params?)  .transaction(fn)
 *   - node: DatabaseSync → .exec(sql)  .prepare(sql).get(params?)  .prepare(sql).all(params?)  (no .transaction)
 *
 * This module exports a unified `Database` class that normalizes both to the
 * same surface, so the rest of the codebase never cares which runtime it's on.
 */

import { createRequire } from 'node:module'
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'

const isBun = typeof process.versions.bun !== 'undefined'

// The sqlite binding has to be picked at runtime, not import time: `bun:sqlite`
// does not exist under node and vice versa, so a static import would fail on
// whichever runtime is not running. That means a require — but this package is
// `"type": "module"`, and a bare `require` in ESM only works because bun allows
// it as an extension. Under node it is a ReferenceError, which is why every
// index-backed tool (search, scope, capture, policy) died with
// "require is not defined" once the server ran on node rather than bun.
// createRequire gives ESM a real require that both runtimes honor.
const runtimeRequire = createRequire(import.meta.url)

export interface Statement<T = Record<string, unknown>> {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): T | undefined
  all(...params: unknown[]): T[]
}

export interface Database {
  exec(sql: string, params?: unknown[]): void
  prepare<T = Record<string, unknown>>(sql: string): Statement<T>
  /** Preserve the caller's function signature — no `unknown` narrowing loss. */
  transaction<F extends (...args: never[]) => unknown>(fn: F): F
  close(): void
}

interface BunDatabase {
  run(
    sql: string,
    params?: unknown[],
  ): { changes: number; lastInsertRowid: number }
  query<T = unknown>(
    sql: string,
  ): {
    get(...params: unknown[]): T | undefined
    all(...params: unknown[]): T[]
  }
  transaction<F extends (...args: never[]) => unknown>(fn: F): F
  close(): void
}

function wrapBunDb(raw: BunDatabase): Database {
  return {
    exec(sql: string) {
      raw.run(sql)
    },
    prepare<T = Record<string, unknown>>(sql: string): Statement<T> {
      const q = raw.query<T>(sql)
      return {
        run(...params: unknown[]) {
          return q.get(...params)
        },
        get(...params: unknown[]) {
          return q.get(...params) as T | undefined
        },
        all(...params: unknown[]) {
          return q.all(...params)
        },
      }
    },
    transaction: raw.transaction.bind(raw) as Database['transaction'],
    close() {
      raw.close()
    },
  }
}

function wrapNodeDb(raw: NodeDatabaseSync): Database {
  return {
    exec(sql: string, params?: unknown[]) {
      if (params && params.length > 0) {
        const stmt = raw.prepare(sql)
        stmt.run(...(params as [any, ...any[]]))
      } else {
        raw.exec(sql)
      }
    },
    prepare<T = Record<string, unknown>>(sql: string): Statement<T> {
      const stmt = raw.prepare(sql)
      return {
        run(...params: unknown[]) {
          return stmt.run(...(params as [any, ...any[]]))
        },
        get(...params: unknown[]) {
          return stmt.get(...(params as [any, ...any[]])) as T | undefined
        },
        all(...params: unknown[]) {
          return stmt.all(...(params as [any, ...any[]])) as T[]
        },
      }
    },
    transaction<F extends (...args: never[]) => unknown>(fn: F): F {
      const wrapped = (...args: never[]) => {
        raw.exec('BEGIN')
        try {
          const result = fn(...args)
          raw.exec('COMMIT')
          return result
        } catch (e) {
          raw.exec('ROLLBACK')
          throw e
        }
      }
      return wrapped as F
    },
    close() {
      raw.close()
    },
  }
}

/** Lowest Node with an unflagged `node:sqlite` that this project has verified. */
const MIN_NODE_FOR_SQLITE = '22.15.0'

/** Thrown when the running runtime has no SQLite module at all. */
export class SqliteUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SqliteUnavailableError'
  }
}

/**
 * Open a SQLite database at the given path. Creates the file if it doesn't exist.
 *
 * @param path - Database file path.
 * @returns Runtime-agnostic database handle.
 * @throws SqliteUnavailableError when the runtime predates `node:sqlite`.
 */
export function openDatabase(path: string): Database {
  if (isBun) {
    const mod = runtimeRequire('bun:sqlite')
    return wrapBunDb(new mod.Database(path))
  }
  let mod: any
  try {
    mod = runtimeRequire('node:sqlite')
  } catch (error: any) {
    // `node:sqlite` landed unflagged in Node 22.x; older runtimes throw
    // "No such built-in module: node:sqlite", which tells a user nothing about
    // what to do. The `engines` field cannot help here — it warns at install
    // time and npx ignores it — and the node running us is often not the one a
    // user would guess: Claude Desktop resolves `npx`'s `#!/usr/bin/env node`
    // against its own PATH, which can pick an old nvm version regardless of
    // which npx was configured. So say which node is actually running, and what
    // it needs to be.
    throw new SqliteUnavailableError(
      `This Node cannot open Yomi's message index: ${process.version} has no built-in \`node:sqlite\` (needs >= v${MIN_NODE_FOR_SQLITE}). ` +
        `Live tools still work; search, scope and capture do not. ` +
        `The runtime is ${process.execPath} — note that an MCP client resolves \`node\` from its own PATH, so this may not be the node you expect. ` +
        `Point the client at a newer node (e.g. set the server's PATH so a >= v${MIN_NODE_FOR_SQLITE} node comes first), then restart it. ` +
        `Original error: ${error?.message ?? String(error)}`,
    )
  }
  return wrapNodeDb(new mod.DatabaseSync(path))
}
