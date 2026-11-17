/**
 * Key-case conversion at the MCP boundary.
 *
 * Yomi's public contract — tool names, tool arguments, tool results — is
 * snake_case. Everything behind the boundary (SQLite columns, TypeScript
 * variables, handler signatures) stays camelCase, because that is the
 * language's own convention and the index schema is not ours to churn.
 *
 * The two functions below are the only place the two conventions meet:
 * incoming snake_case arguments are converted to the camelCase shape the
 * handlers expect, and outgoing payloads are converted the other way. Both
 * conversions touch KEYS only; values, including message text, are never
 * rewritten.
 */

/** Convert one camelCase key to snake_case. `chatId` → `chat_id`. */
export function camelToSnake(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/** Convert one snake_case key to camelCase. `chat_id` → `chatId`. */
export function snakeToCamel(key: string): string {
  if (!key.includes('_')) return key
  return key.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function convertKeys(
  value: unknown,
  convert: (key: string) => string,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => convertKeys(item, convert))
  if (value === null || typeof value !== 'object') return value
  // Date, Map, Set and other exotic objects are left alone: only plain
  // payload objects are rewritten.
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[convert(key)] = convertKeys(item, convert)
  }
  return out
}

/** Rewrite every key of a payload tree to snake_case. */
export function toSnakeCaseKeys<T>(value: T): T {
  return convertKeys(value, camelToSnake) as T
}

/**
 * Rewrite every key of a payload tree to camelCase.
 *
 * Keys that are already camelCase (no underscore) are left untouched, so a
 * client that still sends the old spelling keeps working; that tolerance is
 * an implementation detail, not part of the declared contract.
 */
export function toCamelCaseKeys<T>(value: T): T {
  return convertKeys(value, snakeToCamel) as T
}
