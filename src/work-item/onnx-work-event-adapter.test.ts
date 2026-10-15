import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import type { EventContext } from './event-context.js'
import { serializeEventContextForModel } from './local-work-event-provider.js'
import { OnnxWorkEventAdapter } from './onnx-work-event-adapter.js'

const MODEL_DIR = './research/models/student-a100-v1'

// The student model is a local experiment artifact, not a distributed one:
// `research/` is untracked and the model is not production eligible. The test
// runs wherever the weights are present and skips elsewhere, so a fresh clone
// stays green instead of failing on a missing download.
const hasWeights =
  existsSync(`${MODEL_DIR}/config.json`) &&
  existsSync(`${MODEL_DIR}/onnx/model.onnx`)

describe('OnnxWorkEventAdapter', () => {
  it.skipIf(!hasWeights)(
    'runs local ONNX inference on a work-request context',
    async () => {
      const adapter = new OnnxWorkEventAdapter()
      const context: EventContext = {
        schemaVersion: 1,
        chatId: 'c123',
        anchorMessageIds: ['m1'],
        complete: true,
        boundary: 'head',
        messages: [
          {
            messageId: 'm1',
            senderId: 'u1',
            sentAt: 1000,
            text: '請幫我確認 VPN 連線是否正常',
            isSelf: true,
          },
        ],
        edges: [],
      }

      const output = await adapter.generate(
        serializeEventContextForModel(context),
      )
      expect(output.modelId).toBe('onnx-student-a100-v1')
      expect(output.candidates.length).toBe(1)
      expect(output.candidates[0].candidateKey).toBe('m1')
      expect(output.candidates[0].createsWork.value).toBe(true)
      expect(output.candidates[0].createsWork.confidence).toBeGreaterThan(0.5)
      expect(output.candidates[0].ownership.value.state).toBe('unassigned')
    },
  )
})
