/**
 * Narrative-structure analysis for the user's own LINE messages.
 *
 * The style card already reports mechanical statistics (length, emoji, bursts,
 * stickers). This module adds an approximation of HOW the talker organizes a
 * message: which logical segments a message carries, in what order they
 * appear, how a request is framed, whether an instruction gives an executable
 * value or relays a third party's condition, how concrete fields are laid out
 * (one field per line, in blocks), which wording is used for dates, and which
 * honorific is used.
 *
 * EVERYTHING HERE IS A KEYWORD + PUNCTUATION HEURISTIC, not semantic
 * understanding, and every reported feature is derived from the analyzed
 * sample: the analyzer never assumes a particular talker's phrasing. Callers
 * must label the result as an approximation and must suppress a dimension
 * when the sample is too small or too flat to describe (see `sufficient`).
 */

/** Logical role of one segment inside a message. */
export type NarrativeRole =
  | 'context'
  | 'delivery'
  | 'request'
  | 'condition'
  | 'reason'
  | 'deadline'
  | 'closing'

/** Chinese label per role, used in the style guide. */
export const NARRATIVE_ROLE_LABELS: Record<NarrativeRole, string> = {
  context: '交代現況與前提',
  delivery: '說明已完成或已交付事項',
  request: '提出請求並請對方確認',
  condition: '列出條件、參數與具體資料',
  reason: '交代理由或依據',
  deadline: '給出期限與時程',
  closing: '致謝收尾',
}

/**
 * Keyword patterns per role. Each pattern contributes one point when it
 * matches a segment; the highest scoring role wins the segment.
 */
const ROLE_PATTERNS: Record<NarrativeRole, RegExp[]> = {
  context: [
    /都跑完|跑完了|目前|現在|進度|狀況|原因是|因為|既然|先說|先講|補充|對了|前置|比較急|比較趕|原來|先前|照之前|照我們|流程|程序|已經|退件|簽呈|但今天|早先/,
  ],
  delivery: [
    /我這邊|我們這邊|這邊先|先做|做了一份|做了一版|做好|弄好|產出|附上|附件|如附件|送件|提交|打包|寫好|整理好|備妥|先備/,
  ],
  request: [
    /請(?!於|購)|麻煩|拜託|幫忙|可否|有沒有|看一下|確認|回傳|寄出|開一下|處理一下|協助|看要不要|自行|需要的話|沒有的話|不然的話|務必/,
  ],
  condition: [
    /金額|含稅|統編|抬頭|品名|細目|明細|單號|序號|編號|地址|收件|三聯式|報價|單價|規格|數量|尺寸|版本|共計|合計|新台幣|戶名|戶號|頁|簽名|用印|日期|號碼|費|款項/,
  ],
  reason: [
    /因為|所以|由於|要用來|要用|需要|要看|用途|原因|理由|才請得到|才跑得完|才成立/,
  ],
  deadline: [
    /今天|明天|後天|大後天|週[一二三四五六日天]|星期[一二三四五六日天]|禮拜|日前|期限|截止|最晚|下班前|月底|月初|年底|上旬|下旬|會到|寄出|請於/,
  ],
  closing: [/謝謝|感謝|多謝|感恩|辛苦了|麻煩(?:你|妳|您)了|thanks/i],
}

/** Tie-break order when two roles score equally (earlier wins). */
const ROLE_PRIORITY: NarrativeRole[] = [
  'closing',
  'deadline',
  'reason',
  'condition',
  'request',
  'delivery',
  'context',
]

/**
 * Canonical skeleton, used only to break ties between roles that appear at
 * the same position in the sample.
 */
const ROLE_CANONICAL: NarrativeRole[] = [
  'context',
  'delivery',
  'request',
  'condition',
  'reason',
  'deadline',
  'closing',
]

/** Roles that carry real work content (a flat sample has fewer than two). */
const SUBSTANTIVE_ROLES: NarrativeRole[] = [
  'context',
  'delivery',
  'request',
  'condition',
  'reason',
  'deadline',
]

/**
 * Request prefix: the opening of a request (a politeness verb plus an
 * optional honorific). This is generic Chinese politeness vocabulary, not a
 * fixed sentence template of any talker; the prefix that is actually used is
 * counted from the sample.
 */
const REQUEST_PREFIX_RE =
  /(?:再|又)?(?:要)?(?:麻煩|拜託|幫忙)(?:您|妳|你)?|請(?!購|於)(?:您|妳|你)?/

/** Family of a request prefix, ignoring the honorific. */
const REQUEST_FAMILY_RE = /(?:再|又)?(?:要)?(?:麻煩|拜託|幫忙)|請(?!購|於)/

/** Temporal adjunct inside a request (a date, a weekday, a relative day). */
const TIME_RE =
  /\d{1,4}\s*[-/]\s*\d{1,2}(?:\s*[-/]\s*\d{1,4})?|今天|明天|後天|大後天|昨天|早上|下午|晚上|週[一二三四五六日天]|星期[一二三四五六日天]|禮拜[一二三四五六日天]|下週[一二三四五六日天]|下個星期[一二三四五六日天]|下個月|月底|月初|年底|今年|週末/

/** Sequence marker inside a request (first / then / after / only then). */
const SEQ_RE = /先|再|後|然後|才/

/** Concrete condition tokens inside a request. */
const CONDITION_TOKEN_RE =
  /三聯式|含稅|統編|抬頭|品名|單號|序號|細目|明細|地址|收件|簽名|用印|頁|格式|附件|數量|規格|日期|金額|數字|\d+\s*(?:元|號|頁)|\d{4,}/

/**
 * Markers of a RELAYED condition: the talker passing on a third party's
 * requirement instead of giving an executable value.
 */
const RELAYED_RE =
  /含以後|含以前|以前|以後|以內|以上|以下|不超過|不得|至少|依|按照|照|規定|要求|合約|報價單|對方|院方|客戶|需符合|符合|條件/

/** Markers of an attached reason. */
const REASON_RE = /因為|所以|由於|要用來|需要建檔|要看|用途|原因|理由/

/** Action verbs that make a clause executable. */
const ACTION_RE =
  /開|寄|附|回傳|寫|蓋|簽|送|做|處理|給|打|填|核|付|收|取|拿|提出|辦|壓|列|報|發|匯|印|傳/

/** Markers of a request that hands the decision back to the recipient. */
const DELEGATING_RE =
  /有沒有|沒有的話|需要的話|如無|若無|可否|是否|要不要|自行|看要不要|不行的話|有問題的話|OK嗎|確認一下|判斷/

/** Relative time words (today, a weekday, next week). */
const RELATIVE_DATE_RE =
  /今天|明天|後天|大後天|昨天|早上|下午|晚上|週[一二三四五六日天]|星期[一二三四五六日天]|禮拜[一二三四五六日天]|下週[一二三四五六日天]|下個星期[一二三四五六日天]|下個月|月底|月初|年底|今年|週末/

/** Absolute date formats (year/month/day, month/day, Chinese month-day). */
const ABSOLUTE_DATE_RE =
  /\d{4}\s*[-/年]\s*\d{1,2}|\d{1,2}\s*[-/]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日/

/** Explicit action ordering inside one message (first ... then ...). */
const SEQUENCE_PAIR_RE = /先[^。！？!?；;]{0,40}?(再|後|然後|才)/

/**
 * A line written as "label：value".
 *
 * The label vocabulary is deliberately open: only the SHAPE is checked (a
 * short label, a colon, a value), so the field names this talker uses are
 * reported back instead of a fixed list.
 */
const LABELLED_LINE_RE = /^\s*([^\s：:，,。！？!?；;]{1,12})\s*[:：]\s*(\S.+)$/

