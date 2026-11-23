/**
 * LINE official accounts (business accounts) — a different transport, not a
 * different recipient.
 *
 * A 1:1 chat MID is `u` + the peer's MID. A person's MID starts with `u`
 * (so their chat MID reads `uu…`), while an official account's MID starts
 * with `b` — its chat MID therefore reads `ub…`.
 *
 * The distinction matters because E2EE only exists between people and
 * groups. An official account has no E2EE peer key to negotiate, so the
 * normal "encrypt for the peer" path fails with "Failed to negotiate peer
 * E2EE public key" and the message never leaves Yomi. The official LINE
 * client sends to an official account in plain text over the normal talk
 * channel, which is what this module lets Yomi do as well.
 *
 * It is not a fallback for a failed encryption of a personal chat: this
 * predicate is about the target's type, decided before any send happens.
 */

/**
 * Whether a chat MID addresses a LINE official account.
 *
 * @param value - Chat MID to classify.
 * @returns True for `ub…` official-account chats.
 */
export function isOfficialAccountChatMid(value: string): boolean {
  return typeof value === 'string' && value.startsWith('ub')
}
