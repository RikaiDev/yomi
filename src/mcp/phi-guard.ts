/**
 * Yomi PHI/PII output guard — masks high-sensitivity values in message text
 * at the MCP tool-return boundary, right before the text leaves the local
 * machine for the cloud model.
 *
 * Deliberately narrow: only high-confidence, high-sensitivity types (national
 * ID, Luhn-valid payment card, email, mobile phone) are masked, NOT every
 * number — masking too much would strip context the assistant legitimately
 * needs (e.g. "the Taitung meeting is at 3pm"). Detection is regex-only for
 * now; a local semantic (MLX) layer and per-conversation exemptions are
 * deliberately deferred, not silently dropped.
 *
 * Honesty: masking is never silent. Callers surface `phiNote(acc)` as an
 * extra response content block reporting how many values were masked and of
 * what types, so the redaction is visible rather than a quiet rewrite.
 */

/** Running tally of what one tool response masked. */
export interface PhiAccumulator {
  count: number;
  types: Set<string>;
}

/** Middle-redaction marker used in masked values (Q12〇〇9 style). */
const MASK_MIDDLE = '〇〇';

/**
 * Luhn check for candidate payment-card digit strings.
 * @param digits - Digits only (no separators).
 * @returns True when the digits satisfy the Luhn checksum.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
}

/**
 * Mask one matched value, preserving a little edge context (Q12〇〇9): the
 * first few characters and, for longer values, the last one.
 * @param value - The raw matched substring.
 * @returns The masked substring.
 */
function maskValue(value: string): string {
  const trimmed = value.trim();
  const head = trimmed.slice(0, Math.min(3, trimmed.length));
  const tail = trimmed.length > 4 ? trimmed.slice(-1) : '';
  return `${head}${MASK_MIDDLE}${tail}`;
}

/** One detection rule. `validateDigits` (optional) gates a match on its digit-only form. */
interface PhiPattern {
  type: string;
  re: RegExp;
  validateDigits?: (digits: string) => boolean;
}

// Order matters: email and phone are matched before the broad card pattern so
// their digits are not re-consumed. Each RegExp MUST have the global flag.
const PATTERNS: PhiPattern[] = [
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'id', re: /\b[A-Z][12]\d{8}\b/g },
  { type: 'phone', re: /\+886[\s-]?\d(?:[\s-]?\d){7,}/g },
  { type: 'phone', re: /\b09\d{8}\b/g },
  { type: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, validateDigits: passesLuhn },
];

/**
 * Create a fresh accumulator for one tool response.
 * @returns A zeroed PhiAccumulator.
 */
export function createPhiAccumulator(): PhiAccumulator {
  return { count: 0, types: new Set<string>() };
}

/**
 * Mask all high-sensitivity spans in one string, tallying into `acc`. Returns
 * the input unchanged (and untallied) for null/empty/non-string input.
 * @param acc - Accumulator to record masked count and types into.
 * @param value - Text to mask.
 * @returns The masked text (or the original value when nothing to mask).
 */
export function maskInto<T extends string | null | undefined>(acc: PhiAccumulator, value: T): T {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  let text: string = value;
  for (const { type, re, validateDigits } of PATTERNS) {
    text = text.replace(re, (match) => {
      if (validateDigits && !validateDigits(match.replace(/\D/g, ''))) {
        return match;
      }
      acc.count += 1;
      acc.types.add(type);
      return maskValue(match);
    });
  }
  return text as T;
}

/**
 * Build the honesty note for a tool response, or null when nothing was masked.
 * @param acc - Accumulator populated by maskInto.
 * @returns An MCP text content block reporting the redaction, or null.
 */
export function phiNote(acc: PhiAccumulator): { type: 'text'; text: string } | null {
  if (acc.count === 0) {
    return null;
  }
  const types = [...acc.types].sort().join(', ');
  return {
    type: 'text',
    text: `[phi-guard] Masked ${acc.count} high-sensitivity value(s) (${types}) before returning them. These are redacted for privacy; if the raw value is genuinely needed, ask the user explicitly.`,
  };
}