/** A colon inside a line (a field introducer). */
const COLON_RE = /[:：]/
/** An ordered list marker at the start of a line. */
const LIST_MARKER_RE = /^\s*(?:\d+[.、)]|[-*•])\s/
/** An absolute date written with a full year. */
const ISO_DATE_RE = /\d{4}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}/
/** An absolute date written as month/day. */
const SHORT_DATE_RE = /(?<!\d)\d{1,2}\s*\/\s*\d{1,2}(?!\s*\/\s*\d)/
/** An absolute date written with Chinese month and day characters. */
const CHINESE_DATE_RE = /\d{1,2}\s*月\s*\d{1,2}\s*日/
/** An amount broken into parts. */
const AMOUNT_BREAKDOWN_RE = /\d[\d,]*\s*[+＋]\s*\d[\d,]*\s*[=＝]/

/** Concrete-data kinds, with the regex that detects each of them. */
const DATA_PATTERNS: { kind: string; label: string; re: RegExp }[] = [
  {
    kind: 'date',
    label: '日期',
    re: /\d{1,4}\s*[-/]\s*\d{1,2}(?:\s*[-/]\s*\d{1,4})?|\d{1,2}\s*月\s*\d{1,2}\s*日|週[一二三四五六日天]|星期[一二三四五六日天]/,
  },
  {
    kind: 'amount',
    label: '金額',
    re: /NT\$|NT\s|US\$|RMB|CNY|\$|¥|美金|人民幣|新台幣|含稅|單價|總價|合計|金額|\d[\d,]{2,}\s*(?:元|塊|萬)|[0-9][0-9,]+\s*元/,
  },
  {
    kind: 'identifier',
    label: '編號',
    re: /統編|單號|序號|編號|號碼|案號|案件編號|發票號碼|\b[A-Z]{2,}\d{2,}\b|\b\d{8}\b/,
  },
  {
    kind: 'address',
    label: '地址',
    re: /\d+\s*(?:號|巷|弄|路|街|大道|樓|室)|郵遞區號|地址|收件人|收$/,
  },
  { kind: 'percent', label: '百分比', re: /\d+(?:\.\d+)?\s*[%％]/ },
]

/** Minimum messages before the narrative dimension is reported at all. */
const MIN_MESSAGES = 2
/** Minimum segments before the narrative dimension is reported at all. */
const MIN_SEGMENTS = 6

/** One parsed request frame. */
export interface RequestFrame {
  /** The literal prefix found in the sample. */
  prefix: string
  /** Prefix family without honorific. */
  family: string
  /** Temporal adjunct, when present. */
  time: string | null
  /** Sequence marker, when present. */
  sequence: string | null
  /** The requested action, without its adjuncts. */
  action: string
  /** Whether the request carries a concrete condition. */
  condition: boolean
  /** Whether the request gives a directly executable value. */
  specified: boolean
  /** Whether the request relays a third party's condition. */
  relayed: boolean
  /** Whether the request carries an attached reason. */
  reason: boolean
  /** The original clause, used as a quotable example. */
  raw: string
}

/** How the talker lays concrete fields out inside a message. */
export interface DataLayoutProfile {
  /** Share of messages that contain at least one label/value line. */
  labeledLineRate: number
  /** Average number of label/value lines per message. */
  labeledFieldsPerMessage: number
  /** Share of messages that carry concrete data inside one paragraph. */
  inlineFieldRate: number
  /** Share of messages that use line breaks. */
  multilineRate: number
  /** Dominant absolute-date format. */
  dateFormat: 'iso' | 'short' | 'chinese' | 'none'
  /** Dominant amount format. */
  amountFormat: 'with-tax' | 'breakdown' | 'plain' | 'none'
  /** The field labels actually used, in order of first appearance. */
  labels: string[]
}

/**
 * Block structure of a message: prose paragraphs versus runs of field lines.
 */
export interface BlockStructureProfile {
  /** Share of paragraph boundaries that are separated by a blank line. */
  paragraphBlankLineRate: number
  /** Share of prose clauses that are separated by a semicolon. */
  semicolonClauseRate: number
  /** Share of paragraphs that list several colon fields in one line. */
  colonFieldSerialRate: number
  /** Share of messages that use ordered list markers. */
  listMarkerRate: number
  /** Share of messages that contain at least one field block. */
  fieldBlockRate: number
  /** Average number of field blocks per message. */
  blocksPerMessage: number
  /** Average number of field lines per block. */
  avgLinesPerBlock: number
  /** Share of blocks separated from the prose by a blank line. */
  blankLineSeparatedRate: number
  /** Sentence terminators per prose line (about 1 means one sentence per line). */
  proseSentenceRatio: number
}

/** Narrative shape of the talker's messages. */
export interface NarrativeProfile {
  /** Always true — the analysis is a keyword/punctuation heuristic. */
  heuristic: true
  /** Number of user messages analyzed. */
  sampleSize: number
  /** Number of logical segments detected across the sample. */
  segmentCount: number
  /** Average number of logical segments per message. */
  avgSegmentsPerMessage: number
  /** Share of messages in which each role appears. */
  roleRates: Partial<Record<NarrativeRole, number>>
  /** Most frequent role ordering across the sample. */
  dominantOrder: NarrativeRole[]
  /** Share of role-bearing messages whose ordering agrees with dominantOrder. */
  orderConcordance: number
  /** Share of messages containing at least one concrete data kind. */
  concreteDataRate: number
  /** Concrete data kinds seen in the sample. */
  concreteDataKinds: string[]
  /** Share of messages that carry a request at all. */
  requestRate: number
  /** Share of requesting messages that hand the decision back to the recipient. */
  delegatingRequestRate: number
  /** Request frame habit (prefix + action + time/condition). */
  requestFrame?: {
    /** Number of parsed request frames. */
    sampleSize: number
    /** Most frequent literal prefix in the sample. */
    prefix: string
    /** Share of frames using that prefix. */
    prefixRate: number
    /** Share of frames carrying a temporal adjunct. */
    timeRate: number
    /** Share of frames carrying a concrete condition. */
    conditionRate: number
    /** Share of frames carrying a sequence marker. */
    sequenceRate: number
    /** Frame template, built from the sample's own prefix and adjuncts. */
    template: string
    /** A real example taken from the talker's own messages. */
    example: string
    /** Share of instructions that give a directly executable value. */
    directiveRate: number
    /** Share of instructions that relay a third party's condition. */
    relayedRate: number
    /** Share of instructions that carry a concrete value at all. */
    valueRate: number
    /** Share of instructions that carry an attached reason. */
    reasonRate: number
    /** Dominant instruction style. */
    style: 'directive' | 'relayed' | 'plain'
    /** Example of the dominant instruction style. */
    styleExample: string
  }
  /** Relative vs absolute date wording. */
  dateStyle: {
    /** Share of dated messages using a relative day word. */
    relativeRate: number
    /** Share of dated messages using an absolute date. */
    absoluteRate: number
    /** Which wording dominates. */
    preferred: 'relative' | 'absolute' | 'mixed' | 'none'
  }
  /** Honorific habits. */
  honorifics: {
    /** Share of messages using the formal honorific. */
    ningRate: number
    /** Share of messages using the familiar honorific. */
    neiRate: number
    /** Share of messages using the casual pronoun. */
    niRate: number
    /** The honorific used most. */
    dominant: string | null
    /** Honorific density per conversation. */
    perChat: {
      chatId: string
      ningRate: number
      neiRate: number
      dominant: string | null
    }[]
  }
  /** Share of messages that mark action order explicitly. */
  sequenceMarkerRate: number
  /** Short snippets taken from the talker's own messages, used as examples. */
  snippets: {
    amount: string | null
    date: string | null
    delegating: string | null
  }
  /** Request prefixes used in the sample, most frequent first. */
  requestVerbs: { prefix: string; count: number; rate: number }[]
  /** Closing phrases used in the sample, most frequent first. */
  closings: { text: string; count: number; rate: number }[]
  /** How concrete fields are laid out. */
  dataLayout: DataLayoutProfile
  /** Block structure of the messages. */
  blocks: BlockStructureProfile
  /** False when the sample is too small or too flat to describe. */
  sufficient: boolean
  /** Why the dimension was suppressed (only when sufficient is false). */
  insufficientReason?: string
}

