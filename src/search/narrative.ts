/**
 * Structural style analysis of the user's own LINE messages.
 *
 * Style is modelled as a set of PREDEFINED, INTERPRETABLE attributes, in the
 * tradition of the linguistic-style survey literature (predefined features are
 * interpretable; automatically learned features are effective but opaque).
 * The dimensions follow the three Halliday metafunctions:
 *
 *   - ideational: content and information structure (where a concrete value
 *     sits relative to the action verb, how dates and amounts are written,
 *     whether the topic is stated first),
 *   - interpersonal: speech acts and relational strategy (which speech act,
 *     where a request sits on the politeness strategy ladder, which moves
 *     reduce imposition, where a reason comes from),
 *   - textual: unit division and cohesion (which units a message is cut
 *     into, how they are separated, how fields are arranged, and which unit
 *     follows which).
 *
 * Function-word and closing frequencies are reported as an IDENTIFICATION
 * dimension only (stylometry: function words identify an author well, they do
 * not tell a model how to imitate that author). Every other rule is an
 * executable instruction backed by a rate or by the talker's own wording.
 *
 * EVERYTHING HERE IS A KEYWORD + PUNCTUATION HEURISTIC, not semantic
 * understanding, and every reported attribute is derived from the analyzed
 * sample. Callers must label the result as an approximation and must
 * suppress a dimension when the sample is too small or too flat to describe.
 */

/** Speech act performed by one clause. */
export type SpeechAct =
  | 'statement'
  | 'explanation'
  | 'request'
  | 'question'
  | 'confirmation'
  | 'thanks'

/** Chinese label per speech act. */
export const SPEECH_ACT_LABELS: Record<SpeechAct, string> = {
  statement: '陳述',
  explanation: '說明理由或背景',
  request: '請求',
  question: '詢問',
  confirmation: '確認',
  thanks: '致謝',
}

/**
 * Position of a request on the politeness strategy ladder (Brown & Levinson):
 * a bald-on-record imperative, a negative-politeness request that fronts a
 * mitigation marker, or an off-record/conditional request.
 */
export type PolitenessStrategy =
  | 'bald-on-record'
  | 'negative-politeness'
  | 'off-record'

/** Chinese label per politeness strategy. */
export const POLITENESS_LABELS: Record<PolitenessStrategy, string> = {
  'bald-on-record': '直接祈使',
  'negative-politeness': '迂迴請求(降低 imposition)',
  'off-record': '條件式暗示',
}

/** Structural shape of a request clause. */
export type RequestForm =
  | 'mitigation-preposed'
  | 'qing-vp'
  | 'yao-vp'
  | 'bare-vp'
  | 'conditional-query'

/** Discourse unit a message line is cut into. */
export type UnitKind = 'narrative' | 'field' | 'list' | 'request' | 'thanks'

/** Chinese label per unit kind. */
export const UNIT_KIND_LABELS: Record<UnitKind, string> = {
  narrative: '敘述單位',
  field: '欄位單位',
  list: '條列單位',
  request: '請求單位',
  thanks: '致謝單位',
}

/**
 * A mitigation marker: a politeness cost marker placed in front of the verb
 * phrase. Generic Chinese politeness vocabulary, not any talker's phrasing.
 */
const MITIGATION_RE =
  /(?:再|又|再要|要|得)?(?:麻煩|拜託|幫忙|勞煩|煩請|敬請)(?:您|妳|你)?/

/** "qing" as a politeness marker in front of the verb phrase. */
const QING_RE = /請(?!購|於|假|求|客)(?:您|妳|你)?/

/** Markers of a request that hands the decision back to the recipient. */
const CONDITIONAL_RE =
  /可否|可不可以|能不能|是否|有沒有|要不要|好不[好]|行嗎|OK嗎|對不對|沒有的話|需要的話|如無|若無|不行的話|有問題的話|自行|看要不要/

/** Markers of an attached reason or of the circumstance a request rests on. */
const REASON_MARKER_RE =
  /因為|所以|由於|原因|理由|用途|要用來|要看|需求是|才請得到|退件|被退|退回|跑得完|跑不完|來不及|沒時間|延後|缺件|比較急|比較趕|趕時間/

/** Markers of an explicit confirmation request. */
const CONFIRM_RE = /確認|核對|看一下|看過|過目|簽核|回覆我|回報我/

/** Markers of a courtesy closing. */
const THANKS_RE = /謝謝|感謝|多謝|感恩|辛苦了|麻煩(?:你|妳|您)了|thanks/i

/** Action verbs that make a clause executable. */
const ACTION_RE =
  /開|寄|附|回傳|回覆|回報|寫|蓋|簽|送|做|處理|給|打|填|核|付|收|取|拿|提出|辦|列|報|發|匯|印|傳|上傳|確認/

/**
 * Acknowledgements of receipt or understanding are not directives, even
 * though they may contain an action verb.
 */
const ACK_RE = /^(?:收到|知道了|了解|好的|嗯+|OK|ok|收到[。！!]?)/

/**
 * A clause that OPENS with an action verb (optionally behind an adverb or a
 * politeness marker). Only such a clause is a bare imperative: a clause that
 * merely contains a verb states an arrangement, it does not ask for
 * anything.
 */
const ACTION_START_RE =
  /^(?:再|先|就|也|順|順便|代|幫|麻煩|拜託|幫忙|請|要|得|必須|需|需要|未|不)*\s*(?:開|寄|寄出|送|寫|寫好|蓋|做|做一份|填|打|印|傳|附|回傳|回覆|回報|處理|提出|上傳|確認|整理|備妥|產出|簽)/

/** A clause that names its own subject at the front. */
const SUBJECT_START_RE =
  /^(?:我|我們|咱們|本人|咱|它|他們|對方|院方|廠商|客戶|台大|臺大)/

/** A clause that mentions a subject anywhere. */
const SUBJECT_RE = /我|咱|本人/

/** Subordinators that open a clause. */
const SUBORDINATOR_RE = /^(?:因為|由於|所以|如果|若|當|既然|至於|另外)/

/**
 * Markers of a THIRD PARTY inside a reason clause. A reason is relayed only
 * when it points at somebody else's requirement; a reason the talker gives
 * for his own arrangement is self-stated.
 */
const THIRD_PARTY_RE =
  /對方|院方|客戶|廠商|學校|甲方|乙方|合約|報價單|規定|要求|依.+?(?:規定|要求|合約)|照.+?(?:規定|要求|合約)|上面|對上面/

/** Markers of a RELAYED condition: a third party's requirement. */
const RELAYED_RE =
  /含以後|含以前|以前|以後|以內|以上|以下|不超過|不得|至少|依|按照|照|規定|要求|合約|報價單|對方|院方|客戶|需符合|符合|條件/

/** Markers of the talker describing his own situation. */
const SELF_STATE_RE =
  /我這邊|我們這邊|目前|現在|進度|狀況|原來|先前|照之前|照我們|都跑完|跑完了|退件|已經|先說|補充|對了/

/** Relative time words (today, a weekday, next week). */
const RELATIVE_DATE_RE =
  /今天|明天|後天|大後天|昨天|早上|下午|晚上|週[一二三四五六日天]|星期[一二三四五六日天]|禮拜[一二三四五六日天]|下週[一二三四五六日天]|下個星期[一二三四五六日天]|下個月|月底|月初|年底|今年|週末/

/** Absolute date formats (year/month/day, month/day, Chinese month-day). */
const ABSOLUTE_DATE_RE =
  /\d{4}\s*[-/年]\s*\d{1,2}|\d{1,2}\s*[-/]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日/

/** A line written as one "label：value" pair. */
const LABELLED_LINE_RE =
  /^\s*([^\s：:，,。！？!?；;、]{1,12})\s*[:：]\s*([^：:、]+?)\s*$/

/** A "label：value" pair inside a line. */
const FIELD_PAIR_RE =
  /([^\s：:，,。！？!?；;、]{1,12})\s*[:：]\s*[^：:、，,。！？!?；;]+/g

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

/** Sentence-final mood particles. */
const MOOD_PARTICLES = ['嗎', '呢', '喔', '哦', '啦', '耶', '吧', '啊']

/** Concrete data kinds, with the regex that detects each of them. */
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

/** Minimum messages before the style dimension is reported at all. */
const MIN_MESSAGES = 2
/** Minimum clauses before the style dimension is reported at all. */
const MIN_CLAUSES = 6
/** Longest verbatim example printed in the guide. */
const MAX_EXAMPLE_CHARS = 180

