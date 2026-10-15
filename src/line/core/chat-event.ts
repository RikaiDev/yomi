export function chatEventParticipantMids(message: any): string[] {
  if (Number(message?.contentType) !== 18) return []
  const raw = message?.contentMetadata?.LOC_ARGS
  if (typeof raw !== 'string') return []
  return raw
    .split('\u001e')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('u'))
}

/**
 * Interpret LINE's private ChatEvent localization keys observed in real group
 * traffic. Unknown keys remain explicit so new events never masquerade as a
 * decoded action.
 */
export function interpretChatEvent(
  message: any,
  names: Map<string, string>,
): string {
  const key =
    typeof message?.contentMetadata?.LOC_KEY === 'string'
      ? message.contentMetadata.LOC_KEY
      : ''
  const mids = chatEventParticipantMids(message)
  const name = (index: number) => names.get(mids[index]) || '一位成員'
  switch (key) {
    case 'C_GI':
      return mids.length >= 2
        ? `${name(0)} 邀請 ${name(1)} 加入群組`
        : '有人邀請成員加入群組'
    case 'C_MJ':
      return mids.length >= 1 ? `${name(0)} 加入群組` : '有成員加入群組'
    case 'C_ML':
      return mids.length >= 1 ? `${name(0)} 離開群組` : '有成員離開群組'
    default:
      return key ? `[聊天室活動：${key}]` : '[聊天室活動]'
  }
}