/**
 * Split one message into logical segments.
 *
 * Chinese business writing separates sentences with 。！？；, clauses with
 * ，, and list items with 、 — so all three are treated as segment borders.
 * An ASCII comma inside a number does not split a segment, and a
 * hard line break always ends a segment.
 */
export function splitSegments(text: string): string[] {
  const out: string[] = []
  const clauseSplit = /[，、]|(?<!\d),(?!\d)/
  for (const sentence of text.split(/[。！？!?；;\n]+/)) {
    if (!sentence.trim()) continue
    for (const clause of sentence.split(clauseSplit)) {
      const trimmed = clause.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}

function scoreRole(segment: string): NarrativeRole | null {
  // A short standalone courtesy phrase is a closing, not a request.
  if (
    ROLE_PATTERNS.closing.some((p) => p.test(segment)) &&
    segment.length <= 12
  ) {
    return 'closing'
  }
  let best: NarrativeRole | null = null
  let bestScore = 0
  for (const role of ROLE_PRIORITY) {
    let score = 0
    for (const pattern of ROLE_PATTERNS[role]) {
      if (pattern.test(segment)) score++
    }
    // An explicit request prefix marks the segment as a request first.
    if (role === 'request' && REQUEST_PREFIX_RE.test(segment)) score += 2
    if (score > bestScore) {
      best = role
      bestScore = score
    }
  }
  return best
}

/** Concrete data kinds present in a single message. */
export function detectConcreteData(text: string): string[] {
  return DATA_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.kind)
}

/**
 * A bare "qing" that follows an auxiliary verb, or that opens a fixed phrase
 * ("hui qing tongshi...", "cai qing dedao..."), is the verb "invite / be able
 * to ask", not a politeness prefix. Such matches must not be counted as
 * request prefixes.
 */
const AUX_BEFORE_QING_RE = /[會要能可才得願想不]$/
const FIXED_AFTER_QING_RE = /^(?:得到|不到|假|購|於)/
/**
 * "qing" followed by the agent of the action ("qing tongshi kaili...") is the
 * verb "invite someone to do", not a politeness prefix.
 */
const AGENT_AFTER_QING_RE =
  /^(?:同事|朋友|大家|各位|廠商|院方|對方|客戶|貴方|貴公司|窗口|承辦|承作)/

function isPolitenessPrefix(
  segment: string,
  index: number,
  prefix: string,
): boolean {
  if (prefix !== '請') return true
  if (AUX_BEFORE_QING_RE.test(segment.slice(0, index))) return false
  const after = segment.slice(index + prefix.length)
  if (FIXED_AFTER_QING_RE.test(after)) return false
  if (AGENT_AFTER_QING_RE.test(after)) return false
  return true
}

/**
 * Parse the request frame of a clause: prefix + action + time / condition.
 *
 * Returns null when the clause carries no request prefix.
 */
export function parseRequestFrame(segment: string): RequestFrame | null {
  const re = new RegExp(REQUEST_PREFIX_RE.source, 'g')
  let match = re.exec(segment)
  while (match && !isPolitenessPrefix(segment, match.index, match[0])) {
    match = re.exec(segment)
  }
  if (!match) return null
  const prefix = match[0]
  const familyMatch = REQUEST_FAMILY_RE.exec(prefix)
  const rest = segment.slice(match.index + prefix.length)
  const timeMatch = TIME_RE.exec(rest)
  const seqMatch = SEQ_RE.exec(rest)
  let action = rest
  if (timeMatch) action = action.replace(timeMatch[0], ' ')
  if (seqMatch) action = action.replace(seqMatch[0], ' ')
  action = action.trim().replace(/\s+/g, ' ').slice(0, 16)
  const hasValue = detectConcreteData(segment).length > 0
  const relayed = RELAYED_RE.test(segment)
  return {
    prefix,
    family: familyMatch ? familyMatch[0] : prefix,
    time: timeMatch ? timeMatch[0] : null,
    sequence: seqMatch ? seqMatch[0] : null,
    action,
    condition: CONDITION_TOKEN_RE.test(rest),
    specified: hasValue && !relayed,
    relayed,
    reason: REASON_RE.test(segment),
    raw: segment,
  }
}

/** Count honorifics, ignoring a greeting. */
function countHonorifics(text: string): {
  ning: number
  nei: number
  ni: number
} {
  const ning = (text.match(/您/g) ?? []).length
  const nei = (text.match(/妳/g) ?? []).length
  const ni = (text.match(/你(?!好)/g) ?? []).length
  return { ning, nei, ni }
}

/** One field block: a run of consecutive label/value lines. */
interface FieldBlock {
  /** Number of lines in the block. */
  lines: number
  /** Whether a blank line separates the block from the prose. */
  separated: boolean
}

/**
 * Analyze the block structure of one message.
 *
 * A field block is a run of consecutive label/value lines; prose paragraphs
 * are the remaining lines, grouped by blank lines and field blocks.
 */
function analyzeBlocks(text: string): {
  blocks: FieldBlock[]
  labels: string[]
  multiline: boolean
  proseLines: number
  proseSentences: number
  proseParagraphs: number
  blankBoundaries: number
  proseClauses: number
  semicolonClauses: number
  colonParagraphs: number
  colonSerialParagraphs: number
  listMarkers: number
} {
  const lines = text.split('\n')
  const blocks: FieldBlock[] = []
  const labels: string[] = []
  let current: string[] = []
  let paragraph: string[] = []
  let proseLines = 0
  let proseSentences = 0
  let proseParagraphs = 0
  let blankBoundaries = 0
  let proseClauses = 0
  let semicolonClauses = 0
  let colonParagraphs = 0
  let colonSerialParagraphs = 0
  let listMarkers = 0
  let pendingBlank = false

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    proseParagraphs++
    const joined = paragraph.join('\n')
    const clauses = joined.split('；').length
    proseClauses += clauses
    semicolonClauses += clauses - 1
    if (COLON_RE.test(joined)) colonParagraphs++
    // A colon introduces a list whose items are separated by enumeration
    // commas: the field values stay on one line instead of one per line.
    if (COLON_RE.test(joined) && (joined.match(/、/g) ?? []).length >= 2) {
      colonSerialParagraphs++
    }
    paragraph = []
  }

  const flushBlock = (index: number) => {
    if (current.length === 0) return
    const beforeIndex = index - current.length - 1
    const beforeBlank =
      beforeIndex < 0 ? true : lines[beforeIndex].trim() === ''
    const afterBlank =
      index + 1 >= lines.length ? true : lines[index + 1].trim() === ''
    blocks.push({
      lines: current.length,
      separated: beforeBlank || afterBlank,
    })
    current = []
  }

  lines.forEach((line, index) => {
    if (LIST_MARKER_RE.test(line)) listMarkers++
    const labelMatch = /[。！？!?]/.test(line)
      ? null
      : LABELLED_LINE_RE.exec(line)
    if (labelMatch) {
      flushParagraph()
      pendingBlank = false
      current.push(line)
      labels.push(labelMatch[1])
      return
    }
    flushBlock(index)
    if (!line.trim()) {
      if (paragraph.length > 0) {
        flushParagraph()
        pendingBlank = true
      }
      return
    }
    if (pendingBlank && paragraph.length === 0 && proseParagraphs > 0) {
      blankBoundaries++
    }
    pendingBlank = false
    paragraph.push(line)
    proseLines++
    proseSentences += (line.match(/[。！？!?]/g) ?? []).length
  })
  flushBlock(lines.length)
  flushParagraph()

  return {
    blocks,
    labels,
    multiline: lines.length > 1,
    proseLines,
    proseSentences,
    proseParagraphs,
    blankBoundaries,
    proseClauses,
    semicolonClauses,
    colonParagraphs,
    colonSerialParagraphs,
    listMarkers,
  }
}

