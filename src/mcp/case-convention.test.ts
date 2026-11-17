import { expect, test } from 'bun:test'
import {
  camelToSnake,
  snakeToCamel,
  toCamelCaseKeys,
  toSnakeCaseKeys,
} from './case-convention.js'

test('camelToSnake converts contract key spellings', () => {
  expect(camelToSnake('chatId')).toBe('chat_id')
  expect(camelToSnake('chatIds')).toBe('chat_ids')
  expect(camelToSnake('e2eeDecrypted')).toBe('e2ee_decrypted')
  expect(camelToSnake('textSampleSize')).toBe('text_sample_size')
  expect(camelToSnake('chat_id')).toBe('chat_id')
  expect(camelToSnake('mids')).toBe('mids')
})

test('snakeToCamel is the inverse and leaves single words alone', () => {
  expect(snakeToCamel('chat_id')).toBe('chatId')
  expect(snakeToCamel('subject_name')).toBe('subjectName')
  expect(snakeToCamel('per_chat')).toBe('perChat')
  expect(snakeToCamel('term')).toBe('term')
  expect(snakeToCamel('chatId')).toBe('chatId')
})

test('toSnakeCaseKeys rewrites keys at every depth and leaves values alone', () => {
  const payload = {
    chatId: 'u123',
    fromName: '林家薐',
    nested: { messageId: 'm1', list: [{ stickerId: 's1' }] },
    text: 'keep my chatId spelling in the body',
  }
  expect(toSnakeCaseKeys(payload)).toEqual({
    chat_id: 'u123',
    from_name: '林家薐',
    nested: { message_id: 'm1', list: [{ sticker_id: 's1' }] },
    text: 'keep my chatId spelling in the body',
  })
})

test('toCamelCaseKeys restores the internal spelling for handlers', () => {
  const args = {
    chat_id: 'u123',
    before: { message_id: 'm1', delivered_time: 5 },
    limit: 20,
  }
  expect(toCamelCaseKeys(args)).toEqual({
    chatId: 'u123',
    before: { messageId: 'm1', deliveredTime: 5 },
    limit: 20,
  })
})

test('toCamelCaseKeys tolerates a client that still sends camelCase', () => {
  const args = { chatId: 'u123', messageId: 'm1' }
  expect(toCamelCaseKeys(args)).toEqual({ chatId: 'u123', messageId: 'm1' })
})

test('conversion does not rewrite non-plain objects', () => {
  const when = new Date(0)
  expect(toSnakeCaseKeys({ createdTime: when })).toEqual({ created_time: when })
})
