import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listStyleRules, upsertStyleRule } from './store.js'
import {
  extractVocabulary,
  getChatVocabulary,
  getStyleEvidence,
} from './style-rules.js'

/**
 * Style rules are judgements, not measurements, and they are stored with the
 * sentence they were read from plus the situation they do not apply to.
 *
 * A rule that replaces another must not erase it: the old rule stays in the
 * table as superseded, so the history of what was believed stays readable.
 *
 * The test uses its own database file rather than `getDb()`: the store's
 * handle is cached for the life of the process and bun runs every test file
 * in one process, so reaching for the module-level connection would write
 * into the owner's real index.
 */

const dir = mkdtempSync(join(tmpdir(), 'yomi-style-rules-'))
const raw = new Database(join(dir, 'style-rules-test.db'))
raw.exec(`
  CREATE TABLE style_rules (
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

const handle = {
  prepare: (sql: string) => ({
    run: (params?: Record<string, unknown>) => raw.query(sql).run(params),
    all: (params?: Record<string, unknown>) => raw.query(sql).all(params),
    get: (params?: Record<string, unknown>) => raw.query(sql).get(params),
  }),
}

/** A second database with a messages table, for the evidence readers. */
const messagesDir = mkdtempSync(join(tmpdir(), 'yomi-style-messages-'))
const messagesRaw = new Database(join(messagesDir, 'messages-test.db'))
messagesRaw.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    messageId TEXT UNIQUE NOT NULL,
    chatId TEXT NOT NULL,
    chatName TEXT,
    fromMid TEXT,
    fromName TEXT,
    text TEXT,
    createdTime INTEGER,
    contentType INTEGER DEFAULT 0
  );
`)
const messagesHandle = {
  prepare: (sql: string) => ({
    run: (params?: Record<string, unknown>) =>
      messagesRaw.query(sql).run(params),
    all: (params?: Record<string, unknown>) =>
      messagesRaw.query(sql).all(params),
    get: (params?: Record<string, unknown>) =>
      messagesRaw.query(sql).get(params),
  }),
}

function insertMessage(row: {
  messageId: string
  chatId: string
  chatName?: string
  fromMid: string
  fromName?: string
  text: string
  createdTime: number
}) {
  messagesRaw
    .query(
      `INSERT INTO messages (messageId, chatId, chatName, fromMid, fromName, text, createdTime, contentType)
       VALUES ($messageId, $chatId, $chatName, $fromMid, $fromName, $text, $createdTime, 0);`,
    )
    .run({
      $messageId: row.messageId,
      $chatId: row.chatId,
      $chatName: row.chatName ?? null,
      $fromMid: row.fromMid,
      $fromName: row.fromName ?? null,
      $text: row.text,
      $createdTime: row.createdTime,
    })
}

const OWNER = 'u-owner'
insertMessage({
  messageId: 'm1',
  chatId: 'u-pharmacist',
  chatName: 'pharmacist',
  fromMid: 'u-them',
  fromName: 'Lin',
  text: '請問收據寄出了嗎？',
  createdTime: 100,
})
insertMessage({
  messageId: 'm2',
  chatId: 'u-pharmacist',
  chatName: 'pharmacist',
  fromMid: OWNER,
  text: '瑋易的發票昨天用快捷寄出，今天應該就會收到了。',
  createdTime: 200,
})

afterAll(() => {
  raw.close()
  messagesRaw.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(messagesDir, { recursive: true, force: true })
})

function rule(overrides: Partial<Parameters<typeof upsertStyleRule>[0]> = {}) {
  return {
    ruleId: 'rule-1',
    scope: 'global',
    chatId: null,
    statement: '對方沒提過的公司名不要寫進訊息',
    appliesWhen: '與未參與該案的承作方往來時',
    doesNotApplyWhen: '對方是公司成員本人時',
    evidence: '我直接一次開20w全部嗎？',
    counterExample: null,
    origin: 'derived',
    confidence: 0.8,
    status: 'active',
    supersedes: null,
    createdAt: Date.now(),
    ...overrides,
  }
}