/**
 * One parsed request frame.
 *
 * Kept for callers that want the literal prefix of a request clause; the
 * frame is EVIDENCE for the request structure, not a feature of its own.
 */
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

/** Punctuation and emoji habits. */
export interface ToneStats {
  /** Share of messages containing an emoji. */
  emojiRate: number
  /** Share of messages ending with a question mark. */
  questionRate: number
  /** Share of messages containing an exclamation mark. */
  exclamationRate: number
  /** Share of messages containing a tilde. */
  tildeRate: number
  /** Share of messages containing quotation marks. */
  quoteMarkRate: number
  /** Share of messages containing an ellipsis. */
  ellipsisRate: number
}

/** One step of a situation recipe. */
export interface RecipeStep {
  /** What the step does, described as an action or a speech act. */
  description: string
  /** Share of the recipe's messages that carry this step. */
  rate: number
  /** A verbatim excerpt from the talker's own message, when one exists. */
  quote: string | null
}

/** A drafting recipe derived from one recurring situation. */
export interface Recipe {
  /** Stable identifier of the situation. */
  id: string
  /** Chinese title of the situation. */
  title: string
  /** How many sample messages belong to this situation. */
  sampleSize: number
  /** Share of the sample that belongs to this situation. */
  rate: number
  /** The observed steps, in the order they were seen. */
  steps: RecipeStep[]
}

/** A verbatim message of the talker, kept as the strongest style evidence. */
export interface StyleExample {
  /** The situation the message belongs to. */
  situation: string
  /** The talker's own message, verbatim. */
  text: string
}

/** Something this talker does NOT do, with the evidence behind it. */
export interface Prohibition {
  /** What must not be added. */
  text: string
  /** The evidence for the prohibition. */
  evidence: string
}

/** One observed transition between two adjacent behaviours. */
export interface Transition {
  /** Whether the transition is between speech acts or between units. */
  scope: 'act' | 'unit'
  /** Label of the behaviour that comes first. */
  from: string
  /** Label of the behaviour that comes next. */
  to: string
  /** How many times the transition was seen. */
  count: number
  /** Share of all transitions of the same scope. */
  rate: number
}

/** Per-recipient register differences (tenor). */
export interface RegisterProfile {
  /** The conversation the register was measured on. */
  chatId: string
  /** How many messages of that conversation were analyzed. */
  messageCount: number
  /** How many requests the conversation contains. */
  requestBase: number
  /** Share of those requests that front a mitigation marker. */
  mitigationRate: number
  /** The honorific used most in that conversation. */
  honorific: string | null
}

/** Structural style of the talker's messages. */
export interface NarrativeProfile {
  /** Always true — the analysis is a keyword/punctuation heuristic. */
  heuristic: true
  /** Number of user messages analyzed. */
  sampleSize: number
  /** Number of clauses analyzed. */
  clauseCount: number

  /** ideational: where a concrete value sits relative to the action verb. */
  valuePosition: {
    /** Value before the action (background first). */
    preposed: number
    /** Value after the action (supplementary). */
    postposed: number
    /** How many clauses decided the position. */
    base: number
  }
  /** ideational: share of messages whose first clause states the topic. */
  topicFirstRate: number
  /** ideational: relative vs absolute date wording. */
  dateStyle: {
    /** Share of dated messages using a relative day word. */
    relativeRate: number
    /** Share of dated messages using an absolute date. */
    absoluteRate: number
    /** Which wording dominates. */
    preferred: 'relative' | 'absolute' | 'mixed' | 'none'
  }
  /** ideational: dominant absolute-date format. */
  dateFormat: 'iso' | 'short' | 'chinese' | 'none'
  /** ideational: dominant amount format. */
  amountFormat: 'with-tax' | 'breakdown' | 'plain' | 'none'
  /** ideational: share of messages carrying at least one concrete value. */
  concreteDataRate: number
  /** Concrete data kinds seen in the sample. */
  concreteDataKinds: string[]

  /** interpersonal: share of clauses per speech act. */
  actRates: { act: SpeechAct; label: string; count: number; rate: number }[]
  /** interpersonal: position of requests on the politeness ladder. */
  strategyRates: {
    strategy: PolitenessStrategy
    label: string
    count: number
    rate: number
  }[]
  /** How many requests the strategy rates are measured on. */
  requestBase: number
  /** interpersonal: moves that reduce imposition, measured on requests. */
  mitigationMoves: {
    /** Share of requests that carry a reason. */
    reason: number
    /** Share of requests that carry a deadline. */
    deadline: number
    /** Share of requests that hand the decision back. */
    delegation: number
    /** How many requests decided the moves. */
    base: number
  }
  /** interpersonal: where a reason comes from. */
  reasonSource: {
    /** Reasons the talker gives for himself. */
    self: number
    /** Reasons relayed from a third party. */
    relayed: number
    /** How many reasons decided the source. */
    base: number
  }
  /** interpersonal: irrelevant self-description inside requests. */
  selfDisclosure: {
    /** Share of requests that carry unrelated self-description. */
    rate: number
    /** How many requests decided the disclosure. */
    base: number
    /** A verbatim example, when one exists. */
    example: string | null
  }
  /** interpersonal: honorific habits (IDENTIFICATION dimension). */
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
  /** interpersonal: per-recipient register differences. */
  registers: RegisterProfile[]

  /** textual: share of discourse units per unit kind. */
  unitRates: {
    kind: UnitKind
    label: string
    count: number
    rate: number
  }[]
  /** textual: unit separation and field arrangement. */
  layout: {
    /** Share of unit boundaries separated by a blank line. */
    blankSeparatedRate: number
    /** Average number of units per message. */
    unitsPerMessage: number
    /** Average number of field pairs per field unit. */
    fieldsPerUnit: number
    /** Field labels actually used. */
    labels: string[]
    /** Share of field units that carry exactly one label/value pair. */
    fieldPerLineRate: number
    /** Share of field units that carry several pairs on one line. */
    fieldSerialRate: number
    /** How many field units decided the arrangement. */
    base: number
  }
  /** textual: observed transitions between adjacent behaviours. */
  transitions: Transition[]

  /** Drafting recipes derived from the sample's own messages. */
  recipes: Recipe[]
  /** Verbatim messages of the talker, grouped by situation. */
  examples: StyleExample[]
  /** Things this talker does not do. */
  prohibitions: Prohibition[]
  /** Dimensions this sample cannot support. */
  uncertainties: string[]
  /** Punctuation and emoji habits. */
  tone: ToneStats
  /**
   * Verbatim excerpts from the talker's own messages, one per feature (the
   * excerpt of a rule MUST be the excerpt of the feature that rule is about).
   */
  snippets: {
    /** A clause carrying an amount. */
    amount: string | null
    /** A clause carrying a date. */
    date: string | null
    /** A clause carrying a relative day word. */
    relativeDate: string | null
    /** A clause carrying an absolute date. */
    absoluteDate: string | null
    /** A clause carrying a short month/day date. */
    dateShort: string | null
    /** A clause carrying a full year/month/day date. */
    dateIso: string | null
    /** A clause carrying a Chinese month/day date. */
    dateChinese: string | null
    /** A request that fronts a mitigation marker. */
    mitigated: string | null
    /** A direct request (imperative). */
    imperative: string | null
    /** A conditional request. */
    conditional: string | null
    /** A field unit that carries exactly one label/value pair. */
    fieldPerLine: string | null
    /** A field unit that carries several label/value pairs. */
    fieldSerial: string | null
    /** A clause whose value comes before the action verb. */
    valuePreposed: string | null
    /** A clause whose value comes after the action verb. */
    valuePostposed: string | null
    /** A reason the talker gives for himself. */
    selfReason: string | null
    /** A reason relayed from a third party. */
    relayedReason: string | null
    /** A request carrying unrelated self-description. */
    selfDisclosure: string | null
  }
  /** False when the sample is too small or too flat to describe. */
  sufficient: boolean
  /** Why the dimension was suppressed (only when sufficient is false). */
  insufficientReason?: string
}

/**
 * Split one message into clauses.
 *
 * Chinese business writing separates sentences with 。！？；, clauses with
 * ，, and list items with 、 — the enumeration comma is kept inside the
 * clause so that a serial field list stays one unit.
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

/** Concrete data kinds present in a single text. */
export function detectConcreteData(text: string): string[] {
  return DATA_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.kind)
}

