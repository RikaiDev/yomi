/**
 * LINE Client sync capability.
 */

import { createCliLogger } from '../../../util/log.js'
import { LINE_APP_CONFIG } from '../../core/config.js'
import { OP_TYPE } from '../../core/constants.js'
import { encodeCallMessage } from '../../core/thrift/index.js'
import type { ThriftFieldTuple } from '../../core/thrift/types.js'
import { sendRequest } from '../transport.js'

/**
 * Check whether a logger exposes the CLI logger contract used by LINE sync.
 *
 * @param logger - Candidate logger.
 * @returns True when the logger supports info/warn/error.
 */
function hasCliLogger(logger: any): boolean {
  return Boolean(logger?.info && logger?.warn && logger?.error)
}

/**
 * Resolve the active logger for one LINE sync runtime.
 *
 * @param runtime - LINE client runtime.
 * @returns Logger for sync diagnostics.
 */
function getLineLog(runtime: any) {
  if (hasCliLogger(runtime?.startupFlowLogger)) {
    return runtime.startupFlowLogger
  }
  if (hasCliLogger(runtime?.logger)) {
    return runtime.logger
  }
  return createCliLogger('LINE')
}

/**
 * Build the thrift payload for one sync request.
 *
 * @param runtime - LINE client runtime.
 * @param count - Maximum operations requested.
 * @returns Encoded sync request payload.
 */
function buildSyncPayload(runtime: any, count: number) {
  const fields: ThriftFieldTuple[] = [
    [
      12,
      1,
      [
        [10, 1, Math.max(0, runtime.revision)],
        [8, 2, count],
        [10, 3, runtime.globalRevision ?? 0],
        [10, 4, runtime.individualRevision ?? 0],
      ],
    ],
  ]
  return encodeCallMessage('sync', runtime.seq++, fields)
}

/**
 * Parse raw LINE operations into normalized operation objects.
 *
 * @param runtime - LINE client runtime.
 * @param ops - Raw operation array.
 * @returns Parsed operations.
 */
function parseOperations(runtime: any, ops: any[] | undefined) {
  return Array.isArray(ops)
    ? ops.map((op) => runtime.parseOperation(op)).filter(Boolean)
    : []
}

/**
 * Apply token rotation returned from a sync response.
 *
 * @param runtime - LINE client runtime.
 * @param result - Decoded sync response.
 */
function applyTokenRotation(runtime: any, result: any): void {
  if (!result.nextToken) {
    return
  }
  runtime.authToken = result.nextToken
  runtime.emit('tokenRotated', result.nextToken)
}

/**
 * Throw when the sync response contains a thrift exception payload.
 *
 * @param result - Decoded sync response.
 * @param lineLog - Active LINE logger.
 */
function throwSyncException(result: any, lineLog: any): void {
  const exc = result.fields?.[1]
  if (!exc || typeof exc !== 'object') {
    return
  }
  const excMsg = typeof exc[2] === 'string' ? exc[2] : JSON.stringify(exc)
  lineLog.error('sync.exception', { error: excMsg })
  throw new Error(`sync exception: ${excMsg}`)
}

/**
 * Apply revision fields from one sync response and return raw operations.
 *
 * @param runtime - LINE client runtime.
 * @param response - Top-level sync response payload.
 * @returns Raw operations array.
 */
function updateSyncRevisions(runtime: any, response: any): any[] | undefined {
  const operationResponse = response?.[1]
  const ops = operationResponse?.[1]
  const nextRevision = response?.[2]
  const lastGlobalRevision = operationResponse?.[2]
  const lastIndividualRevision = operationResponse?.[3]

  if (typeof nextRevision === 'number' || typeof nextRevision === 'bigint') {
    runtime.revision =
      typeof nextRevision === 'bigint' ? Number(nextRevision) : nextRevision
  }
  if (
    typeof lastGlobalRevision === 'number' ||
    typeof lastGlobalRevision === 'bigint'
  ) {
    runtime.globalRevision =
      typeof lastGlobalRevision === 'bigint'
        ? Number(lastGlobalRevision)
        : lastGlobalRevision
  }
  if (
    typeof lastIndividualRevision === 'number' ||
    typeof lastIndividualRevision === 'bigint'
  ) {
    runtime.individualRevision =
      typeof lastIndividualRevision === 'bigint'
        ? Number(lastIndividualRevision)
        : lastIndividualRevision
  }

  return ops
}

/**
 * Emit one sync poll summary and maintain idle counters.
 *
 * @param lineLog - Active LINE logger.
 * @param runtime - LINE client runtime.
 * @param opCount - Number of operations returned.
 * @param elapsedMs - Poll duration in milliseconds.
 */
function recordSyncPoll(
  lineLog: any,
  runtime: any,
  opCount: number,
  elapsedMs: number,
): void {
  if (opCount > 0) {
    lineLog.info('sync.event', {
      elapsed_ms: elapsedMs,
      ops: opCount,
      revision: runtime.revision,
    })
    runtime._syncEmptyLogCount = 0
    return
  }
  runtime._syncEmptyLogCount = (runtime._syncEmptyLogCount || 0) + 1
  if (
    runtime._syncEmptyLogCount === 1 ||
    runtime._syncEmptyLogCount % 10 === 0
  ) {
    lineLog.info('sync.idle', {
      elapsed_ms: elapsedMs,
      empty_polls: runtime._syncEmptyLogCount,
      revision: runtime.revision,
    })
  }
}

