import { expect, test } from 'bun:test'
import {
  analyzeMessage,
  analyzeNarrative,
  narrativeGuideLines,
  parseRequestFrame,
  splitSegments,
} from './narrative.js'

// Sample A: narrative paragraphs, blank-line separated, fields on their own
// lines, mitigated requests.
const TALKER_A = [
  `收到，謝謝林藥師。

文件明天給您；下週二拿正本。

發票今天寄出，星期三會到。`,
  '台大退件，要麻煩妳補負責人電話，連同切結書，明天中午給我好嗎？院方月底才跑得完，謝謝妳，辛苦了。',
  `切結書只需要填：廠商名稱（章）、統編、負責人（章）、電話。

日期不用填，其他留空就好，謝謝妳`,
  `驗收資料我這邊先做了一份，PDF 附上，麻煩妳看一下有沒有要改。

沒有的話就用印回傳給我，蓋在最後一頁的交付單位上，謝謝。`,
  `發票麻煩妳開一下，三聯式。

抬頭：臺大醫院雲林分院
統編：64847502
品名：AI 軟體分析費
金額：含稅 148,000

再麻煩妳 11/16 掛號寄出，寄到 632 雲林縣虎尾鎮學府路 95 號，謝謝。`,
]

// Sample B: only short small talk.
const TALKER_B = [
  '你好～',
  '晚安，明天見',
  '謝謝！',
  '哈哈 好喔',
  '辛苦了',
  '週五見喔',
]

// Sample C: minimal commands as an ordered list.
const TALKER_C = [
  '1. 開三聯式發票\n2. 明天寄出\n3. 回報我',
  '1. 統編 64847502\n2. 金額 148000\n3. 抬頭 臺大醫院',
  '1. 附存摺影本\n2. 11/16 前',
]

// Sample D: mitigation marker in front of the verb phrase, fields one per
// line, deadline inside the request clause before the action.
const TALKER_D = [
  `要麻煩妳 11/16 先開三聯式發票。

抬頭：臺大醫院
統編：64847502

再麻煩妳 11/16 掛號寄出，謝謝。`,
  `要麻煩妳 11/16 先開三聯式發票。

抬頭：雲林分院
統編：64847503

再麻煩妳寄出，謝謝。`,
]

// Sample E: direct imperative, fields enumerated on one line, no deadline.
// The wording overlaps heavily with D; only the structure differs.
const TALKER_E = [
  '請開三聯式發票。抬頭：臺大醫院、統編：64847502',
  '請開三聯式發票。抬頭：雲林分院、統編：64847503',
  '請寄出三聯式發票，謝謝。',
]

const DEMO_MESSAGE = `發票麻煩妳開一下，三聯式。

抬頭：臺大醫院雲林分院
統編：64847502

再麻煩妳 11/16 掛號寄出，謝謝。`

/** A rule line must carry a rate, a sample count, or a verbatim excerpt. */
function hasEvidence(line: string): boolean {
  return /%|樣本|〈/.test(line)
}

test('splitSegments breaks a message into logical clauses', () => {
  const segments = splitSegments(
    '核銷比較急，發票麻煩妳開一下，三聯式，抬頭：臺大醫院、統編：64847502，金額：含稅 148,000。',
  )
  expect(segments.length).toBeGreaterThan(4)
  expect(segments).toContain('三聯式')
  // A number with a thousands separator stays one segment.
  expect(segments).toContain('金額：含稅 148,000')
})

test('a message is analysed into clauses and discourse units', () => {
  const message = analyzeMessage(DEMO_MESSAGE)
  expect(message.clauses.length).toBeGreaterThan(3)
  expect(message.units.length).toBeGreaterThan(1)
  expect(message.units.some((unit) => unit.kind === 'field')).toBe(true)
  expect(message.units.some((unit) => unit.kind === 'request')).toBe(true)
})