interface MessageNarrative {
  /** Roles of the message segments, in order. */
  roles: NarrativeRole[]
  /** Distinct roles of the message, in order of first appearance. */
  onset: NarrativeRole[]
  /** Concrete data kinds found in the message. */
  dataKinds: string[]
  /** Whether the message asks the recipient to do something. */
  hasRequest: boolean
  /** Whether the request leaves the decision to the recipient. */
  delegating: boolean
  /** Request frames parsed from the message. */
  frames: RequestFrame[]
  /** Instruction clauses (an action plus a value or a request prefix). */
  instructions: {
    total: number
    specified: number
    relayed: number
    withValue: number
    withReason: number
  }
  /** Whether the message marks action order explicitly. */
  sequenceOrdered: boolean
  /** Honorifics used in the message. */
  honorifics: { ning: number; nei: number; ni: number }
  /** Date wording used in the message. */
  dates: { relative: boolean; absolute: boolean }
  /** Field labels written as label/value lines. */
  labeledFields: string[]
  /** Whether concrete data is carried inside one paragraph. */
  inlineFields: boolean
  /** Whether the message uses line breaks. */
  multiline: boolean
  /** Absolute-date format used in the message. */
  dateFormat: 'iso' | 'short' | 'chinese' | 'none'
  /** Amount format used in the message. */
  amountFormat: 'with-tax' | 'breakdown' | 'plain' | 'none'
  /** Field blocks found in the message. */
  blocks: FieldBlock[]
  /** Prose paragraphs and their boundaries. */
  paragraphs: {
    count: number
    blankBoundaries: number
    clauses: number
    semicolonClauses: number
    colonParagraphs: number
    colonSerialParagraphs: number
  }
  /** Whether prose paragraphs are separated by a blank line. */
  paragraphsSeparated: boolean
  /** Ordered list markers used in the message. */
  listMarkers: number
  /** Closing phrases used in the message. */
  closings: string[]
  /** Request prefixes used in the message. */
  requestPrefixes: string[]
  /** Prose lines and their sentence terminators. */
  proseLines: number
  proseSentences: number
  /** Short snippets taken from this message, used as examples. */
  snippets: {
    amount: string | null
    date: string | null
    delegating: string | null
  }
}

/** Analyze one message. */
export function analyzeMessage(text: string): MessageNarrative {
  const segments = splitSegments(text)
  const roles: NarrativeRole[] = []
  const frames: RequestFrame[] = []
  const instructions = {
    total: 0,
    specified: 0,
    relayed: 0,
    withValue: 0,
    withReason: 0,
  }
  for (const segment of segments) {
    const role = scoreRole(segment)
    if (role) roles.push(role)
    const isCourtesy =
      ROLE_PATTERNS.closing.some((p) => p.test(segment)) && segment.length <= 12
    if (!isCourtesy) {
      const frame = parseRequestFrame(segment)
      if (frame) frames.push(frame)
    }
    // An instruction is executable: an action plus either a concrete value
    // or an explicit request prefix.
    const hasAction = ACTION_RE.test(segment)
    const hasValue = detectConcreteData(segment).length > 0
    if (hasAction && (hasValue || REQUEST_PREFIX_RE.test(segment))) {
      const relayed = RELAYED_RE.test(segment)
      instructions.total++
      if (hasValue) instructions.withValue++
      if (relayed) instructions.relayed++
      else if (hasValue) instructions.specified++
      if (REASON_RE.test(segment)) instructions.withReason++
    }
  }
  const onset: NarrativeRole[] = []
  for (const role of roles) {
    if (!onset.includes(role)) onset.push(role)
  }
  const dataKinds = detectConcreteData(text)
  const structure = analyzeBlocks(text)
  let dateFormat: MessageNarrative['dateFormat'] = 'none'
  if (ISO_DATE_RE.test(text)) dateFormat = 'iso'
  else if (CHINESE_DATE_RE.test(text)) dateFormat = 'chinese'
  else if (SHORT_DATE_RE.test(text)) dateFormat = 'short'
  let amountFormat: MessageNarrative['amountFormat'] = 'none'
  if (AMOUNT_BREAKDOWN_RE.test(text)) amountFormat = 'breakdown'
  else if (dataKinds.includes('amount')) amountFormat = 'with-tax'
  return {
    roles,
    onset,
    dataKinds,
    hasRequest: roles.includes('request'),
    delegating: DELEGATING_RE.test(text),
    frames,
    instructions,
    sequenceOrdered: SEQUENCE_PAIR_RE.test(text),
    honorifics: countHonorifics(text),
    dates: {
      relative: RELATIVE_DATE_RE.test(text),
      absolute: ABSOLUTE_DATE_RE.test(text),
    },
    labeledFields: structure.labels,
    inlineFields: dataKinds.length >= 2 && !structure.multiline,
    multiline: structure.multiline,
    dateFormat,
    amountFormat,
    blocks: structure.blocks,
    paragraphs: {
      count: structure.proseParagraphs,
      blankBoundaries: structure.blankBoundaries,
      clauses: structure.proseClauses,
      semicolonClauses: structure.semicolonClauses,
      colonParagraphs: structure.colonParagraphs,
      colonSerialParagraphs: structure.colonSerialParagraphs,
    },
    paragraphsSeparated: structure.blankBoundaries > 0,
    listMarkers: structure.listMarkers,
    closings: segments
      .filter(
        (segment) =>
          ROLE_PATTERNS.closing.some((p) => p.test(segment)) &&
          segment.length <= 12,
      )
      .map((segment) => segment.replace(/[。！!，,]/g, '')),
    requestPrefixes: frames.map((frame) => frame.prefix),
    proseLines: structure.proseLines,
    proseSentences: structure.proseSentences,
    snippets: {
      amount:
        segments.find((segment) =>
          DATA_PATTERNS.some((p) => p.kind === 'amount' && p.re.test(segment)),
        ) ?? null,
      date:
        segments.find((segment) =>
          DATA_PATTERNS.some((p) => p.kind === 'date' && p.re.test(segment)),
        ) ?? null,
      delegating:
        segments.find((segment) => DELEGATING_RE.test(segment)) ?? null,
    },
  }
}

/**
 * Build the dominant role ordering.
 *
 * A generic rhetorical skeleton (context -> delivery -> request -> condition
 * -> reason -> deadline -> closing) is used as the backbone, restricted to the
 * roles the sample actually contains. Sample evidence can override that
 * backbone, but only when it is decisive: a role must precede another one at
 * least twice as often as the reverse, and at least twice in absolute terms.
 */
