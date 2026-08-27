import {
  cliCreateWorkItemDraftJson,
  cliWorkItemOperationJson,
} from './work-item.js'

test('CLI work-item bridge creates a draft without delivery', async () => {
  const draft = await cliCreateWorkItemDraftJson(
    {
      id: 'message-1',
      conversationId: 'chat-1',
      text: 'customer asks for a fix',
    },
    { id: 'work-cli', action: 'issue', now: 100 },
  )
  expect(draft).toMatchObject({
    id: 'work-cli',
    status: 'draft',
    action: 'issue',
  })
  expect(draft.evidence[0].text).toBe('customer asks for a fix')
  expect(draft.delivery).toBeNull()
})

test('CLI Work Item operations use the local provider and preserve state order', async () => {
  const created = await cliCreateWorkItemDraftJson(
    { id: 'message-2', conversationId: 'chat-1', text: 'review locally' },
    { id: 'work-ops', now: 100 },
  )
  const preview = await cliWorkItemOperationJson('preview', created)
  const approved = await cliWorkItemOperationJson('approve', preview)
  const reviewed = await cliWorkItemOperationJson('local-review', approved)
  expect(reviewed.status).toBe('delivered')
  expect(reviewed.delivery?.external).toBe(false)
})
