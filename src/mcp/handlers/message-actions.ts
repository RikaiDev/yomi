import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'
import { jsonResult, toolError } from './shared.js'

const log = createCliLogger('Yomi')

/**
 * Handle `react_message` — REALLY adds a predefined reaction to a real LINE
 * message now (TalkService react). Visible to the conversation. `reactionType`:
 * 2=LIKE 👍, 3=LOVE ❤️, 4=LAUGH 😆, 5=SURPRISE 😮, 6=SAD 😢, 7=ANGRY 😡
 * (default 2).
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleReactMessage(
  service: LineProtocolService,
  args: { messageId: string; reactionType?: number },
) {
  if (!args.messageId) {
    return toolError('messageId is required.')
  }
  const result = await service.reactToMessage(args.messageId, args.reactionType)
  log.info('react_message.done', {
    messageId: args.messageId,
    reactionType: result?.reactionType,
  })
  return jsonResult(result)
}

/**
 * Handle `unsend_message` — REALLY retracts one of THIS account's own messages
 * for everyone (TalkService unsendMessage). This deletes the message from the
 * conversation for all participants and is NOT reversible. Guarded by an
 * explicit `confirm: true` gate so it can never fire by accident. LINE only
 * permits unsending the caller's own messages.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleUnsendMessage(
  service: LineProtocolService,
  args: { messageId: string; confirm?: boolean },
) {
  if (!args.messageId) {
    return toolError('messageId is required.')
  }
  if (args.confirm !== true) {
    return toolError(
      'unsend_message permanently retracts your message for everyone and cannot be undone. Re-call with confirm: true to proceed.',
    )
  }
  const result = await service.unsendMessage(args.messageId)
  log.info('unsend_message.done', { messageId: args.messageId })
  return jsonResult(result)
}

/**
 * Handle `cancel_reaction` — REALLY removes THIS account's reaction from a real
 * LINE message now (TalkService cancelReaction).
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleCancelReaction(
  service: LineProtocolService,
  args: { messageId: string },
) {
  if (!args.messageId) {
    return toolError('messageId is required.')
  }
  const result = await service.cancelReaction(args.messageId)
  log.info('cancel_reaction.done', { messageId: args.messageId })
  return jsonResult(result)
}
