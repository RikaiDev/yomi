/**
 * Yomi CLI logger — minimal structured logger.
 *
 * Mirrors the call shape used throughout the vendored LINE protocol core
 * (`logger.info(event, context)` / `.warn` / `.error` / `.debug` / `.child`)
 * so no call sites needed to change during extraction.
 *
 * Output uses `[TAG]` prefixes — no emoji, per project convention.
 */

type Primitive = string | number | boolean | null | undefined | bigint
type LogContext = Record<string, Primitive>

interface LoggerOptions {
  indent?: string
}

export interface Logger {
  info: (event: string, context?: LogContext) => void
  warn: (event: string, context?: LogContext) => void
  error: (event: string, context?: LogContext) => void
  debug: (event: string, context?: LogContext) => void
  child: (nextOptions?: LoggerOptions) => Logger
}

/**
 * Format a primitive value for key=value log output.
 *
 * @param value - Primitive log value.
 * @returns String representation suitable for log output.
 */
function formatValue(value: Primitive): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return value.toString()
  return String(value)
}

/**
 * Format structured context into sorted key=value segments.
 *
 * @param context - Optional structured log context.
 * @returns Formatted suffix beginning with a leading space when non-empty.
 */
function formatContext(context?: LogContext): string {
  if (!context) return ''
  const entries = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${formatValue(value)}`)
  return entries.length > 0 ? ` ${entries.join(' ')}` : ''
}

/**
 * Emit one log line to stderr, prefixed with the scope tag.
 *
 * stderr is used (not stdout) because Yomi's MCP server speaks JSON-RPC
 * over stdout for the stdio transport — any stray stdout write would
 * corrupt the protocol stream.
 *
 * @param method - Console method to use.
 * @param scope - Logger scope, rendered as `[SCOPE]`.
 * @param level - Log level name.
 * @param event - Event identifier.
 * @param context - Optional structured context.
 * @param options - Optional rendering options such as indentation.
 */
function emit(
  _method: 'log' | 'warn' | 'error',
  scope: string,
  level: string,
  event: string,
  context?: LogContext,
  options: LoggerOptions = {},
): void {
  const indent = options.indent ?? ''
  const line = `${indent}[${scope}] ${level.toUpperCase()} ${event}${formatContext(context)}`
  console.error(line)
}

/**
 * Create a scope-bound CLI logger.
 *
 * @param scope - Scope label rendered inside square brackets, e.g. "LINE".
 * @param options - Optional rendering options such as indentation.
 * @returns Scope-bound logger.
 */
export function createCliLogger(
  scope: string,
  options: LoggerOptions = {},
): Logger {
  return {
    info(event, context) {
      emit('log', scope, 'info', event, context, options)
    },
    warn(event, context) {
      emit('warn', scope, 'warn', event, context, options)
    },
    error(event, context) {
      emit('error', scope, 'error', event, context, options)
    },
    debug(event, context) {
      emit('log', scope, 'debug', event, context, options)
    },
    child(nextOptions = {}) {
      return createCliLogger(scope, { ...options, ...nextOptions })
    },
  }
}
