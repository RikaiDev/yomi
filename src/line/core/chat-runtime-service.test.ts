import { expect, test } from 'bun:test'
import { createChatRuntimeService } from './chat-runtime-service.js'

test('routes OpenChat read receipts to SquareService', async () => {
  const squareCalls: string[][] = []
  let talkCalls = 0
  const runtime = createChatRuntimeService({
    client: {
      markSquareChatRead: async (chatId: string, messageId: string) => {
        squareCalls.push([chatId, messageId])
      },
      sendChatChecked: async () => {
        talkCalls += 1
      },
    },
  })

  const result = await runtime.markChatRead('m-open-chat', 'message-9')

  expect(result).toEqual({
    marked: true,
    chatId: 'm-open-chat',
    lastMessageId: 'message-9',
  })
  expect(squareCalls).toEqual([['m-open-chat', 'message-9']])
  expect(talkCalls).toBe(0)
})

test('keeps ordinary chat read receipts on TalkService', async () => {
  let squareCalls = 0
  const talkCalls: string[][] = []
  const runtime = createChatRuntimeService({
    client: {
      markSquareChatRead: async () => {
        squareCalls += 1
      },
      sendChatChecked: async (chatId: string, messageId: string) => {
        talkCalls.push([chatId, messageId])
      },
    },
  })

  await runtime.markChatRead('c-group', 'message-3')

  expect(talkCalls).toEqual([['c-group', 'message-3']])
  expect(squareCalls).toBe(0)
})