test('a rule keeps its evidence, its limits and its confidence', () => {
  upsertStyleRule(rule(), handle)
  const [stored] = listStyleRules({}, handle)
  expect(stored.ruleId).toBe('rule-1')
  expect(stored.evidence).toBe('我直接一次開20w全部嗎？')
  expect(stored.appliesWhen).toBe('與未參與該案的承作方往來時')
  expect(stored.doesNotApplyWhen).toBe('對方是公司成員本人時')
  expect(stored.confidence).toBe(0.8)
  expect(stored.status).toBe('active')
})

test('re-recording the same rule id updates it instead of piling up', () => {
  upsertStyleRule(rule({ statement: '改寫後的規則' }), handle)
  const rules = listStyleRules({}, handle)
  expect(rules.length).toBe(1)
  expect(rules[0].statement).toBe('改寫後的規則')
})

test('a superseding rule retires the old one without erasing it', () => {
  upsertStyleRule(
    rule({
      ruleId: 'rule-2',
      statement: '公司名可以寫，但要先解釋是誰',
      supersedes: 'rule-1',
    }),
    handle,
  )
  const active = listStyleRules({}, handle)
  expect(active.map((r) => r.ruleId)).toEqual(['rule-2'])
  const history = listStyleRules({ includeSuperseded: true }, handle)
  const retired = history.find((r) => r.ruleId === 'rule-1')
  expect(retired?.status).toBe('superseded')
  expect(retired?.statement).toBe('改寫後的規則')
})

test('a chat-scoped rule is only returned for that conversation', () => {
  upsertStyleRule(
    rule({
      ruleId: 'rule-3',
      scope: 'chat',
      chatId: 'u-vendor',
      statement: '催發票時先講對方的時程',
    }),
    handle,
  )
  const forChat = listStyleRules({ chatId: 'u-vendor' }, handle)
  expect(forChat.map((r) => r.ruleId)).toContain('rule-3')
  const forOther = listStyleRules({ chatId: 'u-other' }, handle)
  expect(forOther.map((r) => r.ruleId)).not.toContain('rule-3')
})

test('a term both sides used is known; a term only the owner used is not', () => {
  const vocabulary = extractVocabulary(
    [
      '林藥師好，瑋易的發票昨天用快捷寄出，今天應該就會收到了。',
      '瑋易這邊的發票昨天用快捷寄出，影路人的發票還要等下週。',
    ],
    ['不好意思，請問收據寄出了嗎？', '院方那邊一直在等影路人的發票。'],
  )
  const known = vocabulary.knownTerms.map((t) => t.term)
  const unconfirmed = vocabulary.unconfirmedTerms.map((t) => t.term)
  expect(known).toContain('影路人')
  expect(unconfirmed).toContain('瑋易')
  expect(unconfirmed).not.toContain('影路人')
})

test("evidence quotes the owner's own message with the message it answered", () => {
  const quotes = getStyleEvidence(OWNER, 'u-pharmacist', 10, messagesHandle)
  expect(quotes.length).toBe(1)
  const [quote] = quotes
  expect(quote.text).toBe('瑋易的發票昨天用快捷寄出，今天應該就會收到了。')
  expect(quote.situation).toBe('請問收據寄出了嗎？')
  expect(quote.counterpartName).toBe('Lin')
})

test("evidence across conversations is the owner's own messages, not the newest ones", () => {
  insertMessage({
    messageId: 'm3',
    chatId: 'u-other',
    chatName: 'other',
    fromMid: 'u-them',
    fromName: 'Someone',
    text: '跟我無關的一則很新的訊息',
    createdTime: 900,
  })
  const quotes = getStyleEvidence(OWNER, undefined, 10, messagesHandle)
  expect(quotes.every((q) => q.text.startsWith('瑋易的發票'))).toBe(true)
  expect(quotes.some((q) => q.text.includes('跟我無關'))).toBe(false)
})

test('vocabulary names the counterpart and what only the owner has said', () => {
  const [vocabulary] = getChatVocabulary(
    OWNER,
    'u-pharmacist',
    5,
    messagesHandle,
  )
  expect(vocabulary.counterpartName).toBe('Lin')
  const known = vocabulary.knownTerms.map((t) => t.term)
  const unconfirmed = vocabulary.unconfirmedTerms.map((t) => t.term)
  // Both sides wrote about sending it; only the owner named their company.
  expect(known).toContain('寄出')
  expect(known).not.toContain('瑋易')
  expect(unconfirmed).toContain('瑋易')
})
