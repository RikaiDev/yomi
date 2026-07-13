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

import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'

const isBun = typeof process.versions.bun !== 'undefined'

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

/**
 * Open a SQLite database at the given path. Creates the file if it doesn't exist.
 */
export function openDatabase(path: string): Database {
  if (isBun) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('bun:sqlite')
    return wrapBunDb(new mod.Database(path))
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('node:sqlite')
    return wrapNodeDb(new mod.DatabaseSync(path))
  }
}
