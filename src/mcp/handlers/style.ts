/**
 * MCP handlers for the style surface.
 *
 * The style profile is two layers, and the split is the point:
 *
 * - **measured** — statistics computed from the indexed messages. They
 *   describe a corpus; they are not instructions.
 * - **rules** — judgements a model wrote after reading the owner's own
 *   messages as evidence, each with the sentence it was based on, the
 *   situation it applies to, and the situation it does not apply to. Rules
 *   win when the two disagree.
 *
 * A third piece travels with both: the conversation's vocabulary, split by
 * who used each term. `known_terms` are terms the counterpart has used
 * themselves; `unconfirmed_terms` are terms only the owner has used, which is
 * exactly the list of things that can confuse someone who has never heard of
 * them.
 */

import type { LineProtocolService } from '../../line/core/service.js'
import { listStyleRules, upsertStyleRule } from '../../search/store.js'
import { getStyleCard } from '../../search/style-profile.js'
import {
  type ChatVocabulary,
  getChatVocabulary,
  getStyleEvidence,
} from '../../search/style-rules.js'
import { jsonResult, toolError } from './shared.js'

const LAYER_NOTE =
  'measured 是統計量測，不是行為規則；rules 是模型依原句寫下的判斷，兩者衝突時以 rules 為準。' +
  'vocabulary.known_terms 是對方自己用過的詞，unconfirmed_terms 是只有你用過、對方沒見過的詞——' +
  '引用對方沒見過的專有名詞或公司名，是最常見的失禮來源。'

function userMidOf(service: LineProtocolService): string | undefined {
  return service.profile?.mid
}

/**
 * Split the stored rules into the global ones and the ones scoped to a chat.
 */
function splitRules(rules: ReturnType<typeof listStyleRules>): {
  global: unknown[]
  chat: unknown[]
} {
  return {
    global: rules.filter((rule) => rule.scope === 'global'),
    chat: rules.filter((rule) => rule.scope !== 'global'),
  }
}

/**
 * MCP handler for `get_style_profile` — the measured card, the written rules,
 * and the conversation's vocabulary, kept apart.
 */
export async function handleGetStyleProfile(
  service: LineProtocolService,
  args: { chatId?: string },
) {
  const userMid = userMidOf(service)
  if (!userMid) {
    return toolError(
      "No LINE session — cannot determine the user's MID. " +
        'Log in first, then run collect_messages to populate the index.',
    )
  }

  try {
    const card = getStyleCard(userMid, args.chatId)

    if (!card || (card.textSampleSize === 0 && card.stickerSampleSize === 0)) {
      return jsonResult({
        ok: false,
        message:
          'No sent messages found in the search index. Run collect_messages to index your messages, then retry.',
      })
    }

    const rules = listStyleRules(args.chatId ? { chatId: args.chatId } : {})
    const vocabulary = args.chatId
      ? getChatVocabulary(userMid, args.chatId)
      : getChatVocabulary(userMid)

    return jsonResult({
      ok: true,
      note: LAYER_NOTE,
      measured: card,
      rules: splitRules(rules),
      vocabulary,
      vocabulary_note: args.chatId
        ? 'vocabulary 只涵蓋指定的這一段對話。'
        : 'vocabulary 涵蓋最近 5 段對話；要精準對象請帶 chat_id 重讀。',
    })
  } catch (error: any) {
    return toolError(
      `Failed to build style profile: ${error?.message ?? String(error)}`,
    )
  }
}

/**
 * MCP handler for `get_style_evidence` — the owner's own messages, quoted,
 * with the situation each one answered, and the conversation's vocabulary.
 */
export async function handleGetStyleEvidence(
  service: LineProtocolService,
  args: { chatId?: string; limit?: number },
) {
  const userMid = userMidOf(service)
  if (!userMid) {
    return toolError(
      "No LINE session — cannot determine the user's MID. " +
        'Log in first, then run collect_messages to populate the index.',
    )
  }
  try {
    const quotes = getStyleEvidence(userMid, args.chatId, args.limit ?? 60)
    const vocabulary: ChatVocabulary[] = getChatVocabulary(userMid, args.chatId)
    return jsonResult({
      ok: true,
      note:
        '這是你自己的原句與它回答的情境。讀完之後，用 add_style_rule 把結論寫成規則，' +
        '附上你依據的原句與適用情境；不要把量測當成規則直接採用。',
      quotes,
      vocabulary,
    })
  } catch (error: any) {
    return toolError(
      `Failed to collect style evidence: ${error?.message ?? String(error)}`,
    )
  }
}

/**
 * MCP handler for `add_style_rule` — record a rule a model wrote from the
 * owner's own words.
 */
export async function handleAddStyleRule(
  _service: LineProtocolService,
  args: {
    statement: string
    evidence: string
    ruleId?: string
    chatId?: string
    appliesWhen?: string
    doesNotApplyWhen?: string
    counterExample?: string
    origin?: string
    confidence?: number
    supersedes?: string
  },
) {
  const statement = args.statement?.trim()
  const evidence = args.evidence?.trim()
  if (!statement || !evidence) {
    return toolError(
      'statement and evidence are both required — evidence is the owner sentence the rule was read from.',
    )
  }
  try {
    const ruleId =
      args.ruleId?.trim() ||
      `style-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const rule = {
      ruleId,
      scope: args.chatId ? 'chat' : 'global',
      chatId: args.chatId ?? null,
      statement,
      appliesWhen: args.appliesWhen?.trim() || null,
      doesNotApplyWhen: args.doesNotApplyWhen?.trim() || null,
      evidence,
      counterExample: args.counterExample?.trim() || null,
      origin: args.origin === 'stated' ? 'stated' : 'derived',
      confidence:
        typeof args.confidence === 'number'
          ? Math.min(1, Math.max(0, args.confidence))
          : 0.5,
      status: 'active',
      supersedes: args.supersedes?.trim() || null,
      createdAt: Date.now(),
    }
    const id = upsertStyleRule(rule)
    return jsonResult({ ok: true, ruleId, id })
  } catch (error: any) {
    return toolError(
      `Failed to store style rule: ${error?.message ?? String(error)}`,
    )
  }
}

/**
 * MCP handler for `get_style_rules` — read the rules in force, or the whole
 * history including superseded ones.
 */
export async function handleGetStyleRules(
  _service: LineProtocolService,
  args: { chatId?: string; includeSuperseded?: boolean },
) {
  try {
    const rules = listStyleRules({
      chatId: args.chatId,
      includeSuperseded: args.includeSuperseded,
    })
    return jsonResult({
      ok: true,
      rules: splitRules(rules),
      history: args.includeSuperseded ? rules : undefined,
    })
  } catch (error: any) {
    return toolError(
      `Failed to read style rules: ${error?.message ?? String(error)}`,
    )
  }
}
