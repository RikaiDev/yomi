import { expect, test } from 'bun:test'
import { LlamaCppWorkEventAdapter } from './llama-cpp-work-event-adapter.js'

test('adapter rejects endpoints that could exfiltrate conversation context', () => {
  expect(
    () => new LlamaCppWorkEventAdapter('https://models.example.com', 'student'),
  ).toThrow('loopback HTTP')
})

test('adapter sends strict graph JSON only to loopback', async () => {
  let endpoint = ''
  let body: any
  const adapter = new LlamaCppWorkEventAdapter(
    'http://127.0.0.1:8080',
    'student',
    async (input, init) => {
      endpoint = String(input)
      body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ dialogue: [], candidates: [] }),
              },
            },
          ],
        }),
        { status: 200 },
      )
    },
  )
  expect(await adapter.generate('complete graph context')).toEqual({
    modelId: 'llama.cpp:student',
    dialogue: [],
    candidates: [],
  })
  expect(endpoint).toBe('http://127.0.0.1:8080/v1/chat/completions')
  expect(body.messages[1].content).toBe('complete graph context')
  expect(body.response_format.type).toBe('json_schema')
})
