import { expect, test } from 'bun:test'
import {
  analyzeMessage,
  analyzeNarrative,
  narrativeGuideLines,
  parseRequestFrame,
  splitSegments,
} from './narrative.js'

// Sample A: a talker who explains things in paragraphs, separates paragraphs
// with a blank line, lists fields with a colon, and closes politely.
const TALKER_A = [
  `收到，謝謝林藥師。

文件明天給您；下週二拿正本。

發票今天寄出，星期三會到。`,
  '台大退件，要麻煩妳補負責人電話，連同切結書，明天中午給我好嗎？院方月底才跑得完，謝謝妳，辛苦了。',
  `切結書只需要填：廠商名稱（章）、統編、負責人（章）、電話。

日期不用填，其他留空就好，謝謝妳`,
]

// Sample B: a talker who only writes short small talk.
const TALKER_B = [
  '你好～',
  '晚安，明天見',
  '謝謝！',
  '哈哈 好喔',
  '辛苦了',
  '週五見喔',
]

// A realistic engineering/consulting exchange: context first, then the
// delivered artifact with a confirmation request, then the urgent item with
// concrete data (amount, date, ids, address, deadline).
const DEMO_MESSAGES = [
  `台大請購程序都跑完了，現在可以開發票了。

驗收資料我這邊先做了一份，PDF 附上，麻煩妳看一下有沒有要改。

沒有的話就用印回傳給我，蓋在最後一頁的交付單位上，謝謝。`,
  `核銷比較急，發票麻煩妳開一下，三聯式。

抬頭：臺大醫院雲林分院
統編：64847502
品名：AI 軟體分析費
金額：含稅 148,000

再麻煩妳 11/16 掛號寄出，星期三會到，寄到 632 雲林縣虎尾鎮學府路 95 號。

發票旁邊請附上存摺封面影本，麻煩妳了，感謝！`,
]

test('splitSegments breaks a message into logical clauses', () => {
  const segments = splitSegments(DEMO_MESSAGES[1])
  expect(segments.length).toBeGreaterThan(8)
  expect(segments).toContain('三聯式')
  expect(segments).toContain('感謝')
  // A number with a thousands separator stays one segment.
  expect(segments).toContain('金額：含稅 148,000')
})

test('each message is classified segment by segment, in order', () => {
  const first = analyzeMessage(DEMO_MESSAGES[0])
  expect(first.onset[0]).toBe('context')
  expect(first.onset).toContain('delivery')
  expect(first.onset).toContain('request')
  expect(first.onset[first.onset.length - 1]).toBe('closing')
  expect(first.hasRequest).toBe(true)
  expect(first.delegating).toBe(true)
})

test('a narrative sample yields context-first ordering and high data density', () => {
  const profile = analyzeNarrative(DEMO_MESSAGES)

  expect(profile.sufficient).toBe(true)
  expect(profile.heuristic).toBe(true)
  expect(profile.dominantOrder[0]).toBe('context')
  expect(profile.dominantOrder).toContain('delivery')
  expect(profile.dominantOrder).toContain('request')
  expect(profile.dominantOrder).toContain('condition')
  expect(profile.dominantOrder).toContain('deadline')
  expect(profile.dominantOrder[profile.dominantOrder.length - 1]).toBe(
    'closing',
  )
  // Context comes before delivery, and delivery before request.
  const order = profile.dominantOrder
  expect(order.indexOf('context')).toBeLessThan(order.indexOf('delivery'))
  expect(order.indexOf('delivery')).toBeLessThan(order.indexOf('request'))
  expect(order.indexOf('request')).toBeLessThan(order.indexOf('condition'))

  // Both demo messages follow the same segment order.
  expect(profile.orderConcordance).toBe(1)

  expect(profile.concreteDataRate).toBeGreaterThanOrEqual(0.5)
  expect(profile.concreteDataKinds).toContain('date')
  expect(profile.concreteDataKinds).toContain('amount')
  expect(profile.concreteDataKinds).toContain('identifier')
  expect(profile.concreteDataKinds).toContain('address')

  // The request hands the decision back to the recipient.
  expect(profile.delegatingRequestRate).toBeGreaterThanOrEqual(0.5)

  const guide = narrativeGuideLines(profile).join('\n')
  expect(guide).toContain('常見順序為')
  expect(guide).toContain('先交代現況與前提')
  expect(guide).toContain('列出條件、參數與具體資料')
  expect(guide).toContain('常含實體資料')
  expect(guide).toContain('把判斷權交給對方')
  expect(guide).toContain('啟發式近似')
})

