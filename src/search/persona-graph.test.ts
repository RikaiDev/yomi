import { expect, test } from 'bun:test'
import { collectEvidence } from './persona-evidence.js'
import {
  buildPersonaGraph,
  type PersonaFact,
  type PersonaRow,
} from './persona-graph.js'

const SELF = 'u_self'

function row(
  chatId: string,
  fromMid: string,
  fromName: string | null,
  text: string,
  createdTime = 1_700_000_000_000,
): PersonaRow {
  return {
    chatId,
    chatName: `chat-${chatId}`,
    fromMid,
    fromName,
    text,
    createdTime,
  }
}

const SAMPLE: PersonaRow[] = [
  row('c1', 'u_partner', '宜君', '收到，我晚點看。'),
  row(
    'c1',
    SELF,
    '鄭富源',
    '宜君，開好後再麻煩你寄出來，核銷的部分要用。',
    1_700_000_001_000,
  ),
  row('c1', 'u_partner', '宜君', '好喔，謝謝。', 1_700_000_002_000),
  row('c2', 'u_pharmacist', '林家薐', '林藥師午安，麻煩你核銷單。'),
  row(
    'c2',
    SELF,
    '鄭富源',
    '林藥師好，麻煩再幫我確認一下這份報價單。',
    1_700_000_004_000,
  ),
  row('c3', 'u_other', '王小明', '今天天氣不錯。', 1_700_000_005_000),
]

test('the address form you use is reported verbatim, with its count', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  const pharmacist = graph.people.find((p) => p.mid === 'u_pharmacist')
  const address = pharmacist?.evidence.find((e) => e.kind === 'address')
  expect(address?.form).toBe('林藥師好')
  expect(address?.occurrences).toBeGreaterThan(0)
  // The evidence is quoted, so a reader can check it.
  expect(address?.text).toContain('林藥師好')
})

test('a form that recurs is a form; a one-off head is not treated as one', () => {
  const rows = [
    row('c4', 'u_a', '甲', '嗨'),
    row('c4', SELF, '鄭富源', '甲，你好，麻煩你了。', 1),
    row('c4', SELF, '鄭富源', '甲，你好，麻煩你了。', 2),
  ]
  const evidence = collectEvidence(rows as any, SELF)
  const forms = evidence.filter((e) => e.kind === 'address')
  expect(forms.length).toBe(1)
  expect(forms[0].occurrences).toBe(2)
})

test('the delegated work is quoted, so it can be read as evidence', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  const partner = graph.people.find((p) => p.mid === 'u_partner')
  const request = partner?.evidence.find((e) => e.kind === 'request')
  expect(request?.text).toContain('核銷')
})

test('a person you never address gets no address evidence', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  const other = graph.people.find((p) => p.mid === 'u_other')
  // Their own line is still evidence of them, but you never addressed them,
  // so there is no address form to report.
  expect(other?.evidence.filter((e) => e.kind === 'address').length ?? 0).toBe(
    0,
  )
})

test('every piece of evidence carries its source', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  for (const person of graph.people) {
    for (const item of person.evidence) {
      expect(item.text.length).toBeGreaterThan(0)
      expect(item.source.chatId.length).toBeGreaterThan(0)
    }
  }
})

test('yomi names no role on its own', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  for (const person of graph.people) {
    expect(person.roles.length).toBe(0)
  }
})

test('a role a reader named is reported with the sentence it rests on', () => {
  const facts: PersonaFact[] = [
    {
      subjectMid: 'u_pharmacist',
      subjectName: '林家薐',
      term: 'hospital pharmacist',
      category: 'professional',
      evidence: '林藥師好，麻煩再幫我確認一下這份報價單。',
      origin: 'named',
      instances: 2,
      confidence: 0.8,
    },
  ]
  const graph = buildPersonaGraph(SAMPLE, SELF, facts)
  const pharmacist = graph.people.find((p) => p.mid === 'u_pharmacist')
  expect(pharmacist?.roles.length).toBe(1)
  expect(pharmacist?.roles[0].term).toBe('hospital pharmacist')
  expect(pharmacist?.roles[0].origin).toBe('named')
  expect(pharmacist?.roles[0].evidence).toContain('林藥師好')
  expect(graph.method.namedRoles).toBe(1)
})

test('a role stated by the owner is marked as such', () => {
  const facts: PersonaFact[] = [
    {
      subjectMid: null,
      subjectName: '宜君',
      term: 'wife',
      category: 'family',
      evidence: '宜君是我太太。',
      origin: 'stated',
      instances: 1,
      confidence: 1,
    },
  ]
  const graph = buildPersonaGraph(SAMPLE, SELF, facts)
  const partner = graph.people.find((p) => p.name === '宜君')
  expect(partner?.roles[0].origin).toBe('stated')
  expect(partner?.roles[0].confidence).toBe(1)
})

test('the graph says out loud that it does not name roles itself', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  const note = graph.guide.find((line) => line.includes('add_persona_fact'))
  expect(note).toBeDefined()
})

test('conversations report both directions and the reply rhythm', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  const partner = graph.people.find((p) => p.mid === 'u_partner')
  const conversation = partner?.conversations[0]
  expect(conversation?.theirMessages).toBe(2)
  expect(conversation?.yourMessages).toBe(1)
  expect(conversation?.reciprocity).toBeCloseTo(2 / 3, 5)
  expect(conversation?.rhythmHours).not.toBeNull()
})

test('people who share a conversation become an edge', () => {
  const rows = [
    row('c4', 'u_a', '甲', '嗨'),
    row('c4', 'u_b', '乙', '嗨'),
    row('c4', SELF, '鄭富源', '一起開會。'),
  ]
  const graph = buildPersonaGraph(rows, SELF)
  expect(graph.edges.length).toBe(1)
  expect(graph.edges[0].chatIds).toEqual(['c4'])
})

test('an empty sample produces an empty graph rather than throwing', () => {
  const graph = buildPersonaGraph([], SELF)
  expect(graph.people.length).toBe(0)
  expect(graph.edges.length).toBe(0)
  expect(graph.method.sampleSize).toBe(0)
})