function dominantOrdering(messages: MessageNarrative[]): {
  order: NarrativeRole[]
  concordance: number
} {
  const present = new Set(messages.flatMap((m) => m.roles))
  const before = new Map<string, number>()
  const key = (a: NarrativeRole, b: NarrativeRole) => `${a}>${b}`
  for (const message of messages) {
    for (let i = 0; i < message.roles.length; i++) {
      for (let j = i + 1; j < message.roles.length; j++) {
        const a = message.roles[i]
        const b = message.roles[j]
        if (a === b) continue
        const k = key(a, b)
        before.set(k, (before.get(k) ?? 0) + 1)
      }
    }
  }
  const edges = new Map<NarrativeRole, Set<NarrativeRole>>()
  for (const role of present) edges.set(role, new Set())
  // Backbone: the canonical skeleton over the roles present in the sample.
  const backbone = ROLE_CANONICAL.filter((role) => present.has(role))
  for (let i = 0; i < backbone.length - 1; i++) {
    edges.get(backbone[i])?.add(backbone[i + 1])
  }
  // Decisive overrides from the sample itself.
  for (const a of present) {
    for (const b of present) {
      if (a === b) continue
      const forward = before.get(key(a, b)) ?? 0
      const backward = before.get(key(b, a)) ?? 0
      if (forward >= 2 && forward >= backward * 2) {
        edges.get(a)?.add(b)
      }
    }
  }
  // Kahn's algorithm; ties fall back to the canonical skeleton.
  const remaining = new Set(present)
  const order: NarrativeRole[] = []
  while (remaining.size > 0) {
    const candidates = [...remaining].filter(
      (role) =>
        ![...remaining].some(
          (other) => other !== role && (edges.get(other)?.has(role) ?? false),
        ),
    )
    const next = candidates.sort(
      (a, b) => ROLE_CANONICAL.indexOf(a) - ROLE_CANONICAL.indexOf(b),
    )[0]
    const picked =
      next ??
      [...remaining].sort(
        (a, b) => ROLE_CANONICAL.indexOf(a) - ROLE_CANONICAL.indexOf(b),
      )[0]
    if (!picked) break
    order.push(picked)
    remaining.delete(picked)
  }
  // Concordance: messages whose own order agrees with the dominant order.
  const position = new Map(order.map((role, index) => [role, index]))
  let agree = 0
  let eligible = 0
  for (const message of messages) {
    if (message.onset.length < 2) continue
    eligible++
    const expected = [...message.onset].sort(
      (a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0),
    )
    if (expected.join('>') === message.onset.join('>')) agree++
  }
  return { order, concordance: eligible ? agree / eligible : 0 }
}

/** Summarize the request frames of the sample. */
function summarizeFrames(
  frames: RequestFrame[],
  instructions: {
    total: number
    specified: number
    relayed: number
    withValue: number
    withReason: number
  },
): NonNullable<NarrativeProfile['requestFrame']> | undefined {
  if (frames.length === 0 && instructions.total === 0) return undefined
  const prefixCounts = new Map<string, number>()
  for (const frame of frames) {
    prefixCounts.set(frame.prefix, (prefixCounts.get(frame.prefix) ?? 0) + 1)
  }
  const prefixEntry = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  const prefix = prefixEntry ? prefixEntry[0] : ''
  const prefixRate =
    prefixEntry && frames.length ? prefixEntry[1] / frames.length : 0
  const withTime = frames.filter((f) => f.time).length
  const withCondition = frames.filter((f) => f.condition).length
  const withSequence = frames.filter((f) => f.sequence).length
  const timeRate = frames.length ? withTime / frames.length : 0
  const conditionRate = frames.length ? withCondition / frames.length : 0
  const sequenceRate = frames.length ? withSequence / frames.length : 0
  const parts = prefix ? [prefix, '動作'] : ['動作']
  if (timeRate >= 0.3 && conditionRate >= 0.3) parts.push('時程／條件')
  else if (timeRate >= 0.3) parts.push('時程')
  else if (conditionRate >= 0.3) parts.push('條件')
  const template = parts.join(' ＋ ')
  // Prefer an example that carries the template's own adjuncts, then one
  // that uses the dominant prefix.
  const candidates = [...frames].sort((a, b) => {
    const score = (f: RequestFrame) =>
      (f.prefix === prefix ? 2 : 0) +
      (f.time ? 1 : 0) +
      (f.condition ? 1 : 0) +
      (f.sequence ? 1 : 0)
    return score(b) - score(a) || a.raw.length - b.raw.length
  })
  const example = candidates[0]?.raw ?? ''

  // Directive style: a directly executable value versus a relayed condition.
  // Only instructions that carry a value or a relayed condition decide the
  // style; plain instructions stay out of the comparison.
  const decisionBase = instructions.specified + instructions.relayed
  const directiveRate = decisionBase ? instructions.specified / decisionBase : 0
  const relayedRate = decisionBase ? instructions.relayed / decisionBase : 0
  const valueRate = instructions.total
    ? instructions.withValue / instructions.total
    : 0
  const reasonRate = instructions.total
    ? instructions.withReason / instructions.total
    : 0
  const style: 'directive' | 'relayed' | 'plain' =
    decisionBase > 0 && directiveRate >= 0.4 && directiveRate > relayedRate
      ? 'directive'
      : decisionBase > 0 && relayedRate >= 0.4 && relayedRate > directiveRate
        ? 'relayed'
        : 'plain'
  const styleExample =
    style === 'directive'
      ? (frames.find((f) => f.specified)?.raw ?? example)
      : style === 'relayed'
        ? (frames.find((f) => f.relayed)?.raw ?? example)
        : example

  return {
    sampleSize: frames.length,
    prefix,
    prefixRate: Math.round(prefixRate * 100) / 100,
    timeRate: Math.round(timeRate * 100) / 100,
    conditionRate: Math.round(conditionRate * 100) / 100,
    sequenceRate: Math.round(sequenceRate * 100) / 100,
    template,
    example: example.length > 32 ? `${example.slice(0, 31)}…` : example,
    directiveRate: Math.round(directiveRate * 100) / 100,
    relayedRate: Math.round(relayedRate * 100) / 100,
    valueRate: Math.round(valueRate * 100) / 100,
    reasonRate: Math.round(reasonRate * 100) / 100,
    style,
    styleExample:
      styleExample.length > 32 ? `${styleExample.slice(0, 31)}…` : styleExample,
  }
}

/**
 * Analyze the narrative structure of a set of the talker's own messages.
 *
 * @param texts - The user's sent message texts (sticker messages excluded).
 * @param chatIds - Optional conversation id per text, for per-chat honorific
 *   density.
 */