test('a greeting-only sample is reported as insufficient instead of guessed', () => {
  const profile = analyzeNarrative(TALKER_B)

  expect(profile.sufficient).toBe(false)
  expect(profile.insufficientReason).toBeTruthy()

  const guide = narrativeGuideLines(profile).join('\n')
  expect(guide).toContain('資料不足')
  expect(guide).not.toContain('常見順序為')
  expect(guide).not.toContain('常含實體資料')
})

test('a single message sample is reported as insufficient', () => {
  const profile = analyzeNarrative([DEMO_MESSAGES[0]])
  expect(profile.sufficient).toBe(false)
  expect(narrativeGuideLines(profile)[0]).toContain('資料不足')
})

test('the request skeleton is derived from the sample, not hardcoded', () => {
  const talkerA = analyzeNarrative([
    '要麻煩您星期一先開三聯式發票',
    '要麻煩您星期一先開三聯式發票',
  ])
  expect(talkerA.requestFrame?.template).toContain('要麻煩您')
  expect(talkerA.requestFrame?.template).toContain('動作')
  const guideA = narrativeGuideLines(talkerA).join('\n')
  expect(guideA).toContain('請求骨架')
  expect(guideA).toContain('要麻煩您')
  // The example must be a quote from this talker's own messages.
  expect(guideA).toContain('要麻煩您星期一先開三聯式發票')

  // A different talker gets a different skeleton, and never the first
  // talker's wording.
  const talkerB = analyzeNarrative([
    '請幫我開一下發票，謝謝',
    '請幫我寄到這裡，謝謝',
  ])
  const guideB = narrativeGuideLines(talkerB).join('\n')
  expect(talkerB.requestFrame?.template).toContain('請')
  expect(guideB).not.toContain('要麻煩您')
  expect(guideB).not.toContain('三聯式')
})

