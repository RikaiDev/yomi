import { expect, test } from 'bun:test'
import type { EventContext } from './event-context.js'
import {
  LocalFactorizedWorkEventProvider,
  LocalModelOutputError,
} from './local-work-event-provider.js'
import type { WorkEventModelManifest } from './work-event-model-manifest.js'

const digest = 'a'.repeat(64)
function manifest(modelId: string): WorkEventModelManifest {
  const passed = { passed: true, reportSha256: digest }
  return {
    schemaVersion: 1,
    modelId,
    artifactSha256: digest,
    quantization: 'Q4_K_M',
    sourceModel: 'fixture-source',
    datasetRevision: digest,
    conversationSplit: passed,
    factorizedCoverage: passed,
    publicAcceptance: passed,
    privateAcceptance: passed,
    quantizationValidation: passed,
    targetHardwareBenchmark: passed,
    modelOwnerApproved: true,
  }
}

const context: EventContext = {
  schemaVersion: 1,
  chatId: 'chat',
  anchorMessageIds: ['m2'],
  complete: true,
  boundary: 'graph_boundary',
  messages: [
    {
      messageId: 'm1',
      chatId: 'chat',
      senderName: 'A',
      sentAt: 1,
      text: 'first',
      isSelf: false,
    },
    {
      messageId: 'm2',
      chatId: 'chat',
      senderName: 'Me',
      sentAt: 2,
      text: 'second',
      isSelf: true,
    },
  ],
  edges: [
    {
      parentId: 'm1',
      childId: 'm2',
      weight: 0.8,
      entropy: 0.2,
      reasons: ['local_turn_exchange'],
    },
  ],
}

test('adapter receives graph context rather than a fixed neighboring slice', async () => {
  let received = ''
  const adapter = {
    id: 'fixture',
    async generate(input) {
      received = input
      return { modelId: 'ignored', dialogue: [], candidates: [] }
    },
  }
  const provider = new LocalFactorizedWorkEventProvider(
    adapter,
    manifest(adapter.id),
  )
  const output = await provider.infer(context)
  expect(received).toContain('"anchorMessageIds":["m2"]')
  expect(received).toContain('"parentId":"m1"')
  expect(received).toContain('"messageId":"m1"')
  expect(received).toContain('"messageId":"m2"')
  expect(output.modelId).toBe('local:fixture')
})

test('invalid adapter JSON is rejected before projection', async () => {
  const adapter = {
    id: 'broken',
    async generate() {
      return { candidates: 'wrong' }
    },
  }
  const provider = new LocalFactorizedWorkEventProvider(
    adapter,
    manifest(adapter.id),
  )
  await expect(provider.infer(context)).rejects.toBeInstanceOf(
    LocalModelOutputError,
  )
})

test('provider construction fails closed without independent acceptance', () => {
  const adapter = {
    id: 'blocked',
    async generate() {
      return {}
    },
  }
  expect(
    () =>
      new LocalFactorizedWorkEventProvider(adapter, {
        ...manifest(adapter.id),
        publicAcceptance: { passed: false, reportSha256: digest },
      }),
  ).toThrow('publicAcceptance_not_passed')
})
