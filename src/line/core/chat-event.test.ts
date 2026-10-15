import { expect, test } from 'bun:test'
import { chatEventParticipantMids, interpretChatEvent } from './chat-event.js'

const inviter = 'u-inviter'
const member = 'u-member'
const names = new Map([
  [inviter, '小明'],
  [member, '小美'],
])

test('decodes an invite followed by member join without exposing MID', () => {
  const invite = {
    contentType: 18,
    contentMetadata: { LOC_KEY: 'C_GI', LOC_ARGS: `${inviter}\u001e${member}` },
  }
  const joined = {
    contentType: 18,
    contentMetadata: { LOC_KEY: 'C_MJ', LOC_ARGS: member },
  }
  expect(chatEventParticipantMids(invite)).toEqual([inviter, member])
  expect(interpretChatEvent(invite, names)).toBe('小明 邀請 小美 加入群組')
  expect(interpretChatEvent(joined, names)).toBe('小美 加入群組')
})

test('keeps unknown private event keys explicit', () => {
  expect(
    interpretChatEvent(
      { contentType: 18, contentMetadata: { LOC_KEY: 'C_NEW' } },
      names,
    ),
  ).toBe('[聊天室活動：C_NEW]')
})

test('decodes a member leaving the group', () => {
  expect(
    interpretChatEvent(
      {
        contentType: 18,
        contentMetadata: { LOC_KEY: 'C_ML', LOC_ARGS: member },
      },
      names,
    ),
  ).toBe('小美 離開群組')
})
