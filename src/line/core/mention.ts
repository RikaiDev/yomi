/**
 * LINE outbound @mention wire format — `contentMetadata.MENTION`.
 *
 * Reverse-engineered from two real inbound group messages captured by the
 * operator (see the task ground truth, not restated here). Established
 * facts, and nothing beyond them:
 *
 * - `contentMetadata.MENTION` is a JSON *string* whose parsed shape is
 *   `{ MENTIONEES: [{ M, S, E }, ...] }`.
 * - `M` is the mentioned user's MID; `S`/`E` are the start/end offsets as
 *   *strings*, not numbers.
 * - The range is half-open `[S, E)`, measured in UTF-16 code units — i.e.
 *   plain JS string indices (`"@鄭富源".length === 4` matched `S:"0", E:"4"`).
 * - Key order inside a mentionee object is not significant.
 * - MENTION rides in `contentMetadata`, which is never part of an E2EE
 *   ciphertext payload — it was observed in the clear on a real message.
 *
 * This module only builds and validates that wire shape. It does not
 * resolve display names to MIDs (that guess is out of scope — see
 * `find_contact`/`get_group_members`), and it does not extend the format
 * with anything not listed above.
 */

/**
 * One outbound mention: a mid plus the half-open `[start, end)` UTF-16
 * offset range into the message text that mid's `@name` occupies.
 *
 * Numbers, not strings, at this boundary — the wire format's `S`/`E`
 * strings are a serialization detail `buildMentionMetadata` handles, not
 * something callers should have to think about.
 */
export interface Mention {
  mid: string
  start: number
  end: number
}

/**
 * Validate a set of outbound mentions against the text they annotate.
 * Throws a descriptive `Error` on the first violation found. Every check
 * here exists because a malformed mention does not fail loudly on LINE's
 * side — it silently degrades to a plain, non-notifying `@name` string,
 * which is exactly the failure this module exists to prevent.
 *
 * @param text - The message body the mentions index into.
 * @param mentions - Proposed mentions.
 * @throws Error describing the first invalid mention or overlap found.
 */
function validateMentions(text: string, mentions: Mention[]): void {
  const sorted = [...mentions].sort((a, b) => a.start - b.start)

  for (const mention of sorted) {
    const { mid, start, end } = mention

    if (typeof mid !== 'string' || mid.length === 0) {
      throw new Error(
        `Mention mid must be a non-empty string (got: ${JSON.stringify(mid)}).`,
      )
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(
        `Mention start/end must be integers (got start=${start}, end=${end}, mid=${mid}).`,
      )
    }
    if (!(start >= 0 && start < end)) {
      throw new Error(
        `Mention range must satisfy 0 <= start < end (got start=${start}, end=${end}, mid=${mid}).`,
      )
    }
    if (end > text.length) {
      throw new Error(
        `Mention end (${end}) exceeds text length (${text.length}) for mid=${mid}.`,
      )
    }
    // Heuristic guard derived from observed data, not a documented LINE
    // protocol requirement: every real mention we have seen starts at the
    // visible "@" of the "@name" run. A range that does not is almost
    // certainly an off-by-one that would render as a broken/misaligned
    // highlight rather than a real notification.
    if (text[start] !== '@') {
      throw new Error(
        `Mention range [${start}, ${end}) for mid=${mid} must start at "@" (the "@name" run in text), ` +
          `but text[${start}] is ${JSON.stringify(text[start])}. `,
      )
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (cur.start < prev.end) {
      throw new Error(
        `Mention ranges overlap: [${prev.start}, ${prev.end}) (mid=${prev.mid}) ` +
          `and [${cur.start}, ${cur.end}) (mid=${cur.mid}).`,
      )
    }
  }
}

/**
 * Build the `contentMetadata.MENTION` wire value for a set of outbound
 * mentions, validating them against `text` first. It is not possible to
 * obtain a built metadata string without passing validation — the two are
 * deliberately not separable at the call site.
 *
 * @param text - The message body the mentions index into.
 * @param mentions - Mentions to encode.
 * @returns The JSON string LINE expects at `contentMetadata.MENTION`.
 * @throws Error - see `validateMentions`.
 */
export function buildMentionMetadata(
  text: string,
  mentions: Mention[],
): string {
  validateMentions(text, mentions)
  return JSON.stringify({
    MENTIONEES: mentions.map((m) => ({
      S: String(m.start),
      E: String(m.end),
      M: m.mid,
    })),
  })
}