/**
 * Emit parsed operations to downstream listeners and advance revisions.
 *
 * @param runtime - LINE client runtime.
 * @param ops - Parsed operations.
 */
function emitOperations(runtime: any, ops: any[]): void {
  for (const op of ops) {
    runtime.emit('operation', op)
    if (op.type === OP_TYPE.RECEIVE_MESSAGE && op.message) {
      runtime.emit('message', op.message)
    }
    if (op.revision && op.revision > runtime.revision) {
      runtime.revision = op.revision
    }
  }
}

/**
 * Compute the next poll delay from the current activity level.
 *
 * @param opCount - Number of operations returned.
 * @param consecutiveEmptyPolls - Consecutive idle poll count.
 * @returns Delay in milliseconds.
 */
function getNextPollDelay(
  opCount: number,
  consecutiveEmptyPolls: number,
): number {
  if (opCount > 0) {
    return 250
  }
  return Math.min(1000 * 2 ** Math.min(consecutiveEmptyPolls, 4), 15000)
}

/**
 * Sleep helper used by the polling loop.
 *
 * @param ms - Delay in milliseconds.
 * @returns Promise resolving after the delay.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run one long-poll iteration and emit any returned operations.
 *
 * @param runtime - LINE client runtime.
 * @returns Parsed operations from this poll.
 */
async function pollOnce(runtime: any): Promise<any[]> {
  const ops = await runtime.syncLongPoll(50, 60000)
  emitOperations(runtime, ops)
  return ops
}

/**
 * Create the sync capability bound to one LINE client runtime.
 *
 * @param runtime - Mutable LINE client runtime.
 * @returns Sync and polling methods bound to the runtime.
 */
export function createSyncClient(runtime) {
  return {
    /**
     * Sync operations since the current revision.
     *
     * @param count - Maximum number of operations to retrieve.
     * @returns Parsed operations.
     */
    async sync(count = 50) {
      const data = buildSyncPayload(runtime, count)
      const result = await sendRequest(
        runtime.host,
        LINE_APP_CONFIG.syncPath,
        data,
        { 'X-Line-Access': runtime.authToken },
        10000,
      )
      if (result.error === 'timeout') {
        return []
      }
      const ops = result.fields?.[0]?.[1]?.[1]
      return parseOperations(runtime, ops)
    },
    /**
     * Long-poll sync until new operations arrive or the timeout elapses.
     *
     * @param count - Maximum number of operations to retrieve.
     * @param timeoutMs - Long-poll timeout in milliseconds.
     * @returns Parsed operations.
     */
    async syncLongPoll(count = 50, timeoutMs = 60000) {
      const lineLog = getLineLog(runtime)
      const startedAt = Date.now()
      const data = buildSyncPayload(runtime, count)
      const result = await sendRequest(
        runtime.host,
        LINE_APP_CONFIG.syncPath,
        data,
        { 'X-Line-Access': runtime.authToken },
        timeoutMs + 5000,
      )
      if (result.error === 'timeout') {
        return []
      }
      applyTokenRotation(runtime, result)
      throwSyncException(result, lineLog)
      if (result.statusCode && result.statusCode !== 200) {
        lineLog.warn('sync.http', { status_code: result.statusCode })
      }
      const response = result.fields?.[0]
      const ops = updateSyncRevisions(runtime, response)
      const opCount = Array.isArray(ops) ? ops.length : 0
      recordSyncPoll(lineLog, runtime, opCount, Date.now() - startedAt)
      return parseOperations(runtime, ops)
    },
    /**
     * Fetch the latest operation revision from the server.
     *
     * @returns The latest operation revision.
     */
    async getLastOpRevision() {
      const lineLog = getLineLog(runtime)
      const result = await runtime.sendTalk('getLastOpRevision', [])
      if (result.fields?.[1]) {
        const exc = result.fields[1]
        lineLog.error('revision.fetch.failed', { error: JSON.stringify(exc) })
        throw new Error(`getLastOpRevision: ${exc[2] || exc[1] || 'unknown'}`)
      }
      const rev = result.fields?.[0]
      lineLog.info('revision.fetch', { type: typeof rev, value: rev })
      return rev !== undefined
        ? typeof rev === 'bigint'
          ? Number(rev)
          : rev
        : 0
    },
    /**
     * Start continuous polling for new operations and messages.
     *
     * @returns Promise resolving when polling stops.
     */
    async startPolling() {
      const lineLog = getLineLog(runtime)
      if (runtime.polling) {
        return
      }
      runtime.polling = true
      runtime.aborted = false
      if (runtime.revision < 0) {
        runtime.revision = await runtime.getLastOpRevision()
        lineLog.info('polling.start', { revision: runtime.revision })
      }
      let consecutiveEmptyPolls = 0
      while (runtime.polling && !runtime.aborted) {
        try {
          const ops = await pollOnce(runtime)
          consecutiveEmptyPolls =
            ops.length === 0 ? consecutiveEmptyPolls + 1 : 0
          await sleep(getNextPollDelay(ops.length, consecutiveEmptyPolls))
        } catch (err) {
          runtime.emit('error', err)
          consecutiveEmptyPolls = 0
          if (runtime.polling && !runtime.aborted) {
            await sleep(3000)
          }
        }
      }
    },
    /**
     * Stop the polling loop.
     */
    stopPolling() {
      runtime.polling = false
      runtime.aborted = true
    },
  }
}