/**
 * The structural form of a request clause.
 *
 * `mitigation-preposed` fronts a cost/politeness marker in front of the verb
 * phrase; `qing-vp` and `yao-vp` are direct constructions; `bare-vp` is an
 * unprefixed imperative; `conditional-query` hands the decision back.
 */
export function requestForm(clause: string): RequestForm | null {
  if (ACK_RE.test(clause)) return null
  if (MITIGATION_RE.test(clause)) return 'mitigation-preposed'
  if (QING_RE.test(clause)) return 'qing-vp'
  if (CONDITIONAL_RE.test(clause)) return 'conditional-query'
  if (/^(?:再|要|得|必須|需|需要)/.test(clause) && ACTION_RE.test(clause))
    return 'yao-vp'
  if (ACTION_START_RE.test(clause) && !SUBJECT_START_RE.test(clause))
    return 'bare-vp'
  return null
}

/** Where a request sits on the politeness strategy ladder. */
export function politenessStrategy(
  form: RequestForm | null,
): PolitenessStrategy | null {
  if (!form) return null
  if (form === 'mitigation-preposed') return 'negative-politeness'
  if (form === 'conditional-query') return 'off-record'
  return 'bald-on-record'
}

/** The speech act performed by one clause. */
export function speechAct(clause: string): SpeechAct {
  if (THANKS_RE.test(clause) && clause.length <= 16) return 'thanks'
  const form = requestForm(clause)
  if (form === 'conditional-query') return 'question'
  if (form) return 'request'
  if (/[嗎呢]\s*$/.test(clause)) return 'question'
  if (CONFIRM_RE.test(clause)) return 'confirmation'
  if (REASON_MARKER_RE.test(clause)) return 'explanation'
  return 'statement'
}

/**
 * Parse the request frame of a clause: prefix + action + time / condition.
 *
 * Returns null when the clause carries no request prefix.
 */
export function parseRequestFrame(segment: string): RequestFrame | null {
  const re = new RegExp(
    `(?:再|又)?(?:要)?(?:麻煩|拜託|幫忙)(?:您|妳|你)?|${QING_RE.source}`,
    'g',
  )
  let match = re.exec(segment)
  while (match && !isPolitenessPrefix(segment, match.index, match[0])) {
    match = re.exec(segment)
  }
  if (!match) return null
  const prefix = match[0]
  const rest = segment.slice(match.index + prefix.length)
  const timeMatch =
    /\d{1,4}\s*[-/]\s*\d{1,2}|今天|明天|後天|大後天|昨天|早上|下午|晚上|週[一二三四五六日天]|星期[一二三四五六日天]|禮拜[一二三四五六日天]|下週[一二三四五六日天]|月底|月初|年底|今年|週末/.exec(
      rest,
    )
  const seqMatch = /先|再|後|然後|才/.exec(rest)
  let action = rest
  if (timeMatch) action = action.replace(timeMatch[0], ' ')
  if (seqMatch) action = action.replace(seqMatch[0], ' ')
  action = action.trim().replace(/\s+/g, ' ').slice(0, 16)
  const hasValue = detectConcreteData(segment).length > 0
  const relayed = RELAYED_RE.test(segment)
  return {
    prefix,
    family: prefix,
    time: timeMatch ? timeMatch[0] : null,
    sequence: seqMatch ? seqMatch[0] : null,
    action,
    condition:
      /三聯式|含稅|統編|抬頭|品名|單號|序號|細目|明細|地址|收件|簽名|用印|頁|格式|附件|數量|規格|日期|金額|數字|\d+\s*(?:元|號|頁)|\d{4,}/.test(
        rest,
      ),
    specified: hasValue && !relayed,
    relayed,
    reason: REASON_MARKER_RE.test(segment),
    raw: segment,
  }
}

/**
 * A bare "qing" that follows an auxiliary verb, or that opens a fixed
 * phrase, is the verb "invite / be able to ask", not a politeness prefix.
 */
const AUX_BEFORE_QING_RE = /[會要能可才得願想不]$/
const FIXED_AFTER_QING_RE = /^(?:得到|不到|假|購|於)/
/**
 * "qing" followed by the agent of the action is the verb "invite someone to
 * do", not a politeness prefix.
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

/** Count honorifics inside a text. */
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

/** One clause of one message. */
interface Clause {
  /** The clause text. */
  text: string
  /** The speech act it performs. */
  act: SpeechAct
  /** The request form, when the clause is a request. */
  form: RequestForm | null
  /** Where the request sits on the politeness ladder. */
  strategy: PolitenessStrategy | null
  /** Whether the clause contains an action verb. */
  hasAction: boolean
  /** Concrete data kinds in the clause. */
  values: string[]
  /** Whether the value comes before the action, after it, or neither. */
  valueOrder: 'preposed' | 'postposed' | null
  /** Whether the clause carries a deadline. */
  deadline: boolean
  /** Whether the clause carries any time expression. */
  dated: boolean
  /** Whether the clause states a reason. */
  reason: boolean
  /** How the subject is handled. */
  subject: 'explicit-start' | 'explicit-late' | 'omitted' | null
  /** Where the subordinate clause sits. */
  subordinate: 'preposed' | 'postposed' | 'none' | null
  /** Sentence-final mood particle. */
  mood: string | null
  /** Whether the clause hands the decision back. */
  conditional: boolean
  /** Whether the clause relays a third party's requirement. */
  relayed: boolean
  /** Whether the clause describes the talker's own situation. */
  selfState: boolean
}

/** One discourse unit of one message. */
interface Unit {
  /** The unit text. */
  text: string
  /** The unit kind. */
  kind: UnitKind
  /** How many label/value pairs the unit carries. */
  fieldCount: number
  /** Whether the unit enumerates several fields on one line. */
  serial: boolean
  /** The field labels of the unit. */
  labels: string[]
  /** Whether a blank line precedes the unit. */
  blankBefore: boolean
}

/** Structural facts of one message. */
export interface MessageNarrative {
  /** The raw message text. */
  text: string
  /** The clauses of the message. */
  clauses: Clause[]
  /** The discourse units of the message. */
  units: Unit[]
  /** The speech acts in order. */
  acts: SpeechAct[]
  /** The unit kinds in order. */
  unitKinds: UnitKind[]
}

/** Emoji code point, used for the emoji habit rate. */
const EMOJI_RE =
  /(?:[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}])/u

/** Find the index of the first action verb in a clause. */
function actionIndex(clause: string): number {
  const match = ACTION_RE.exec(clause)
  return match ? match.index : -1
}

/** Find the index of the first concrete value in a clause. */
function valueIndex(clause: string): number {
  let best = -1
  for (const pattern of DATA_PATTERNS) {
    const match = pattern.re.exec(clause)
    if (match && (best === -1 || match.index < best)) best = match.index
  }
  return best
}

/** Analyze one clause. */
function analyzeClause(text: string): Clause {
  const act = speechAct(text)
  const form = requestForm(text)
  const values = detectConcreteData(text)
  const action = actionIndex(text)
  const value = valueIndex(text)
  let valueOrder: Clause['valueOrder'] = null
  if (action >= 0 && value >= 0) {
    valueOrder = value < action ? 'preposed' : 'postposed'
  }
  const isRequest = act === 'request'
  let subject: Clause['subject'] = null
  if (isRequest) {
    if (SUBJECT_START_RE.test(text)) subject = 'explicit-start'
    else if (SUBJECT_RE.test(text)) subject = 'explicit-late'
    else subject = 'omitted'
  }
  let subordinate: Clause['subordinate'] = null
  if (REASON_MARKER_RE.test(text)) {
    if (SUBORDINATOR_RE.test(text)) subordinate = 'preposed'
    else if (/(?:因為|所以|由於)[^。]{0,20}$/.test(text))
      subordinate = 'postposed'
    else subordinate = 'none'
  }
  let mood: string | null = null
  for (const particle of MOOD_PARTICLES) {
    if (text.endsWith(particle)) {
      mood = particle
      break
    }
  }
  return {
    text,
    act,
    form,
    strategy: politenessStrategy(form),
    hasAction: action >= 0,
    values,
    valueOrder,
    deadline:
      RELATIVE_DATE_RE.test(text) ||
      ABSOLUTE_DATE_RE.test(text) ||
      /期限|截止|最晚|日前/.test(text),
    dated: RELATIVE_DATE_RE.test(text) || ABSOLUTE_DATE_RE.test(text),
    reason: REASON_MARKER_RE.test(text),
    subject,
    subordinate,
    mood,
    conditional: CONDITIONAL_RE.test(text),
    relayed: RELAYED_RE.test(text),
    selfState:
      SELF_STATE_RE.test(text) &&
      action < 0 &&
      detectConcreteData(text).length === 0,
  }
}