test('talker A, B and C get three different descriptions', () => {
  const guideA = narrativeGuideLines(analyzeNarrative(TALKER_A)).join('\n')
  const guideB = narrativeGuideLines(analyzeNarrative(TALKER_B)).join('\n')
  const guideC = narrativeGuideLines(analyzeNarrative(TALKER_C)).join('\n')

  expect(guideA).not.toBe(guideB)
  expect(guideA).not.toBe(guideC)
  expect(guideB).not.toBe(guideC)

  // A: mitigated requests, fields on their own lines.
  expect(guideA).toContain('迂迴請求')
  expect(guideA).toContain('逐列')

  // B: a greeting-only sample is reported as insufficient.
  expect(guideB).toContain('資料不足')

  // C: an ordered-list talker is fully describable.
  expect(guideC).toContain('條列單位100%')
  expect(guideC).toContain('屬性表')
  expect(guideC).toContain('量測觀察')
})

test('a greeting-only sample is reported as insufficient', () => {
  const profile = analyzeNarrative(TALKER_B)
  expect(profile.sufficient).toBe(false)
  expect(profile.insufficientReason).toBeTruthy()

  const guide = narrativeGuideLines(profile).join('\n')
  expect(guide).toContain('資料不足')
  expect(guide).not.toContain('量測觀察')
})

test('a list-command sample is sufficient even without narrative prose', () => {
  const profile = analyzeNarrative(TALKER_C)
  expect(profile.sufficient).toBe(true)
  const listUnit = profile.unitRates.find((entry) => entry.kind === 'list')
  expect(listUnit?.rate).toBe(1)
})

test('samples D and E differ in mitigation, field layout and deadline', () => {
  const profileD = analyzeNarrative(TALKER_D)
  const profileE = analyzeNarrative(TALKER_E)
  const guideD = narrativeGuideLines(profileD).join('\n')
  const guideE = narrativeGuideLines(profileE).join('\n')

  // Mitigation: D fronts a mitigation marker, E is a direct imperative.
  const mitigatedD = profileD.strategyRates.find(
    (entry) => entry.strategy === 'negative-politeness',
  )
  const directE = profileE.strategyRates.find(
    (entry) => entry.strategy === 'bald-on-record',
  )
  expect(mitigatedD?.rate).toBe(1)
  expect(directE?.rate).toBe(1)

  // Field layout: D lists fields one per line, E enumerates them inline.
  expect(profileD.layout.fieldPerLineRate).toBe(1)
  expect(profileD.layout.fieldSerialRate).toBe(0)
  expect(profileE.layout.fieldSerialRate).toBe(1)
  expect(profileE.layout.fieldPerLineRate).toBe(0)

  // Deadline: D carries a deadline in front of the action, E has none.
  expect(profileD.valuePosition.preposed).toBeGreaterThan(0)
  expect(profileE.valuePosition.base).toBe(0)
  expect(profileD.mitigationMoves.deadline).toBeGreaterThan(0)
  expect(profileE.mitigationMoves.deadline).toBe(0)

  // The instructions differ accordingly.
  expect(guideD).toContain('迂迴標記')
  expect(guideD).toContain('逐列')
  expect(guideE).toContain('直接以動詞短語')
  expect(guideE).toContain('串列')
  expect(guideD).not.toBe(guideE)
})

test('every rule line carries a rate or a sample count', () => {
  for (const sample of [TALKER_A, TALKER_B, TALKER_C, TALKER_D, TALKER_E]) {
    const lines = narrativeGuideLines(analyzeNarrative(sample))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(hasEvidence(line)).toBe(true)
    }
  }
})

test("every excerpt is the talker's own wording", () => {
  for (const sample of [TALKER_A, TALKER_C, TALKER_D, TALKER_E]) {
    const profile = analyzeNarrative(sample)
    for (const value of Object.values(profile.snippets)) {
      if (!value) continue
      expect(sample.some((message) => message.includes(value as string))).toBe(
        true,
      )
    }
    for (const example of profile.examples) {
      expect(
        sample.some((message) =>
          message.includes(example.text.replace(/…$/, '')),
        ),
      ).toBe(true)
    }
  }
})

test('an instruction quotes the excerpt of the feature it is about', () => {
  const profile = analyzeNarrative(TALKER_D)
  const guide = narrativeGuideLines(profile).join('\n')
  // The mitigation instruction quotes a mitigated request, not something else.
  expect(profile.snippets.mitigated).toBeTruthy()
  expect(guide).toContain(`例:〈${profile.snippets.mitigated}〉`)
  expect(profile.snippets.mitigated).toContain('麻煩')
})

