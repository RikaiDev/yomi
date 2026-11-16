import { expect, test } from 'bun:test'
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
    '宜君是我太太，也是我們公司的財務。',
    1_700_000_001_000,
  ),
  row('c1', 'u_partner', '宜君', '好喔，謝謝。', 1_700_000_002_000),
  row(
    'c2',
    'u_pharmacist',
    '林家薐',
    '林藥師午安，麻煩你核銷單。',
    1_700_000_003_000,
  ),
  row('c2', SELF, '鄭富源', '林家薐醫師，麻煩你了。', 1_700_000_004_000),
  row('c3', 'u_other', '王小明', '今天天氣不錯。', 1_700_000_005_000),
]

test('a role is recorded only when your own message names the person', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  const partner = graph.people.find((p) => p.mid === 'u_partner')
  expect(partner).toBeDefined()
  const terms = partner?.roles.map((role) => role.term) ?? []
  expect(terms).toContain('太太')
  expect(terms).toContain('財務')
  const wife = partner?.roles.find((role) => role.term === '太太')
  expect(wife?.evidence).toContain('我太太')
  expect(wife?.source.chatId).toBe('c1')
})

test('a person you never name gets no role', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  const other = graph.people.find((p) => p.mid === 'u_other')
  expect(other?.roles.length ?? 0).toBe(0)
})

test('a role word without the name in the same sentence is not a role', () => {
  const rows = [
    row('c9', 'u_stranger', '陌生人', '請找財務。'),
    row('c9', SELF, '鄭富源', '財務那邊我晚點打過去。'),
  ]
  const graph = buildPersonaGraph(rows, SELF)
  const stranger = graph.people.find((p) => p.mid === 'u_stranger')
  expect(stranger?.roles.length ?? 0).toBe(0)
})

test('every reported role carries its evidence sentence', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  for (const person of graph.people) {
    for (const role of person.roles) {
      expect(role.evidence.length).toBeGreaterThan(0)
      expect(role.source.chatId.length).toBeGreaterThan(0)
    }
  }
})

test('the address form is taken from how you open the message', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  const pharmacist = graph.people.find((p) => p.mid === 'u_pharmacist')
  const partner = graph.people.find((p) => p.mid === 'u_partner')
  // The form is how YOU open the message to them, not how they open theirs.
  expect(pharmacist?.addresses[0]?.form).toBe('林家薐醫師')
  // A definition sentence (name plus copula plus role word) is not an address.
  expect(partner?.addresses[0]?.form).toBeUndefined()
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

test('a one-to-one conversation creates no edge', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  expect(graph.edges.length).toBe(0)
})

test('the guide names the evidence behind every role claim', () => {
  const graph = buildPersonaGraph(SAMPLE, SELF)
  const wifeLine = graph.guide.find((line) => line.includes('太太'))
  expect(wifeLine).toBeDefined()
  expect(wifeLine).toContain('依據')
  expect(wifeLine).toContain('我太太')
})

test('an empty sample produces an empty graph rather than throwing', () => {
  const graph = buildPersonaGraph([], SELF)
  expect(graph.people.length).toBe(0)
  expect(graph.edges.length).toBe(0)
  expect(graph.method.sampleSize).toBe(0)
})

test('a fact you stated outside LINE becomes a role with your own sentence', () => {
  const facts: PersonaFact[] = [
    {
      subjectMid: null,
      subjectName: '宜君',
      term: '太太',
      category: 'family',
      evidence: '宜君是我太太，也是我們公司的財務。',
    },
  ]
  const graph = buildPersonaGraph([], SELF, facts)
  const person = graph.people.find((p) => p.name === '宜君')
  expect(person).toBeDefined()
  const role = person?.roles.find((r) => r.term === '太太')
  expect(role?.evidence).toContain('我太太')
  expect(role?.origin).toBe('stated')
  expect(graph.method.statedFacts).toBe(1)
})

test('a fact is matched to a person by MID when one is known', () => {
  const rows = [row('c1', 'u_partner', '宜君', '收到。')]
  const facts: PersonaFact[] = [
    {
      subjectMid: 'u_partner',
      subjectName: '宜君',
      term: '財務',
      category: 'household',
      evidence: '她負責我們公司的財務。',
    },
  ]
  const graph = buildPersonaGraph(rows, SELF, facts)
  const partner = graph.people.find((p) => p.mid === 'u_partner')
  expect(partner?.roles.map((r) => r.term)).toContain('財務')
  expect(partner?.roles[0].origin).toBe('stated')
})

test('two facts about the same person do not overwrite each other', () => {
  const facts: PersonaFact[] = [
    {
      subjectMid: null,
      subjectName: '宜君',
      term: '太太',
      category: 'family',
      evidence: '宜君是我太太。',
    },
    {
      subjectMid: null,
      subjectName: '宜君',
      term: '財務',
      category: 'household',
      evidence: '宜君也是我們公司的財務。',
    },
  ]
  const graph = buildPersonaGraph([], SELF, facts)
  expect(graph.people.length).toBe(1)
  const person = graph.people[0]
  expect(person.roles.map((r) => r.term).sort()).toEqual(['太太', '財務'])
})

test('a fact about somebody absent from the index still gets a node', () => {
  const facts: PersonaFact[] = [
    {
      subjectMid: null,
      subjectName: '陳會計',
      term: '會計師',
      category: 'professional',
      evidence: '陳會計師是我們的報稅代理人。',
    },
  ]
  const graph = buildPersonaGraph([], SELF, facts)
  const person = graph.people.find((p) => p.name === '陳會計')
  expect(person).toBeDefined()
  expect(person?.roles[0].evidence).toContain('陳會計師')
})

test('evidence is collapsed to a single line', () => {
  const facts: PersonaFact[] = [
    {
      subjectMid: null,
      subjectName: '宜君',
      term: '太太',
      category: 'family',
      evidence: '宜君是我太太。\n另外這行不應該出現。',
    },
  ]
  const graph = buildPersonaGraph([], SELF, facts)
  const role = graph.people[0].roles[0]
  expect(role.evidence).not.toContain('\n')
  expect(role.evidence).toBe('宜君是我太太。')
})