/**
 * Strip a leading list marker, so that a numbered line is analyzed as the
 * command it is rather than as a numbered statement.
 */
function stripListMarker(clause: string): string {
  return clause.replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, '').trim()
}

/** Analyze one message into clauses and discourse units. */
export function analyzeMessage(text: string): MessageNarrative {
  const clauseTexts = splitSegments(text).map(stripListMarker)
  const clauses = clauseTexts.map((clause) => analyzeClause(clause))

  const lines = text.split('\n')
  const units: Unit[] = []
  let blankBefore = false
  lines.forEach((line) => {
    if (!line.trim()) {
      blankBefore = true
      return
    }
    const pairs = [...line.matchAll(FIELD_PAIR_RE)]
    const single = LABELLED_LINE_RE.exec(line)
    const labels = pairs.map((pair) => pair[1])
    // One label with an enumerated value is a serial arrangement too.
    const serial = pairs.length > 1 || (pairs.length === 1 && /、/.test(line))
    let kind: UnitKind = 'narrative'
    if (LIST_MARKER_RE.test(line)) kind = 'list'
    else if (pairs.length > 0) kind = 'field'
    else {
      const lineClauses = splitSegments(line)
        .map(stripListMarker)
        .map((clause) => analyzeClause(clause))
      if (lineClauses.some((clause) => clause.act === 'thanks')) kind = 'thanks'
      else if (lineClauses.some((clause) => clause.act === 'request'))
        kind = 'request'
    }
    units.push({
      text: line,
      kind,
      fieldCount: pairs.length,
      serial,
      labels: single?.[1] ? [single[1]] : labels,
      blankBefore,
    })
    blankBefore = false
  })

  return {
    text,
    clauses,
    units,
    acts: clauses.map((clause) => clause.act),
    unitKinds: units.map((unit) => unit.kind),
  }
}