export function analyzeNarrative(
  texts: string[],
  chatIds?: string[],
): NarrativeProfile {
  const sampleSize = texts.length
  const messages = texts.map((text) => analyzeMessage(text))
  const totalSegments = texts.reduce(
    (sum, text) => sum + splitSegments(text).length,
    0,
  )
  const avgSegments = sampleSize
    ? Math.round((totalSegments / sampleSize) * 10) / 10
    : 0

  const roleCounts = new Map<NarrativeRole, number>()
  for (const message of messages) {
    for (const role of new Set(message.roles)) {
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1)
    }
  }
  const roleRates: Partial<Record<NarrativeRole, number>> = {}
  for (const [role, count] of roleCounts) {
    roleRates[role] = sampleSize
      ? Math.round((count / sampleSize) * 100) / 100
      : 0
  }

  const dataKinds = [
    ...new Set(messages.flatMap((message) => message.dataKinds)),
  ]
  const withData = messages.filter((m) => m.dataKinds.length > 0).length
  const withRequest = messages.filter((m) => m.hasRequest)
  const delegating = withRequest.filter((m) => m.delegating).length

  const { order, concordance } = dominantOrdering(messages)
  const distinctSubstantive = SUBSTANTIVE_ROLES.filter((role) =>
    roleCounts.has(role),
  ).length

  let sufficient = true
  let insufficientReason: string | undefined
  if (sampleSize < MIN_MESSAGES) {
    sufficient = false
    insufficientReason = `僅${sampleSize}則訊息,不足以推論段落順序`
  } else if (totalSegments < MIN_SEGMENTS) {
    sufficient = false
    insufficientReason = `僅${totalSegments}個邏輯段落,不足以推論段落順序`
  } else if (distinctSubstantive < 2) {
    sufficient = false
    insufficientReason = '樣本多為寒暄或單一功能訊息,未見多段式敘事'
  }

  // Request frames and instruction style.
  const frames = messages.flatMap((message) => message.frames)
  const instructionTotals = messages.reduce(
    (acc, message) => ({
      total: acc.total + message.instructions.total,
      specified: acc.specified + message.instructions.specified,
      relayed: acc.relayed + message.instructions.relayed,
      withValue: acc.withValue + message.instructions.withValue,
      withReason: acc.withReason + message.instructions.withReason,
    }),
    { total: 0, specified: 0, relayed: 0, withValue: 0, withReason: 0 },
  )
  const requestFrame = summarizeFrames(frames, instructionTotals)

  // Date wording.
  const dated = messages.filter((m) => m.dates.relative || m.dates.absolute)
  const relativeRate = dated.length
    ? dated.filter((m) => m.dates.relative).length / dated.length
    : 0
  const absoluteRate = dated.length
    ? dated.filter((m) => m.dates.absolute).length / dated.length
    : 0
  let preferred: NarrativeProfile['dateStyle']['preferred'] = 'none'
  if (dated.length > 0) {
    if (relativeRate - absoluteRate >= 0.15) preferred = 'relative'
    else if (absoluteRate - relativeRate >= 0.15) preferred = 'absolute'
    else preferred = 'mixed'
  }

  // Honorifics, globally and per conversation.
  const honorificMessages = messages.filter(
    (m) => m.honorifics.ning + m.honorifics.nei + m.honorifics.ni > 0,
  )
  const ningRate = sampleSize
    ? honorificMessages.filter((m) => m.honorifics.ning > 0).length / sampleSize
    : 0
  const neiRate = sampleSize
    ? honorificMessages.filter((m) => m.honorifics.nei > 0).length / sampleSize
    : 0
  const niRate = sampleSize
    ? honorificMessages.filter((m) => m.honorifics.ni > 0).length / sampleSize
    : 0
  const ningTotal = messages.reduce((sum, m) => sum + m.honorifics.ning, 0)
  const neiTotal = messages.reduce((sum, m) => sum + m.honorifics.nei, 0)
  const niTotal = messages.reduce((sum, m) => sum + m.honorifics.ni, 0)
  const totalHonorifics = ningTotal + neiTotal + niTotal
  const honorificRanking: [string, number][] = [
    ['您', ningTotal],
    ['妳', neiTotal],
    ['你', niTotal],
  ]
  const dominantHonorific =
    totalHonorifics === 0
      ? null
      : honorificRanking.sort((a, b) => b[1] - a[1])[0][0]
  const perChat = new Map<string, { ning: number; nei: number; ni: number }>()
  messages.forEach((message, index) => {
    const chatId = chatIds?.[index]
    if (!chatId) return
    const entry = perChat.get(chatId) ?? { ning: 0, nei: 0, ni: 0 }
    entry.ning += message.honorifics.ning
    entry.nei += message.honorifics.nei
    entry.ni += message.honorifics.ni
    perChat.set(chatId, entry)
  })
  const perChatHonorifics = [...perChat.entries()].map(([chatId, entry]) => {
    const chatMessages = messages.filter(
      (_, index) => chatIds?.[index] === chatId,
    )
    const withHonorific = chatMessages.filter(
      (m) => m.honorifics.ning + m.honorifics.nei + m.honorifics.ni > 0,
    ).length
    const ning = withHonorific
      ? Math.round(
          (chatMessages.filter((m) => m.honorifics.ning > 0).length /
            withHonorific) *
            100,
        ) / 100
      : 0
    const nei = withHonorific
      ? Math.round(
          (chatMessages.filter((m) => m.honorifics.nei > 0).length /
            withHonorific) *
            100,
        ) / 100
      : 0
    const chatTotal = entry.ning + entry.nei + entry.ni
    const chatRanking: [string, number][] = [
      ['您', entry.ning],
      ['妳', entry.nei],
      ['你', entry.ni],
    ]
    const chatDominant =
      chatTotal === 0 ? null : chatRanking.sort((a, b) => b[1] - a[1])[0][0]
    return { chatId, ningRate: ning, neiRate: nei, dominant: chatDominant }
  })

  const sequenceMarkerRate = sampleSize
    ? messages.filter((m) => m.sequenceOrdered).length / sampleSize
    : 0

  // Data layout: one field per line versus one dense paragraph.
  const labeledMessages = messages.filter((m) => m.labeledFields.length > 0)
  const labeledFieldTotal = messages.reduce(
    (sum, message) => sum + message.labeledFields.length,
    0,
  )
  const inlineFieldMessages = messages.filter((m) => m.inlineFields).length
  const multilineMessages = messages.filter((m) => m.multiline).length
  const dateFormatCounts = { iso: 0, short: 0, chinese: 0 }
  const amountFormatCounts = { 'with-tax': 0, breakdown: 0, plain: 0 }
  for (const message of messages) {
    if (message.dateFormat !== 'none') dateFormatCounts[message.dateFormat]++
    if (message.amountFormat !== 'none')
      amountFormatCounts[message.amountFormat]++
  }
  const dateFormat = dominantFormat(
    dateFormatCounts,
  ) as DataLayoutProfile['dateFormat']
  const amountFormat = dominantFormat(
    amountFormatCounts,
  ) as DataLayoutProfile['amountFormat']
  const labels = [
    ...new Set(messages.flatMap((message) => message.labeledFields)),
  ]
  const dataLayout: DataLayoutProfile = {
    labeledLineRate: sampleSize
      ? Math.round((labeledMessages.length / sampleSize) * 100) / 100
      : 0,
    labeledFieldsPerMessage: sampleSize
      ? Math.round((labeledFieldTotal / sampleSize) * 10) / 10
      : 0,
    inlineFieldRate: sampleSize
      ? Math.round((inlineFieldMessages / sampleSize) * 100) / 100
      : 0,
    multilineRate: sampleSize
      ? Math.round((multilineMessages / sampleSize) * 100) / 100
      : 0,
    dateFormat,
    amountFormat,
    labels,
  }

  // Block structure: prose paragraphs versus runs of field lines.
  const allBlocks = messages.flatMap((message) => message.blocks)
  const separatedBlocks = allBlocks.filter((block) => block.separated).length
  const totalProseLines = messages.reduce(
    (sum, message) => sum + message.proseLines,
    0,
  )
  const totalProseSentences = messages.reduce(
    (sum, message) => sum + message.proseSentences,
    0,
  )
  const paragraphCount = messages.reduce(
    (sum, message) => sum + message.paragraphs.count,
    0,
  )
  const paragraphBlankBoundaries = messages.reduce(
    (sum, message) => sum + message.paragraphs.blankBoundaries,
    0,
  )
  const proseClauseTotal = messages.reduce(
    (sum, message) => sum + message.paragraphs.clauses,
    0,
  )
  const semicolonClauseTotal = messages.reduce(
    (sum, message) => sum + message.paragraphs.semicolonClauses,
    0,
  )
  const colonParagraphTotal = messages.reduce(
    (sum, message) => sum + message.paragraphs.colonParagraphs,
    0,
  )
  const colonSerialTotal = messages.reduce(
    (sum, message) => sum + message.paragraphs.colonSerialParagraphs,
    0,
  )
  const listMarkerMessages = messages.filter((m) => m.listMarkers > 0).length
  const blocks: BlockStructureProfile = {
    paragraphBlankLineRate: paragraphCount
      ? Math.round((paragraphBlankBoundaries / paragraphCount) * 100) / 100
      : 0,
    semicolonClauseRate: proseClauseTotal
      ? Math.round((semicolonClauseTotal / proseClauseTotal) * 100) / 100
      : 0,
    colonFieldSerialRate: colonParagraphTotal
      ? Math.round((colonSerialTotal / colonParagraphTotal) * 100) / 100
      : 0,
    listMarkerRate: sampleSize
      ? Math.round((listMarkerMessages / sampleSize) * 100) / 100
      : 0,
    fieldBlockRate: sampleSize
      ? Math.round(
          (messages.filter((m) => m.blocks.length > 0).length / sampleSize) *
            100,
        ) / 100
      : 0,
    blocksPerMessage: sampleSize
      ? Math.round((allBlocks.length / sampleSize) * 10) / 10
      : 0,
    avgLinesPerBlock: allBlocks.length
      ? Math.round(
          (allBlocks.reduce((sum, block) => sum + block.lines, 0) /
            allBlocks.length) *
            10,
        ) / 10
      : 0,
    blankLineSeparatedRate: allBlocks.length
      ? Math.round((separatedBlocks / allBlocks.length) * 100) / 100
      : 0,
    proseSentenceRatio: totalProseLines
      ? Math.round((totalProseSentences / totalProseLines) * 100) / 100
      : 0,
  }

  const prefixCounter = new Map<string, number>()
  for (const message of messages) {
    for (const prefix of message.requestPrefixes) {
      prefixCounter.set(prefix, (prefixCounter.get(prefix) ?? 0) + 1)
    }
  }
  const requestVerbs = [...prefixCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([prefix, count]) => ({
      prefix,
      count,
      rate: sampleSize ? Math.round((count / sampleSize) * 100) / 100 : 0,
    }))
  const closingCounter = new Map<string, number>()
  for (const message of messages) {
    for (const closing of message.closings) {
      closingCounter.set(closing, (closingCounter.get(closing) ?? 0) + 1)
    }
  }
  const closings = [...closingCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([text, count]) => ({
      text,
      count,
      rate: sampleSize ? Math.round((count / sampleSize) * 100) / 100 : 0,
    }))

  const profile: NarrativeProfile = {
    heuristic: true,
    sampleSize,
    segmentCount: totalSegments,
    avgSegmentsPerMessage: avgSegments,
    roleRates,
    dominantOrder: order,
    orderConcordance: Math.round(concordance * 100) / 100,
    concreteDataRate: sampleSize
      ? Math.round((withData / sampleSize) * 100) / 100
      : 0,
    concreteDataKinds: dataKinds,
    requestRate: sampleSize
      ? Math.round((withRequest.length / sampleSize) * 100) / 100
      : 0,
    delegatingRequestRate: withRequest.length
      ? Math.round((delegating / withRequest.length) * 100) / 100
      : 0,
    dateStyle: {
      relativeRate: Math.round(relativeRate * 100) / 100,
      absoluteRate: Math.round(absoluteRate * 100) / 100,
      preferred,
    },
    honorifics: {
      ningRate: Math.round(ningRate * 100) / 100,
      neiRate: Math.round(neiRate * 100) / 100,
      niRate: Math.round(niRate * 100) / 100,
      dominant: dominantHonorific,
      perChat: perChatHonorifics,
    },
    sequenceMarkerRate: Math.round(sequenceMarkerRate * 100) / 100,
    snippets: {
      amount: messages.find((m) => m.snippets.amount)?.snippets.amount ?? null,
      date: messages.find((m) => m.snippets.date)?.snippets.date ?? null,
      delegating:
        messages.find((m) => m.snippets.delegating)?.snippets.delegating ??
        null,
    },
    requestVerbs,
    closings,
    dataLayout,
    blocks,
    sufficient,
  }
  if (insufficientReason) profile.insufficientReason = insufficientReason
  if (requestFrame) profile.requestFrame = requestFrame
  return profile
}