test('a narrative without a request prefix produces no request skeleton', () => {
  const profile = analyzeNarrative([
    '結案的驗收資料我這邊先做了一份，PDF 附上。',
    '目前請購程序都跑完了。',
  ])
  expect(profile.requestFrame).toBeUndefined()
  const guide = narrativeGuideLines(profile).join('\n')
  expect(guide).not.toContain('請求骨架')
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

test('directive instructions are told apart from relayed conditions', () => {
  const directive = analyzeNarrative([
    '要麻煩她 11/16 先開三聯式發票',
    '要麻煩她 11/16 先開三聯式發票',
  ])
  expect(directive.requestFrame?.style).toBe('directive')
  const guideDirective = narrativeGuideLines(directive).join('\n')
  expect(guideDirective).toContain('偏向直接給出具體值')
  expect(guideDirective).toContain('11/16')

  const relayed = analyzeNarrative([
    '日期要壓 11/14 含以後',
    '細目照報價單寫，院方核銷要看明細',
  ])
  expect(relayed.requestFrame?.style).toBe('relayed')
  const guideRelayed = narrativeGuideLines(relayed).join('\n')
  expect(guideRelayed).toContain('偏向轉述條件或理由')
  expect(guideRelayed).not.toContain('偏向直接給出具體值')
})

test('the field layout preference is detected from the sample', () => {
  const lined = `核銷比較急，要麻煩妳 11/16 先開三聯式發票，
抬頭：臺大醫院雲林分院
統編：64847502
品名：AI 軟體分析費
金額：含稅 148,000

細目照報價單寫。

開好後再麻煩妳寄出，
地址：632 雲林縣虎尾鎮學府路 95 號
收件人：林家薐藥師 收

麻煩妳了，感謝！`
  const inline =
    '核銷比較急，發票麻煩妳開一下，三聯式，抬頭：臺大醫院、統編：64847502，金額：含稅 148,000。'

  const linedProfile = analyzeNarrative([lined])
  expect(linedProfile.dataLayout.labeledLineRate).toBe(1)
  expect(linedProfile.dataLayout.inlineFieldRate).toBe(0)
  expect(linedProfile.dataLayout.labels).toContain('抬頭')
  expect(linedProfile.dataLayout.dateFormat).toBe('short')
  expect(linedProfile.dataLayout.amountFormat).toBe('with-tax')
  const guideLined = narrativeGuideLines(linedProfile).join('\n')
  expect(guideLined).toContain('逐行列出')
  expect(guideLined).toContain('抬頭：…')

  const inlineProfile = analyzeNarrative([inline, inline])
  expect(inlineProfile.dataLayout.labeledLineRate).toBe(0)
  expect(inlineProfile.dataLayout.inlineFieldRate).toBe(1)
  const guideInline = narrativeGuideLines(inlineProfile).join('\n')
  expect(guideInline).toContain('併在同一段')
  expect(guideInline).not.toContain(
    '此對話者常把具體欄位以『標籤：值』逐行列出',
  )
})

test('honorific density is reported per conversation', () => {
  const profile = analyzeNarrative(
    ['要麻煩您核對一下，謝謝', '麻煩妳看一下，謝謝'],
    ['chat-a', 'chat-b'],
  )
  expect(profile.honorifics.dominant).toBe('您')
  expect(profile.honorifics.perChat).toHaveLength(2)
  const chatA = profile.honorifics.perChat.find(
    (chat) => chat.chatId === 'chat-a',
  )
  const chatB = profile.honorifics.perChat.find(
    (chat) => chat.chatId === 'chat-b',
  )
  expect(chatA?.dominant).toBe('您')
  expect(chatB?.dominant).toBe('妳')
})

test('block structure separates prose paragraphs from field blocks', () => {
  const profile = analyzeNarrative(TALKER_A)

  // Paragraphs are separated by a blank line, and a semicolon divides items
  // inside one paragraph.
  expect(profile.blocks.paragraphBlankLineRate).toBeGreaterThan(0)
  expect(profile.blocks.semicolonClauseRate).toBeGreaterThan(0)
  // Fields are introduced by a colon and listed with enumeration commas.
  expect(profile.blocks.colonFieldSerialRate).toBeGreaterThan(0)
  // Ordered list markers are not used.
  expect(profile.blocks.listMarkerRate).toBe(0)

  const guide = narrativeGuideLines(profile).join('\n')
  expect(guide).toContain('段落之間多以空行分隔')
  expect(guide).toContain('『；』')
  expect(guide).toContain('冒號帶出欄位')
  expect(guide).toContain('不使用條列編號')
})

test('talker A and talker B are described differently', () => {
  const guideA = narrativeGuideLines(analyzeNarrative(TALKER_A)).join('\n')
  const guideB = narrativeGuideLines(analyzeNarrative(TALKER_B)).join('\n')

  expect(guideA).not.toBe(guideB)
  expect(guideA).toContain('常見順序為')
  expect(guideA).toContain('段落之間多以空行分隔')
  expect(guideB).toContain('資料不足')
  expect(guideB).not.toContain('常見順序為')
  expect(guideB).not.toContain('段落之間多以空行分隔')
  expect(guideB).not.toContain('冒號帶出欄位')
})

test('talker A shows the expected paragraph order and closing habits', () => {
  const profile = analyzeNarrative(TALKER_A)

  const order = profile.dominantOrder
  expect(order[0]).toBe('context')
  expect(order.indexOf('request')).toBeLessThan(order.indexOf('closing'))
  expect(order.indexOf('reason')).toBeLessThan(order.indexOf('closing'))
  expect(order[order.length - 1]).toBe('closing')

  // Request verbs and closings are read off the sample.
  const verbs = profile.requestVerbs.map((entry) => entry.prefix)
  expect(verbs.length).toBeGreaterThan(0)
  const closings = profile.closings.map((entry) => entry.text)
  expect(closings.join(' ')).toContain('謝謝')

  const guide = narrativeGuideLines(profile).join('\n')
  expect(guide).toContain('請求動詞')
  expect(guide).toContain('收尾語型')
  expect(guide).toContain('此對話者')
})