/** Measure the talker's punctuation and emoji habits. */
function analyzeTone(messages: MessageNarrative[]): ToneStats {
  const total = messages.length
  const count = (test: (text: string) => boolean) =>
    total ? messages.filter((m) => test(m.text)).length / total : 0
  const round = (rate: number) => Math.round(rate * 100) / 100
  return {
    emojiRate: round(count((text) => EMOJI_RE.test(text))),
    questionRate: round(count((text) => /[？?]/.test(text))),
    exclamationRate: round(count((text) => /[！!]/.test(text))),
    tildeRate: round(count((text) => /[~～]/.test(text))),
    quoteMarkRate: round(count((text) => /[「」『』"]/.test(text))),
    ellipsisRate: round(count((text) => /\.\.\.|…/.test(text))),
  }
}

/** Truncate an excerpt taken from the talker's own message. */
function excerpt(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** One situation a recipe can be derived from. */
interface RecipeDefinition {
  /** Stable identifier. */
  id: string
  /** Chinese title of the situation. */
  title: string
  /** Whether a message belongs to this situation. */
  match: (message: MessageNarrative) => boolean
}

/**
 * The situations a recipe can be derived from. Each definition is a generic
 * shape; the recipe itself is always built from the talker's own messages,
 * never from a template.
 */
const RECIPE_DEFINITIONS: RecipeDefinition[] = [
  {
    id: 'confirm-deliverable',
    title: '請求對方確認已交付物',
    match: (message) =>
      message.acts.includes('request') &&
      /附上|做了一份|做了一版|整理好|產出|備妥|寫好|送件/.test(message.text),
  },
  {
    id: 'request-with-values',
    title: '請求開立或寄送並附上具體資料',
    match: (message) =>
      message.acts.includes('request') &&
      message.units.some((unit) => unit.kind === 'field'),
  },
  {
    id: 'status-update',
    title: '告知已完成或已交付事項',
    match: (message) =>
      !message.acts.includes('request') &&
      /附上|做了一份|整理好|產出|備妥|寫好|送件|跑完了|跑完/.test(message.text),
  },
]

/**
 * Build the drafting recipes from the sample.
 *
 * A recipe is a set of units that recur inside the talker's own messages of
 * one situation. Every step carries the share of that situation's messages it
 * appears in, plus a verbatim excerpt when one is available.
 */
function buildRecipes(
  messages: MessageNarrative[],
  sampleSize: number,
): Recipe[] {
  const recipes: Recipe[] = []
  for (const definition of RECIPE_DEFINITIONS) {
    const group = messages.filter((message) => definition.match(message))
    if (group.length === 0) continue
    const carriers = new Map<string, { count: number; position: number }>()
    group.forEach((message) => {
      const seen = new Set<string>()
      message.units.forEach((unit, index) => {
        if (seen.has(unit.kind)) return
        seen.add(unit.kind)
        const entry = carriers.get(unit.kind) ?? { count: 0, position: index }
        entry.count++
        carriers.set(unit.kind, entry)
      })
    })
    const steps: (RecipeStep & { position: number })[] = []
    for (const [kind, entry] of carriers) {
      const rate = entry.count / group.length
      if (rate < 0.4) continue
      const quote =
        group
          .flatMap((message) => message.units)
          .find((unit) => unit.kind === kind)?.text ?? null
      steps.push({
        description: UNIT_KIND_LABELS[kind as UnitKind],
        rate: Math.round(rate * 100) / 100,
        quote: quote ? excerpt(quote.trim()) : null,
        position: entry.position,
      })
    }
    if (steps.length === 0) continue
    steps.sort((a, b) => a.position - b.position || b.rate - a.rate)
    recipes.push({
      id: definition.id,
      title: definition.title,
      sampleSize: group.length,
      rate: sampleSize
        ? Math.round((group.length / sampleSize) * 100) / 100
        : 0,
      steps: steps.map(({ position: _position, ...step }) => step),
    })
  }
  return recipes
}

/** Collect the talker's own messages as examples, grouped by situation. */
function buildExamples(
  messages: MessageNarrative[],
  recipes: Recipe[],
): StyleExample[] {
  const examples: StyleExample[] = []
  for (const recipe of recipes) {
    const definition = RECIPE_DEFINITIONS.find(
      (candidate) => candidate.id === recipe.id,
    )
    if (!definition) continue
    const group = messages.filter((message) => definition.match(message))
    for (const message of group.slice(0, 2)) {
      const text =
        message.text.length > MAX_EXAMPLE_CHARS
          ? `${message.text.slice(0, MAX_EXAMPLE_CHARS - 1)}…`
          : message.text
      examples.push({ situation: recipe.title, text })
    }
  }
  return examples.slice(0, 5)
}

/**
 * Derive the things this talker does NOT do.
 *
 * Every prohibition is backed by a rate measured on the sample; nothing is
 * prohibited because a template says so.
 */
function buildProhibitions(profile: {
  absentActs: SpeechAct[]
  strategyRates: {
    strategy: PolitenessStrategy
    rate: number
  }[]
  unitRates: { kind: UnitKind; rate: number }[]
  layout: NarrativeProfile['layout']
  mitigationMoves: NarrativeProfile['mitigationMoves']
  reasonSource: NarrativeProfile['reasonSource']
  selfDisclosure: NarrativeProfile['selfDisclosure']
  sampleSize: number
}): Prohibition[] {
  const prohibitions: Prohibition[] = []
  const pct = (rate: number) => `${Math.round(rate * 100)}%`
  for (const act of profile.absentActs) {
    prohibitions.push({
      text: `勿自行加入${SPEECH_ACT_LABELS[act]}的段落`,
      evidence: `樣本中該言語行為出現率${pct(0)}`,
    })
  }
  const strategyRate = (strategy: PolitenessStrategy) =>
    profile.strategyRates.find((entry) => entry.strategy === strategy)?.rate ??
    0
  const mitigated = strategyRate('negative-politeness')
  const direct = strategyRate('bald-on-record')
  const offRecord = strategyRate('off-record')
  if (mitigated >= 0.5 && direct < 0.3) {
    prohibitions.push({
      text: '勿自行把迂迴請求改成直接祈使',
      evidence: `迂迴請求約${pct(mitigated)},直接祈使約${pct(direct)}`,
    })
  }
  if (direct >= 0.5 && mitigated < 0.3) {
    prohibitions.push({
      text: '勿自行把直接祈使改成迂迴請求',
      evidence: `直接祈使約${pct(direct)},迂迴請求約${pct(mitigated)}`,
    })
  }
  if (offRecord >= 0.5) {
    prohibitions.push({
      text: '勿自行把條件式請求改成單向命令',
      evidence: `條件式約${pct(offRecord)}`,
    })
  }
  const unitRate = (kind: UnitKind) =>
    profile.unitRates.find((entry) => entry.kind === kind)?.rate ?? 0
  if (profile.layout.fieldPerLineRate >= 0.5) {
    prohibitions.push({
      text: '勿自行把欄位併成同一行的串列',
      evidence: `欄位單位中逐列呈現約${pct(profile.layout.fieldPerLineRate)}`,
    })
  }
  if (profile.layout.fieldSerialRate >= 0.5) {
    prohibitions.push({
      text: '勿自行把欄位拆成逐列清單',
      evidence: `欄位單位中同列串列約${pct(profile.layout.fieldSerialRate)}`,
    })
  }
  if (unitRate('list') >= 0.5) {
    prohibitions.push({
      text: '勿自行改寫成段落式長文',
      evidence: `條列單位佔全部單位約${pct(unitRate('list'))}`,
    })
  }
  if (unitRate('list') < 0.1 && profile.sampleSize >= 3) {
    prohibitions.push({
      text: '勿自行使用條列編號',
      evidence: `條列單位佔全部單位約${pct(unitRate('list'))}`,
    })
  }
  const moves = profile.mitigationMoves
  if (moves.base > 0) {
    if (moves.reason < 0.2) {
      prohibitions.push({
        text: '勿自行替請求補上理由',
        evidence: `僅約${pct(moves.reason)}的請求附帶理由`,
      })
    }
    if (moves.deadline < 0.2) {
      prohibitions.push({
        text: '勿自行替請求補上期限',
        evidence: `僅約${pct(moves.deadline)}的請求附帶期限`,
      })
    }
    if (moves.delegation < 0.2) {
      prohibitions.push({
        text: '勿自行把判斷權交給對方',
        evidence: `僅約${pct(moves.delegation)}的請求交由對方判斷`,
      })
    }
  }
  if (profile.reasonSource.base > 0 && profile.reasonSource.relayed < 0.2) {
    prohibitions.push({
      text: '勿自行轉述第三方條件代替直接給值',
      evidence: `轉述理由約${pct(profile.reasonSource.relayed)}`,
    })
  }
  if (profile.selfDisclosure.base > 0 && profile.selfDisclosure.rate <= 0.2) {
    prohibitions.push({
      text: '勿自行夾帶與請求無關的自身狀態',
      evidence: `僅約${pct(profile.selfDisclosure.rate)}的請求夾帶自身狀態`,
    })
  }
  return prohibitions
}

/**
 * List what this sample cannot support.
 *
 * Anything not observed is reported as "not seen" rather than assumed absent.
 */
function buildUncertainties(profile: {
  sampleSize: number
  datedMessages: number
  amountMessages: number
  requestClauses: number
  recipes: Recipe[]
}): string[] {
  const uncertainties: string[] = []
  if (profile.sampleSize < 5) {
    uncertainties.push(`樣本僅${profile.sampleSize}則,各項比例的估計不穩定`)
  }
  if (profile.datedMessages === 0) {
    uncertainties.push(
      `樣本0/${profile.sampleSize}則出現日期寫法,不足以描述期限位置`,
    )
  }
  if (profile.amountMessages === 0) {
    uncertainties.push(
      `樣本0/${profile.sampleSize}則出現金額寫法,不足以描述金額偏好`,
    )
  }
  if (profile.requestClauses === 0) {
    uncertainties.push('樣本未見請求,不足以描述請求結構與互動策略')
  }
  for (const recipe of profile.recipes) {
    if (recipe.sampleSize < 2) {
      uncertainties.push(
        `情境骨架「${recipe.title}」僅${recipe.sampleSize}則樣本支持,比例不穩定`,
      )
    }
  }
  return uncertainties
}

/**
 * Analyze the structural style of a set of the talker's own messages.
 *
 * @param texts - The user's sent message texts (sticker messages excluded).
 * @param chatIds - Optional conversation id per text, for per-recipient
 *   register differences.
 */
export function analyzeNarrative(
  texts: string[],
  chatIds?: string[],
): NarrativeProfile {
  const sampleSize = texts.length
  const messages = texts.map((text) => analyzeMessage(text))
  const clauses = messages.flatMap((message) => message.clauses)
  const clauseCount = clauses.length

  // --- ideational: content and information structure ---
  const valuedClauses = clauses.filter((clause) => clause.valueOrder)
  const valuePosition = {
    preposed: valuedClauses.filter((clause) => clause.valueOrder === 'preposed')
      .length,
    postposed: valuedClauses.filter(
      (clause) => clause.valueOrder === 'postposed',
    ).length,
    base: valuedClauses.length,
  }
  const topicFirstRate = sampleSize
    ? Math.round(
        (messages.filter(
          (message) =>
            message.clauses[0] !== undefined &&
            SUBJECT_START_RE.test(message.clauses[0].text),
        ).length /
          sampleSize) *
          100,
      ) / 100
    : 0
  const dataKinds = [
    ...new Set(messages.flatMap((message) => detectConcreteData(message.text))),
  ]
  const withData = messages.filter(
    (m) => detectConcreteData(m.text).length > 0,
  ).length
  const dated = messages.filter(
    (m) => RELATIVE_DATE_RE.test(m.text) || ABSOLUTE_DATE_RE.test(m.text),
  )
  const relativeRate = dated.length
    ? Math.round(
        (dated.filter((m) => RELATIVE_DATE_RE.test(m.text)).length /
          dated.length) *
          100,
      ) / 100
    : 0
  const absoluteRate = dated.length
    ? Math.round(
        (dated.filter((m) => ABSOLUTE_DATE_RE.test(m.text)).length /
          dated.length) *
          100,
      ) / 100
    : 0
  let preferred: NarrativeProfile['dateStyle']['preferred'] = 'none'
  if (dated.length > 0) {
    if (relativeRate - absoluteRate >= 0.15) preferred = 'relative'
    else if (absoluteRate - relativeRate >= 0.15) preferred = 'absolute'
    else preferred = 'mixed'
  }
  const dateFormatCounts = { iso: 0, short: 0, chinese: 0 }
  const amountFormatCounts = { 'with-tax': 0, breakdown: 0, plain: 0 }
  for (const message of messages) {
    if (ISO_DATE_RE.test(message.text)) dateFormatCounts.iso++
    else if (CHINESE_DATE_RE.test(message.text)) dateFormatCounts.chinese++
    else if (SHORT_DATE_RE.test(message.text)) dateFormatCounts.short++
    if (AMOUNT_BREAKDOWN_RE.test(message.text)) amountFormatCounts.breakdown++
    else if (detectConcreteData(message.text).includes('amount'))
      amountFormatCounts['with-tax']++
    else if (/\d[\d,]*\s*(?:元|塊)/.test(message.text))
      amountFormatCounts.plain++
  }

  // --- interpersonal: speech acts and relational strategy ---
  const actCounts = new Map<SpeechAct, number>()
  for (const clause of clauses) {
    actCounts.set(clause.act, (actCounts.get(clause.act) ?? 0) + 1)
  }
  const actRates = [...actCounts.entries()]
    .map(([act, count]) => ({
      act,
      label: SPEECH_ACT_LABELS[act],
      count,
      rate: clauseCount ? Math.round((count / clauseCount) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.rate - a.rate || b.count - a.count)
  const absentActs = (Object.keys(SPEECH_ACT_LABELS) as SpeechAct[]).filter(
    (act) => !actCounts.has(act),
  )

  const requestClauses = clauses.filter((clause) => clause.act === 'request')
  const strategyCounts = new Map<PolitenessStrategy, number>()
  for (const clause of requestClauses) {
    if (!clause.strategy) continue
    strategyCounts.set(
      clause.strategy,
      (strategyCounts.get(clause.strategy) ?? 0) + 1,
    )
  }
  const strategyRates = [...strategyCounts.entries()]
    .map(([strategy, count]) => ({
      strategy,
      label: POLITENESS_LABELS[strategy],
      count,
      rate: requestClauses.length
        ? Math.round((count / requestClauses.length) * 100) / 100
        : 0,
    }))
    .sort((a, b) => b.rate - a.rate)
  const mitigationMoves = {
    reason: requestClauses.length
      ? Math.round(
          (requestClauses.filter((clause) => clause.reason).length /
            requestClauses.length) *
            100,
        ) / 100
      : 0,
    deadline: requestClauses.length
      ? Math.round(
          (requestClauses.filter((clause) => clause.deadline).length /
            requestClauses.length) *
            100,
        ) / 100
      : 0,
    delegation: requestClauses.length
      ? Math.round(
          (requestClauses.filter((clause) => clause.conditional).length /
            requestClauses.length) *
            100,
        ) / 100
      : 0,
    base: requestClauses.length,
  }
  const reasonClauses = clauses.filter((clause) => clause.reason)
  const relayedReasons = reasonClauses.filter((clause) =>
    THIRD_PARTY_RE.test(clause.text),
  ).length
  const reasonSource = {
    self: reasonClauses.length - relayedReasons,
    relayed: relayedReasons,
    base: reasonClauses.length,
  }
  const disclosureClauses = requestClauses.filter((clause) => clause.selfState)
  const selfDisclosure = {
    rate: requestClauses.length
      ? Math.round((disclosureClauses.length / requestClauses.length) * 100) /
        100
      : 0,
    base: requestClauses.length,
    example: disclosureClauses[0]?.text ?? null,
  }

  // Honorifics (identification dimension).
  const ningTotal = messages.reduce(
    (sum, m) => sum + countHonorifics(m.text).ning,
    0,
  )
  const neiTotal = messages.reduce(
    (sum, m) => sum + countHonorifics(m.text).nei,
    0,
  )
  const niTotal = messages.reduce(
    (sum, m) => sum + countHonorifics(m.text).ni,
    0,
  )
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
  const honorificMessages = messages.filter(
    (m) =>
      countHonorifics(m.text).ning +
        countHonorifics(m.text).nei +
        countHonorifics(m.text).ni >
      0,
  )
  const ningRate = sampleSize
    ? Math.round(
        (honorificMessages.filter((m) => m.text.includes('您')).length /
          sampleSize) *
          100,
      ) / 100
    : 0
  const neiRate = sampleSize
    ? Math.round(
        (honorificMessages.filter((m) => m.text.includes('妳')).length /
          sampleSize) *
          100,
      ) / 100
    : 0
  const niRate = sampleSize
    ? Math.round(
        (honorificMessages.filter((m) => m.text.includes('你')).length /
          sampleSize) *
          100,
      ) / 100
    : 0
  const perChat = new Map<string, { ning: number; nei: number; ni: number }>()
  messages.forEach((message, index) => {
    const chatId = chatIds?.[index]
    if (!chatId) return
    const entry = perChat.get(chatId) ?? { ning: 0, nei: 0, ni: 0 }
    const counts = countHonorifics(message.text)
    entry.ning += counts.ning
    entry.nei += counts.nei
    entry.ni += counts.ni
    perChat.set(chatId, entry)
  })
  const perChatHonorifics = [...perChat.entries()].map(([chatId, entry]) => {
    const chatMessages = messages.filter(
      (_, index) => chatIds?.[index] === chatId,
    )
    const withHonorific = chatMessages.filter(
      (m) =>
        countHonorifics(m.text).ning +
          countHonorifics(m.text).nei +
          countHonorifics(m.text).ni >
        0,
    ).length
    const ning = withHonorific
      ? Math.round(
          (chatMessages.filter((m) => m.text.includes('您')).length /
            withHonorific) *
            100,
        ) / 100
      : 0
    const nei = withHonorific
      ? Math.round(
          (chatMessages.filter((m) => m.text.includes('妳')).length /
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

  // Per-recipient register differences (tenor).
  const registers: RegisterProfile[] = []
  if (chatIds) {
    const chatIdsSeen = [...new Set(chatIds.filter(Boolean))]
    for (const chatId of chatIdsSeen) {
      const chatMessages = messages.filter(
        (_, index) => chatIds[index] === chatId,
      )
      const chatRequests = chatMessages.flatMap((message) =>
        message.clauses.filter((clause) => clause.act === 'request'),
      )
      const mitigated = chatRequests.filter(
        (clause) => clause.strategy === 'negative-politeness',
      ).length
      const chatCounts = chatMessages.reduce(
        (acc, message) => {
          const counts = countHonorifics(message.text)
          acc.ning += counts.ning
          acc.nei += counts.nei
          acc.ni += counts.ni
          return acc
        },
        { ning: 0, nei: 0, ni: 0 },
      )
      const chatTotal = chatCounts.ning + chatCounts.nei + chatCounts.ni
      const ranking: [string, number][] = [
        ['您', chatCounts.ning],
        ['妳', chatCounts.nei],
        ['你', chatCounts.ni],
      ]
      registers.push({
        chatId,
        messageCount: chatMessages.length,
        requestBase: chatRequests.length,
        mitigationRate: chatRequests.length
          ? Math.round((mitigated / chatRequests.length) * 100) / 100
          : 0,
        honorific:
          chatTotal === 0 ? null : ranking.sort((a, b) => b[1] - a[1])[0][0],
      })
    }
  }

  // --- textual: unit division and cohesion ---
  const units = messages.flatMap((message) => message.units)
  const unitCounts = new Map<UnitKind, number>()
  for (const unit of units) {
    unitCounts.set(unit.kind, (unitCounts.get(unit.kind) ?? 0) + 1)
  }
  const unitRates = [...unitCounts.entries()]
    .map(([kind, count]) => ({
      kind,
      label: UNIT_KIND_LABELS[kind],
      count,
      rate: units.length ? Math.round((count / units.length) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.rate - a.rate)
  const fieldUnits = units.filter((unit) => unit.kind === 'field')
  const perLineUnits = fieldUnits.filter((unit) => !unit.serial).length
  const serialUnits = fieldUnits.filter((unit) => unit.serial).length
  const boundaries = Math.max(0, units.length - messages.length)
  const blankSeparated = units.filter(
    (unit) => unit.blankBefore && unit.kind !== 'narrative',
  ).length
  const layout = {
    blankSeparatedRate: boundaries
      ? Math.round((blankSeparated / boundaries) * 100) / 100
      : 0,
    unitsPerMessage: sampleSize
      ? Math.round((units.length / sampleSize) * 10) / 10
      : 0,
    fieldsPerUnit: fieldUnits.length
      ? Math.round(
          (fieldUnits.reduce((sum, unit) => sum + unit.fieldCount, 0) /
            fieldUnits.length) *
            10,
        ) / 10
      : 0,
    labels: [...new Set(units.flatMap((unit) => unit.labels))],
    fieldPerLineRate: fieldUnits.length
      ? Math.round((perLineUnits / fieldUnits.length) * 100) / 100
      : 0,
    fieldSerialRate: fieldUnits.length
      ? Math.round((serialUnits / fieldUnits.length) * 100) / 100
      : 0,
    base: fieldUnits.length,
  }

  // Observed transitions between adjacent behaviours.
  const transitions: Transition[] = []
  for (const scope of ['act', 'unit'] as const) {
    const counter = new Map<string, number>()
    let total = 0
    for (const message of messages) {
      const sequence = scope === 'act' ? message.acts : message.unitKinds
      for (let i = 0; i < sequence.length - 1; i++) {
        const key = `${sequence[i]}>${sequence[i + 1]}`
        counter.set(key, (counter.get(key) ?? 0) + 1)
        total++
      }
    }
    for (const [key, count] of [...counter.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      const [from, to] = key.split('>')
      transitions.push({
        scope,
        from:
          SPEECH_ACT_LABELS[from as SpeechAct] ??
          UNIT_KIND_LABELS[from as UnitKind],
        to:
          SPEECH_ACT_LABELS[to as SpeechAct] ??
          UNIT_KIND_LABELS[to as UnitKind],
        count,
        rate: total ? Math.round((count / total) * 100) / 100 : 0,
      })
    }
  }

  const recipes = buildRecipes(messages, sampleSize)
  const examples = buildExamples(messages, recipes)

  // Sample sufficiency: enough messages AND at least one observable
  // structural feature. A sample may be fully sufficient with numbered
  // commands and no narrative prose at all.
  const observableFeatures =
    clauses.filter(
      (clause) =>
        clause.act === 'request' ||
        clause.act === 'question' ||
        clause.act === 'confirmation' ||
        clause.act === 'explanation',
    ).length +
    messages.filter((message) =>
      message.units.some(
        (unit) => unit.kind === 'field' || unit.kind === 'list',
      ),
    ).length +
    clauses.filter((clause) => /\d/.test(clause.text)).length
  let sufficient = true
  let insufficientReason: string | undefined
  if (sampleSize < MIN_MESSAGES) {
    sufficient = false
    insufficientReason = `僅${sampleSize}則訊息,不足以描述個人風格`
  } else if (clauseCount < MIN_CLAUSES) {
    sufficient = false
    insufficientReason = `僅${clauseCount}則子句,不足以描述個人風格`
  } else if (observableFeatures === 0) {
    sufficient = false
    insufficientReason = '樣本多為寒暄或單一功能訊息,未見可觀測的結構特徵'
  }

  const prohibitions = buildProhibitions({
    absentActs,
    strategyRates,
    unitRates,
    layout,
    mitigationMoves,
    reasonSource,
    selfDisclosure,
    sampleSize,
  })
  const uncertainties = buildUncertainties({
    sampleSize,
    datedMessages: dated.length,
    amountMessages: messages.filter((m) =>
      detectConcreteData(m.text).includes('amount'),
    ).length,
    requestClauses: requestClauses.length,
    recipes,
  })

  const findClause = (predicate: (clause: Clause) => boolean) =>
    clauses.find(predicate)?.text ?? null
  const findUnit = (predicate: (unit: Unit) => boolean) =>
    units.find(predicate)?.text.trim() ?? null

  return {
    heuristic: true,
    sampleSize,
    clauseCount,
    valuePosition,
    topicFirstRate,
    dateStyle: { relativeRate, absoluteRate, preferred },
    dateFormat: dominantFormat(
      dateFormatCounts,
    ) as NarrativeProfile['dateFormat'],
    amountFormat: dominantFormat(
      amountFormatCounts,
    ) as NarrativeProfile['amountFormat'],
    concreteDataRate: sampleSize
      ? Math.round((withData / sampleSize) * 100) / 100
      : 0,
    concreteDataKinds: dataKinds,
    actRates,
    strategyRates,
    requestBase: requestClauses.length,
    mitigationMoves,
    reasonSource,
    selfDisclosure,
    honorifics: {
      ningRate,
      neiRate,
      niRate,
      dominant: dominantHonorific,
      perChat: perChatHonorifics,
    },
    registers,
    unitRates,
    layout,
    transitions,
    recipes,
    examples,
    prohibitions,
    uncertainties,
    tone: analyzeTone(messages),
    snippets: {
      amount: findClause((clause) => clause.values.includes('amount')) ?? null,
      date: findClause((clause) => clause.dated) ?? null,
      relativeDate:
        findClause(
          (clause) => clause.dated && RELATIVE_DATE_RE.test(clause.text),
        ) ?? null,
      absoluteDate:
        findClause(
          (clause) => clause.dated && ABSOLUTE_DATE_RE.test(clause.text),
        ) ?? null,
      dateShort:
        findClause((clause) => SHORT_DATE_RE.test(clause.text)) ?? null,
      dateIso: findClause((clause) => ISO_DATE_RE.test(clause.text)) ?? null,
      dateChinese:
        findClause((clause) => CHINESE_DATE_RE.test(clause.text)) ?? null,
      mitigated:
        findClause((clause) => clause.form === 'mitigation-preposed') ?? null,
      imperative:
        findClause(
          (clause) =>
            clause.form === 'qing-vp' ||
            clause.form === 'yao-vp' ||
            clause.form === 'bare-vp',
        ) ?? null,
      conditional:
        findClause((clause) => clause.form === 'conditional-query') ?? null,
      fieldPerLine:
        findUnit(
          (unit) =>
            unit.kind === 'field' && !unit.serial && !/、/.test(unit.text),
        ) ?? null,
      fieldSerial:
        findUnit((unit) => unit.kind === 'field' && unit.serial) ?? null,
      valuePreposed:
        findClause((clause) => clause.valueOrder === 'preposed') ?? null,
      valuePostposed:
        findClause((clause) => clause.valueOrder === 'postposed') ?? null,
      selfReason:
        findClause(
          (clause) => clause.reason && !THIRD_PARTY_RE.test(clause.text),
        ) ?? null,
      relayedReason:
        findClause(
          (clause) => clause.reason && THIRD_PARTY_RE.test(clause.text),
        ) ?? null,
      selfDisclosure:
        findClause((clause) => clause.act === 'request' && clause.selfState) ??
        null,
    },
    sufficient,
    ...(insufficientReason ? { insufficientReason } : {}),
  }
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

/**
 * Turn the structural profile into guidance lines.
 *
 * The output has five blocks: a discrete attribute table, executable style
 * instructions grouped by the three metafunctions, the talker's own verbatim
 * messages, prohibitions / unobserved items, and uncertainty.
 *
 * Every instruction is an executable natural-language constraint backed by a
 * rate or by the talker's own wording. No fixed element chain and no default
 * template is ever emitted.
 */
export function narrativeGuideLines(profile: NarrativeProfile): string[] {
  const lines: string[] = []
  const pct = (rate: number) => `${Math.round(rate * 100)}%`
  const sample = `樣本${profile.sampleSize}則`

  if (!profile.sufficient) {
    lines.push(
      `屬性表(ideational):資料不足(${profile.insufficientReason ?? '樣本不足'},${sample}),此對話者少用多段敘事,以下僅列樣本中可觀察到的少數屬性`,
    )
  } else {
    // Block 1a: ideational attributes.
    const value = profile.valuePosition
    const valueText = value.base
      ? `具體值位置前置(背景先行)率${pct(value.preposed / value.base)}、後置(事後補述)率${pct(
          value.postposed / value.base,
        )}`
      : '樣本未見同時含行動與具體值的子句,無法判定值的位置'
    const dateText =
      profile.dateStyle.preferred === 'relative'
        ? `日期用語以相對日為主(${pct(profile.dateStyle.relativeRate)})`
        : profile.dateStyle.preferred === 'absolute'
          ? `日期用語以完整日期為主(${pct(profile.dateStyle.absoluteRate)})`
          : profile.dateStyle.preferred === 'mixed'
            ? `日期用語相對日${pct(profile.dateStyle.relativeRate)}與完整日期${pct(
                profile.dateStyle.absoluteRate,
              )}並用`
            : '日期用語無樣本'
    lines.push(
      `屬性表(ideational):訊息平均單位數${profile.layout.unitsPerMessage};${valueText};主題句(句首先說明對象)率${pct(profile.topicFirstRate)};含具體資料的訊息率${pct(profile.concreteDataRate)};${dateText};日期格式=${profile.dateFormat};金額格式=${profile.amountFormat}`,
    )

    // Block 1b: interpersonal attributes.
    const actText = profile.actRates
      .filter((entry) => entry.rate > 0)
      .map((entry) => `${entry.label}${pct(entry.rate)}`)
      .join('、')
    const strategyText = profile.strategyRates.length
      ? profile.strategyRates
          .map((entry) => `${entry.label}${pct(entry.rate)}`)
          .join('、')
      : '樣本未見請求'
    const moves = profile.mitigationMoves
    const reasonAttribute =
      profile.reasonSource.base >= 2
        ? `理由來源自陳${pct(profile.reasonSource.self / profile.reasonSource.base)}、轉述第三方${pct(profile.reasonSource.relayed / profile.reasonSource.base)}`
        : '理由來源:樣本不足,無法判定自陳或轉述'
    lines.push(
      `屬性表(interpersonal):言語行為分佈=${actText};請求的禮貌策略位置=${strategyText}(n=${profile.requestBase});降低 imposition 的動作附理由${pct(moves.reason)}、附期限${pct(moves.deadline)}、交由對方判斷${pct(moves.delegation)};${reasonAttribute};請求夾帶無關自身狀態率${pct(profile.selfDisclosure.rate)}`,
    )

    // Block 1c: textual attributes.
    const unitText = profile.unitRates
      .filter((entry) => entry.rate > 0)
      .map((entry) => `${entry.label}${pct(entry.rate)}`)
      .join('、')
    const fieldText =
      profile.layout.base === 0
        ? '樣本未見欄位單位'
        : `欄位逐列率${pct(profile.layout.fieldPerLineRate)}、串列率${pct(profile.layout.fieldSerialRate)}`
    lines.push(
      `屬性表(textual):單位分佈=${unitText};單位間空行分隔率${pct(profile.layout.blankSeparatedRate)};${fieldText}(n=${profile.layout.base})`,
    )
  }

  // Block 2: executable style instructions, grouped by metafunction.
  if (profile.sufficient) {
    const value = profile.valuePosition
    if (value.base > 0) {
      const preposed = value.preposed >= value.postposed
      const example = preposed
        ? profile.snippets.valuePreposed
        : profile.snippets.valuePostposed
      lines.push(
        `風格指令(ideational):${preposed ? '把期限、地址等背景資訊放在行動動詞之前' : '把行動放在前、具體值在後補述'}(本對話者${pct(
          (preposed ? value.preposed : value.postposed) / value.base,
        )}如此${example ? `,例:〈${example}〉` : ''})`,
      )
    }
    const dateFormatExample =
      profile.dateFormat === 'short'
        ? profile.snippets.dateShort
        : profile.dateFormat === 'iso'
          ? profile.snippets.dateIso
          : profile.dateFormat === 'chinese'
            ? profile.snippets.dateChinese
            : null
    if (profile.dateFormat !== 'none' && dateFormatExample) {
      lines.push(
        `風格指令(ideational):日期以${
          profile.dateFormat === 'short'
            ? '短式月/日'
            : profile.dateFormat === 'iso'
              ? '完整年/月/日'
              : '中文月日'
        }寫法呈現,例:〈${dateFormatExample}〉`,
      )
    }
    const wordingExample =
      profile.dateStyle.preferred === 'relative'
        ? profile.snippets.relativeDate
        : profile.dateStyle.preferred === 'absolute'
          ? profile.snippets.absoluteDate
          : null
    if (wordingExample) {
      lines.push(
        `風格指令(ideational):日期用語以${
          profile.dateStyle.preferred === 'relative' ? '相對日' : '完整日期'
        }為主,例:〈${wordingExample}〉`,
      )
    }

    const mitigated = profile.strategyRates.find(
      (entry) => entry.strategy === 'negative-politeness',
    )
    const direct = profile.strategyRates.find(
      (entry) => entry.strategy === 'bald-on-record',
    )
    const offRecord = profile.strategyRates.find(
      (entry) => entry.strategy === 'off-record',
    )
    if (mitigated && mitigated.rate >= 0.3) {
      lines.push(
        `風格指令(interpersonal):提出請求時在動詞短語前加迂迴標記以降低 imposition,並在必要時附期限;本對話者${pct(mitigated.rate)}的請求如此${
          profile.snippets.mitigated
            ? `,例:〈${profile.snippets.mitigated}〉`
            : ''
        }`,
      )
    }
    if (direct && direct.rate >= 0.3) {
      lines.push(
        `風格指令(interpersonal):提出請求時直接以動詞短語或「請」起句、不加迂迴標記;本對話者${pct(direct.rate)}的請求如此${
          profile.snippets.imperative
            ? `,例:〈${profile.snippets.imperative}〉`
            : ''
        }`,
      )
    }
    if (offRecord && offRecord.rate >= 0.3) {
      lines.push(
        `風格指令(interpersonal):需要對方自行判斷時,以條件式問句提出請求;本對話者${pct(offRecord.rate)}的請求如此${
          profile.snippets.conditional
            ? `,例:〈${profile.snippets.conditional}〉`
            : ''
        }`,
      )
    }
    const moves = profile.mitigationMoves
    if (moves.base > 0) {
      const moveText: string[] = []
      if (moves.reason >= 0.3) moveText.push(`附理由${pct(moves.reason)}`)
      if (moves.deadline >= 0.3) moveText.push(`附期限${pct(moves.deadline)}`)
      if (moves.delegation >= 0.3)
        moveText.push(`交由對方判斷${pct(moves.delegation)}`)
      if (moveText.length > 0) {
        lines.push(
          `風格指令(interpersonal):降低 imposition 的動作以${moveText.join('、')}為主(均為請求中的比例)`,
        )
      }
    }
    if (profile.reasonSource.base >= 2) {
      const self = profile.reasonSource.self >= profile.reasonSource.relayed
      const example = self
        ? profile.snippets.selfReason
        : profile.snippets.relayedReason
      lines.push(
        `風格指令(interpersonal):理由以${
          self ? '自己的理由直接說明' : '轉述第三方的要求'
        }為主(自陳${pct(
          profile.reasonSource.self / profile.reasonSource.base,
        )}、轉述${pct(profile.reasonSource.relayed / profile.reasonSource.base)}${
          example ? `,例:〈${example}〉` : ''
        })`,
      )
    } else {
      lines.push(
        `風格指令(interpersonal):理由來源資料不足(樣本${profile.reasonSource.base}則理由可判),起草時勿自行加入理由或轉述第三方要求`,
      )
    }
    if (profile.selfDisclosure.base > 0) {
      lines.push(
        `風格指令(interpersonal):${
          profile.selfDisclosure.rate >= 0.3
            ? `敘述自己的處境時可帶入現況(${pct(profile.selfDisclosure.rate)}的請求如此${
                profile.snippets.selfDisclosure
                  ? `,例:〈${profile.snippets.selfDisclosure}〉`
                  : ''
              })`
            : `不夾帶與請求無關的自身狀態(僅約${pct(profile.selfDisclosure.rate)}的請求如此)`
        }`,
      )
    }
    if (profile.registers.length > 1) {
      const registerText = profile.registers
        .map(
          (register) =>
            `${register.chatId}:迂迴率${pct(register.mitigationRate)}${
              register.honorific ? `、稱呼「${register.honorific}」` : ''
            }`,
        )
        .join(';')
      lines.push(
        `風格指令(interpersonal):對不同對象調整迂迴度與稱呼(${registerText})`,
      )
    }

    const unitText = profile.unitRates
      .filter((entry) => entry.rate > 0)
      .map((entry) => `${entry.label}${pct(entry.rate)}`)
      .join('、')
    lines.push(
      `風格指令(textual):訊息切分为${unitText};單位之間${
        profile.layout.blankSeparatedRate >= 0.3
          ? '多以空行分隔'
          : '多不以空行分隔'
      }(空行分隔率${pct(profile.layout.blankSeparatedRate)})`,
    )
    if (profile.layout.base > 0) {
      const perLine =
        profile.layout.fieldPerLineRate >= profile.layout.fieldSerialRate
      const fieldExample = perLine
        ? profile.snippets.fieldPerLine
        : profile.snippets.fieldSerial
      lines.push(
        `風格指令(textual):具體欄位${
          perLine ? '以單一標籤逐列成行' : '以多個標籤在同一行串列'
        }(逐列率${pct(profile.layout.fieldPerLineRate)}、串列率${pct(
          profile.layout.fieldSerialRate,
        )})${fieldExample ? `,例:〈${fieldExample}〉` : ''}`,
      )
    }
    const unitTransitions = profile.transitions
      .filter((transition) => transition.scope === 'unit')
      .slice(0, 3)
    if (unitTransitions.length > 0) {
      const text = unitTransitions
        .map(
          (transition) =>
            `「${transition.from}→${transition.to}」${pct(transition.rate)}(${transition.count}次)`,
        )
        .join('、')
      lines.push(
        `風格指令(textual):單位銜接以${text}的關聯最常見;這是觀察到的走法,不是固定骨架`,
      )
    }
  }

  // Block 3: the talker's own words, grouped by situation.
  if (profile.examples.length > 0) {
    for (const example of profile.examples) {
      lines.push(`本人原句(情境「${example.situation}」):〈${example.text}〉`)
    }
  } else if (profile.sufficient) {
    lines.push(
      `本人原句:${sample}中未見可歸納的常見情境,勿套用其他人的起草骨架`,
    )
  }

  // Block 4: prohibitions and unobserved items.
  if (profile.prohibitions.length > 0) {
    lines.push(
      `禁令／未觀測(啟發式近似):${profile.prohibitions
        .map(
          (prohibition) => `${prohibition.text}(依據:${prohibition.evidence})`,
        )
        .join(';')}`,
    )
  }

  // Identification-only dimension (stylometry): not a mimicry instruction.
  if (profile.honorifics.dominant) {
    lines.push(
      `鑑別用途(功能詞偏好,非模仿規範):稱呼以「${profile.honorifics.dominant}」為主(您${pct(
        profile.honorifics.ningRate,
      )}、妳${pct(profile.honorifics.neiRate)}、你${pct(
        profile.honorifics.niRate,
      )});此維度用於辨識作者,不作為模仿規範`,
    )
  }

  // Block 5: uncertainty.
  if (profile.uncertainties.length > 0) {
    lines.push(`不確定性(啟發式近似):${profile.uncertainties.join(';')}`)
  }
  return lines
}