/**
 * Pick the most frequent format, or 'none' when the sample contains no
 * instance of any format (an empty counter must not report a winner).
 */
function dominantFormat(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0 || entries[0][1] === 0) return 'none'
  return entries[0][0]
}

function densityLabel(rate: number): '高' | '中' | '低' {
  if (rate >= 0.4) return '高'
  if (rate >= 0.15) return '中'
  return '低'
}

/**
 * Turn the narrative profile into guidance lines.
 *
 * Every line describes THIS talker (derived from the sample) and quotes the
 * talker's own wording, so a drafting agent can imitate the habit instead of
 * a generic rule.
 */
export function narrativeGuideLines(profile: NarrativeProfile): string[] {
  const lines: string[] = []
  if (!profile.sufficient) {
    lines.push(
      `敘事結構(啟發式近似):資料不足(${profile.insufficientReason ?? '樣本不足'}),暫不推論訊息的段落順序`,
    )
  } else {
    const order = profile.dominantOrder
    if (order.length > 0) {
      const rendered = order
        .map((role, index) =>
          index === 0
            ? `先${NARRATIVE_ROLE_LABELS[role]}`
            : NARRATIVE_ROLE_LABELS[role],
        )
        .join(' → ')
      lines.push(
        `敘事結構(啟發式近似):此對話者的常見順序為 ${rendered};起草時依此順序分段,不要把現況、請求與條件混在同一句`,
      )
    }
    if (profile.avgSegmentsPerMessage >= 2) {
      lines.push(
        `敘事結構(啟發式近似):此對話者以多段式訊息為主(平均每則${profile.avgSegmentsPerMessage}段),一段講一件事`,
      )
    }
  }

  // Request frame — reported whenever at least one frame was seen, even when
  // the overall sample is too small for a full narrative description.
  const frame = profile.requestFrame
  if (frame) {
    if (frame.sampleSize > 0) {
      const habit = frame.sampleSize >= 2 ? '多以' : '曾以'
      const sequenceNote =
        frame.sequenceRate >= 0.4 ? ';並以『先／再』標示動作次序' : ''
      lines.push(
        `請求骨架(啟發式近似):此對話者的請求${habit}『${frame.template}』起句(樣本摘錄:${frame.example})${sequenceNote}`,
      )
    }
    // Directive style: an executable value versus a relayed condition.
    const valueNote =
      frame.valueRate >= 0.4 ? ',多含明確日期／金額／編號等可執行值' : ''
    if (frame.style === 'directive') {
      lines.push(
        `指示方式(啟發式近似):此對話者偏向直接給出具體值(約${Math.round(frame.directiveRate * 100)}%${valueNote},樣本摘錄:${frame.styleExample}),較少轉述第三方條件`,
      )
    } else if (frame.style === 'relayed') {
      lines.push(
        `指示方式(啟發式近似):此對話者偏向轉述條件或理由(約${Math.round(frame.relayedRate * 100)}%,樣本摘錄:${frame.styleExample}),較少直接給出可執行值`,
      )
    }
  }

  // Data layout: one field per line versus one dense paragraph.
  const layout = profile.dataLayout
  if (layout.labeledLineRate >= 0.4) {
    const labelText = layout.labels.length
      ? layout.labels
          .slice(0, 4)
          .map((label) => `${label}：…`)
          .join('／')
      : '標籤：…'
    lines.push(
      `列舉版面(啟發式近似):此對話者常把具體欄位以『標籤：值』逐行列出(約${Math.round(layout.labeledLineRate * 100)}%的訊息如此,例如${labelText}),方便對方閱讀與複製`,
    )
  } else if (layout.inlineFieldRate >= 0.4) {
    lines.push(
      `列舉版面(啟發式近似):此對話者常把具體欄位併在同一段(約${Math.round(layout.inlineFieldRate * 100)}%的訊息如此),而非逐行列出`,
    )
  }

  // Paragraph structure: blank-line separation, semicolon clauses, colon
  // fields, list markers.
  const blocks = profile.blocks
  if (blocks.paragraphBlankLineRate >= 0.3) {
    lines.push(
      `段落結構(啟發式近似):此對話者的段落之間多以空行分隔(約${Math.round(blocks.paragraphBlankLineRate * 100)}%的段落邊界),段內以『；』分項的比例約${Math.round(blocks.semicolonClauseRate * 100)}%`,
    )
  }
  if (blocks.semicolonClauseRate >= 0.2) {
    const semicolonLine = `段內分項(啟發式近似):此對話者常以『；』在同一段內分項(約${Math.round(blocks.semicolonClauseRate * 100)}%的敘述分句)`
    const markerLine =
      blocks.listMarkerRate <= 0.1 ? ';且幾乎不使用條列編號' : ''
    lines.push(semicolonLine + markerLine)
  } else if (blocks.listMarkerRate <= 0.1 && profile.sampleSize >= 3) {
    lines.push(
      `條列編號(啟發式近似):此對話者幾乎不使用條列編號(樣本中約${Math.round(blocks.listMarkerRate * 100)}%含編號列示)`,
    )
  }
  if (blocks.colonFieldSerialRate >= 0.3) {
    lines.push(
      `冒號欄位(啟發式近似):此對話者常以冒號帶出欄位並在同段內以頓號串列(約${Math.round(blocks.colonFieldSerialRate * 100)}%的含冒號段落)`,
    )
  }

  // Request verb families and closing habits.
  if (profile.requestVerbs.length > 0) {
    const verbText = profile.requestVerbs
      .filter((entry) => entry.rate >= 0.1)
      .map((entry) => `『${entry.prefix}』約${Math.round(entry.rate * 100)}%`)
      .join('、')
    if (verbText) {
      lines.push(`請求動詞(啟發式近似):此對話者的請求動詞以${verbText}為主`)
    }
  }
  if (profile.closings.length > 0) {
    const closingText = profile.closings
      .filter((entry) => entry.rate >= 0.1)
      .map((entry) => `『${entry.text}』約${Math.round(entry.rate * 100)}%`)
      .join('、')
    if (closingText) {
      lines.push(`收尾語型(啟發式近似):此對話者常以${closingText}收尾`)
    }
  }

  // Block structure: prose paragraphs versus field blocks.
  if (blocks.fieldBlockRate >= 0.3 && blocks.avgLinesPerBlock >= 1) {
    lines.push(
      `區塊結構(啟發式近似):此對話者常把欄位項目集中成塊列示(約${Math.round(blocks.fieldBlockRate * 100)}%的訊息含欄位塊,平均每則${blocks.blocksPerMessage}塊、每塊約${blocks.avgLinesPerBlock}行),塊與本文以空行分隔的比例約${Math.round(blocks.blankLineSeparatedRate * 100)}%`,
    )
  }
  if (blocks.proseSentenceRatio > 0 && layout.multilineRate >= 0.2) {
    if (blocks.proseSentenceRatio >= 0.7) {
      lines.push(
        `敘述行文(啟發式近似):此對話者的本文每行一句、句中不拆行(平均每行約${blocks.proseSentenceRatio}個句號),段落之間以空行分隔的比例約${Math.round(blocks.paragraphBlankLineRate * 100)}%`,
      )
    } else {
      lines.push(
        `敘述行文(啟發式近似):此對話者的敘述句會跨行(平均每行約${blocks.proseSentenceRatio}個句號),起草時可讓一句寫完`,
      )
    }
  }

  const dateExample = profile.snippets.date
  if (layout.dateFormat === 'short') {
    lines.push(
      `日期寫法(啟發式近似):此對話者以短式月/日為主${dateExample ? `(樣本:${dateExample})` : ''},不用完整年月日`,
    )
  } else if (layout.dateFormat === 'iso') {
    lines.push(
      `日期寫法(啟發式近似):此對話者以完整年/月/日為主${dateExample ? `(樣本:${dateExample})` : ''}`,
    )
  } else if (layout.dateFormat === 'chinese') {
    lines.push(
      `日期寫法(啟發式近似):此對話者以中文月日為主${dateExample ? `(樣本:${dateExample})` : ''}`,
    )
  }
  const amountExample = profile.snippets.amount
  if (layout.amountFormat === 'with-tax') {
    lines.push(
      `金額寫法(啟發式近似):此對話者直接寫含稅總額${amountExample ? `(樣本:${amountExample})` : ''},不拆列稅額明細`,
    )
  } else if (layout.amountFormat === 'breakdown') {
    lines.push(
      `金額寫法(啟發式近似):此對話者會拆列金額明細${amountExample ? `(樣本:${amountExample})` : ''}`,
    )
  }

  // Date wording.
  const dates = profile.dateStyle
  if (dates.preferred === 'relative') {
    lines.push(
      `日期用語(啟發式近似):此對話者的時程用語以相對日為主(今天／星期幾／下週幾),約${Math.round(dates.relativeRate * 100)}%含相對日,少用完整日期`,
    )
  } else if (dates.preferred === 'absolute') {
    lines.push(
      `日期用語(啟發式近似):此對話者的時程用語以絕對日期為主(YYYY/MM/DD),約${Math.round(dates.absoluteRate * 100)}%含絕對日期`,
    )
  } else if (dates.preferred === 'mixed') {
    lines.push(
      `日期用語(啟發式近似):此對話者相對日與絕對日期並用(相對日約${Math.round(dates.relativeRate * 100)}%、絕對日期約${Math.round(dates.absoluteRate * 100)}%)`,
    )
  }

  // Honorific habits.
  const honorifics = profile.honorifics
  if (honorifics.dominant) {
    const parts = [`『您』約${Math.round(honorifics.ningRate * 100)}%`]
    if (honorifics.neiRate > 0)
      parts.push(`『妳』約${Math.round(honorifics.neiRate * 100)}%`)
    lines.push(
      `敬語(啟發式近似):此對話者以『${honorifics.dominant}』為主(${parts.join('、')}),對不同對象沿用其稱呼習慣`,
    )
  }

  // Explicit action ordering.
  if (profile.sequenceMarkerRate >= 0.2) {
    lines.push(
      '順序標記(啟發式近似):此對話者常在同一則訊息內以『先…再…』標示動作先後',
    )
  }

  if (!profile.sufficient) return lines

  // Concrete data density.
  const density = densityLabel(profile.concreteDataRate)
  const kindLabels = DATA_PATTERNS.filter((p) =>
    profile.concreteDataKinds.includes(p.kind),
  ).map((p) => p.label)
  if (density === '低') {
    lines.push(
      `具體資料密度(啟發式近似):此對話者的訊息少含實體資料(約${Math.round(profile.concreteDataRate * 100)}%含日期／金額／編號／地址)`,
    )
  } else {
    lines.push(
      `具體資料密度(啟發式近似):此對話者的訊息常含實體資料(約${Math.round(profile.concreteDataRate * 100)}%含${kindLabels.join('、') || '具體資料'}),起草時同樣填入具體數值、日期、編號與地址`,
    )
  }

  // Request style.
  if (profile.requestRate > 0) {
    const delegatingExample = profile.snippets.delegating
    if (profile.delegatingRequestRate >= 0.2) {
      lines.push(
        `請求明確性(啟發式近似):此對話者常把判斷權交給對方並附帶預設動作(約${Math.round(profile.delegatingRequestRate * 100)}%${delegatingExample ? `(樣本:${delegatingExample})` : ''}),起草時保留這種條件式請求`,
      )
    } else {
      lines.push(
        `請求明確性(啟發式近似):此對話者多為直接指示(把判斷權交給對方者約${Math.round(profile.delegatingRequestRate * 100)}%)`,
      )
    }
  }
  return lines
}
