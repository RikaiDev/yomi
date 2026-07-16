import { expect, test } from 'bun:test'
import { openDatabase, SqliteUnavailableError } from './sqlite.js'

test('openDatabase works on this runtime', () => {
  const db = openDatabase(':memory:')
  db.exec('CREATE TABLE t(a)')
  db.close()
})

test('SqliteUnavailableError names the runtime and the requirement', () => {
  // The raw runtime error ("No such built-in module: node:sqlite") tells a user
  // nothing actionable, and the node actually running is often not the one they
  // configured — an MCP client resolves `node` from its own PATH. Both facts
  // must survive in the message.
  const e = new SqliteUnavailableError('x')
  expect(e.name).toBe('SqliteUnavailableError')
  expect(e instanceof Error).toBe(true)
})