test('prohibitions state what the talker does not do, with evidence', () => {
  const profile = analyzeNarrative(TALKER_D)
  expect(profile.prohibitions.length).toBeGreaterThan(0)
  for (const prohibition of profile.prohibitions) {
    expect(prohibition.text.length).toBeGreaterThan(0)
    expect(prohibition.evidence).toMatch(/%|樣本/)
  }
  const guide = narrativeGuideLines(profile).join('\n')
  expect(guide).toContain('禁令／未觀測')
  expect(guide).toContain('勿自行把迂迴請求改成直接祈使')
})

test('no fixed element chain is emitted', () => {
  for (const sample of [TALKER_A, TALKER_C, TALKER_D, TALKER_E]) {
    const guide = narrativeGuideLines(analyzeNarrative(sample)).join('\n')
    expect(guide).not.toContain('常見順序為')
    // A transition is a pair; an arrow chain inside one quoted pair would be
    // a fixed element chain.
    expect(guide).not.toMatch(/「[^」]*→[^」]*→[^」]*」/)
  }
})

test('the same person writes differently to different recipients', () => {
  const texts = [
    '要麻煩妳 11/16 先開三聯式發票，謝謝。',
    '要麻煩妳寄出，謝謝。',
    '請開三聯式發票，謝謝。',
    '請寄出，謝謝。',
  ]
  const chatIds = ['vendor', 'vendor', 'colleague', 'colleague']
  const profile = analyzeNarrative(texts, chatIds)

  const vendor = profile.registers.find((entry) => entry.chatId === 'vendor')
  const colleague = profile.registers.find(
    (entry) => entry.chatId === 'colleague',
  )
  expect(vendor?.mitigationRate).toBe(1)
  expect(colleague?.mitigationRate).toBe(0)
  expect(vendor?.honorific).toBe('妳')
  expect(colleague?.honorific).toBeNull()

  const guide = narrativeGuideLines(profile).join('\n')
  expect(guide).toContain('對不同對象調整迂迴度與稱呼')
  expect(guide).toContain('vendor:迂迴率100%')
  expect(guide).toContain('colleague:迂迴率0%')
})

test('function words are reported as identification only', () => {
  const guide = narrativeGuideLines(analyzeNarrative(TALKER_A)).join('\n')
  expect(guide).toContain('鑑別用途')
  expect(guide).toContain('不作為模仿規範')
})

test('a request frame is parsed into prefix, time, sequence and action', () => {
  const frame = parseRequestFrame('要麻煩您星期一先開三聯式發票')
  expect(frame?.prefix).toBe('要麻煩您')
  expect(frame?.time).toBe('星期一')
  expect(frame?.sequence).toBe('先')
  expect(frame?.action).toContain('開三聯式發票')
  expect(frame?.specified).toBe(true)
  expect(parseRequestFrame('目前程序都跑完了')).toBeNull()
})

test('an auxiliary 請 is not mistaken for a politeness prefix', () => {
  // Here "qing" is the verb "invite", not a request prefix.
  expect(parseRequestFrame('請同事開立發票')).toBeNull()
  expect(parseRequestFrame('才請得到經費')).toBeNull()
  expect(parseRequestFrame('需要請朋友的公司補件')).toBeNull()
  // A real request prefix is still recognised.
  expect(parseRequestFrame('請一併附上存摺封面影本')?.prefix).toBe('請')
  expect(parseRequestFrame('敬請回傳已用印的檔案')?.prefix).toBe('請')
})

test('reason sources are only reported when the sample supports it', () => {
  const profile = analyzeNarrative(TALKER_A)
  expect(profile.reasonSource.base).toBeGreaterThan(0)
  expect(profile.reasonSource.self).toBeGreaterThan(0)
  expect(profile.reasonSource.relayed).toBeGreaterThan(0)

  const thin = analyzeNarrative(TALKER_E)
  expect(thin.reasonSource.base).toBe(0)
  const guide = narrativeGuideLines(thin).join('\n')
  expect(guide).toContain('理由來源資料不足')
  expect(guide).not.toContain('理由來源自陳0%')
})
