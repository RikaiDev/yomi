/**
 * CJK-aware bigram preprocessing for FTS5 indexing/querying.
 *
 * The FTS5 `unicode61` tokenizer has no Chinese/Japanese/Korean word
 * segmentation: a whole CJK run collapses into a single opaque token, so a
 * substring like "會議" inside "會議通知" never matches. Yomi has no ICU
 * tokenizer available and takes on no new dependency to get one, so instead
 * both the indexed text and the search query are rewritten into overlapping
 * character bigrams for CJK runs before ever reaching FTS5. Overlapping
 * bigrams turn "會議通知" into "會議 議通 通知" — searching for "會議"
 * (itself a single bigram once transformed) becomes a plain token match.
 * This covers the common case of 2+ character CJK words; single-character
 * CJK terms still match via the emitted unigram.
 *
 * Non-CJK runs (Latin, digits, punctuation) are left untouched and keep
 * relying on unicode61's normal whitespace/punctuation tokenization.
 */

/**
 * CJK ranges covered: CJK Unified Ideographs + Extension A, CJK
 * Compatibility Ideographs, Hiragana/Katakana, and Hangul Syllables.
 */
const CJK_PATTERN = /[㐀-鿿豈-﫿぀-ヿ가-퟿]/;

/**
 * Determine whether a single character falls in a CJK range that needs
 * bigram splitting rather than unicode61's default tokenization.
 *
 * @param ch - A single character to classify.
 * @returns True when the character is CJK (ideograph, kana, or Hangul).
 */
function isCjkChar(ch: string): boolean {
  return CJK_PATTERN.test(ch);
}

/**
 * Convert a run of CJK characters into space-separated overlapping
 * bigrams (or the single character itself, for a length-1 run).
 *
 * @param run - A maximal run of CJK characters.
 * @returns Space-separated bigrams (or the lone character).
 */
function bigramsForRun(run: string): string {
  const chars = Array.from(run);
  if (chars.length <= 1) {
    return chars.join('');
  }
  const grams: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    grams.push(chars[i] + chars[i + 1]);
  }
  return grams.join(' ');
}

/**
 * Rewrite raw text into its FTS5-searchable form: CJK runs become
 * space-separated overlapping bigrams, non-CJK runs pass through
 * unchanged. Apply this identically at index time (to the stored
 * `search_text`) and at query time (to the user's search string) so the
 * same substring produces matching tokens on both sides.
 *
 * @param raw - Raw display text (message body or user query).
 * @returns Bigram-preprocessed text suitable for an FTS5 MATCH/index.
 */
export function toSearchText(raw: string): string {
  if (!raw) {
    return '';
  }
  const chars = Array.from(raw);
  const pieces: string[] = [];
  let runStart = 0;
  let runIsCjk = chars.length > 0 ? isCjkChar(chars[0]) : false;

  const flush = (end: number) => {
    if (end <= runStart) {
      return;
    }
    const run = chars.slice(runStart, end).join('');
    pieces.push(runIsCjk ? bigramsForRun(run) : run);
  };

  for (let i = 1; i < chars.length; i++) {
    const cjk = isCjkChar(chars[i]);
    if (cjk !== runIsCjk) {
      flush(i);
      runStart = i;
      runIsCjk = cjk;
    }
  }
  flush(chars.length);

  return pieces
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
