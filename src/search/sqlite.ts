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

interface Statement<T = Record<string, unknown>> {
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

/**
 * Node versions carrying an unflagged `node:sqlite`.
 *
 * It was unflagged in 22.13.0 and 23.4.0 (nodejs/node#55890), so the 23 line
 * splits: 23.0–23.3 are NEWER than 22.13 yet still lack it, which a plain
 * `>=22.13.0` floor would wrongly admit. Keep this in step with
 * package.json's `engines.node`.
 */
const NODE_SQLITE_REQUIREMENT = '22.13+ (or 23.4+ on the 23.x line)'

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
    // Runtimes without it throw "No such built-in module: node:sqlite", which
    // tells a user nothing about what to change. `engines` does not help: npm
    // only warns at install time, and npx ignores it entirely.
    //
    // The trap worth naming is that the node running this is often not the one
    // the user configured. An MCP client launches the server through `npx`,
    // whose `#!/usr/bin/env node` resolves against the CLIENT's PATH — so the
    // runtime can be any node on that PATH regardless of which npx was named.
    // Report the actual execPath rather than assume the user can guess it.
    throw new SqliteUnavailableError(
      `This Node cannot open Yomi's message index: ${process.version} has no built-in \`node:sqlite\` (needs ${NODE_SQLITE_REQUIREMENT}). ` +
        `Live tools still work; search, scope and capture do not. ` +
        `The runtime is ${process.execPath} — an MCP client resolves \`node\` from its own PATH, so this may not be the node you expect. ` +
        `Point the client at a supported node and restart it. ` +
        `Original error: ${error?.message ?? String(error)}`,
    )
  }
  return wrapNodeDb(new mod.DatabaseSync(path))
}
