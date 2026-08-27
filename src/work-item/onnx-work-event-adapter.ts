import { AutoModel, AutoTokenizer } from '@huggingface/transformers'
import type { LocalGraphModelAdapter } from './local-work-event-provider.js'
import type { FactorizedGraphModelOutput } from './work-event-inference.js'

const ACTS = [
  'inform',
  'ask',
  'answer',
  'directive',
  'commit',
  'delegate',
  'acknowledge',
  'deliver',
  'accept',
  'reject',
  'cancel',
]
const OWNER_STATES = ['unassigned', 'owned', 'delegated', 'unknown']
const DEPENDENCIES = [
  'none',
  'waiting_person',
  'waiting_external_system',
  'waiting_decision',
  'unknown',
]
const LIFECYCLES = [
  'proposed',
  'committed',
  'in_progress',
  'blocked',
  'delivered',
  'accepted',
  'cancelled',
  'resolved',
  'uncertain',
]

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits)
  const exp = logits.map((val) => Math.exp(val - max))
  const sum = exp.reduce((acc, val) => acc + val, 0)
  return exp.map((val) => val / sum)
}

function argmax(values: number[]): number {
  let bestIdx = 0
  let bestVal = values[0]
  for (let i = 1; i < values.length; i++) {
    if (values[i] > bestVal) {
      bestVal = values[i]
      bestIdx = i
    }
  }
  return bestIdx
}

export class OnnxWorkEventAdapter implements LocalGraphModelAdapter {
  readonly id: string
  private tokenizer: any = null
  private model: any = null
  private loadPromise: Promise<void> | null = null

  constructor(
    private readonly modelDir: string = './research/models/student-a100-v1',
    id = 'onnx-student-a100-v1',
  ) {
    this.id = id
  }

  private async ensureLoaded(): Promise<void> {
    if (this.model && this.tokenizer) return
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        this.tokenizer = await AutoTokenizer.from_pretrained(this.modelDir)
        this.model = await AutoModel.from_pretrained(this.modelDir, {
          local_files_only: true,
        })
      })()
    }
    await this.loadPromise
  }

  async generate(serializedInput: string): Promise<FactorizedGraphModelOutput> {
    await this.ensureLoaded()

    // Extract target message and context from serializedInput
    const lines = serializedInput.split('\n')
    const messages: Array<{
      index: number
      messageId: string
      speaker: string
      sentAt: number
      text: string | null
      mediaType: string | null
    }> = []

    for (const line of lines) {
      if (line === 'EDGES' || !line.trim()) break
      try {
        const parsed = JSON.parse(line)
        if (typeof parsed.index === 'number' && parsed.messageId) {
          messages.push(parsed)
        }
      } catch {
        // Skip header or non-message lines
      }
    }

    if (messages.length === 0) {
      return {
        dialogue: [],
        candidates: [],
        modelId: this.id,
      }
    }

    const targetMsg = messages[messages.length - 1]
    const turns = messages.map((m, idx) => {
      const marker = idx === messages.length - 1 ? 'TARGET' : 'CONTEXT'
      const text = m.text || (m.mediaType ? `[${m.mediaType}]` : '')
      return `[${marker} speaker=${m.speaker}] ${text}`
    })
    const prompt = turns.join('\n')

    const inputs = await this.tokenizer(prompt)
    const outputs = await this.model(inputs)

    // Parse creates_work
    const createsWorkLogit = Number(outputs.creates_work.data[0])
    const createsWorkConf = sigmoid(createsWorkLogit)
    const createsWork = createsWorkConf >= 0.5

    // Parse dialogue acts
    const dialogueActsLogits = Array.from(outputs.dialogue.data) as number[]
    const detectedActs: string[] = []
    let maxActIdx = 0
    let maxActVal = -Infinity
    for (let i = 0; i < dialogueActsLogits.length; i++) {
      const conf = sigmoid(dialogueActsLogits[i])
      if (conf >= 0.5) detectedActs.push(ACTS[i])
      if (dialogueActsLogits[i] > maxActVal) {
        maxActVal = dialogueActsLogits[i]
        maxActIdx = i
      }
    }
    if (detectedActs.length === 0) detectedActs.push(ACTS[maxActIdx])

    // Parse ownership
    const ownershipLogits = Array.from(outputs.ownership.data) as number[]
    const ownershipProbs = softmax(ownershipLogits)
    const ownIdx = argmax(ownershipProbs)
    const ownState = OWNER_STATES[ownIdx]
    const ownConfidence = ownershipProbs[ownIdx]
    const ownerKinds: Array<
      'self' | 'conversation_member' | 'external_party' | 'unknown'
    > =
      ownState === 'owned'
        ? [targetMsg.speaker === 'self' ? 'self' : 'conversation_member']
        : ownState === 'delegated'
          ? ['external_party']
          : ['unknown']

    // Parse dependency
    const dependencyLogits = Array.from(outputs.dependency.data) as number[]
    const dependencyProbs = softmax(dependencyLogits)
    const depIdx = argmax(dependencyProbs)
    const depState = DEPENDENCIES[depIdx]
    const depConfidence = dependencyProbs[depIdx]

    // Parse lifecycle
    const lifecycleLogits = Array.from(outputs.lifecycle.data) as number[]
    const lifecycleProbs = softmax(lifecycleLogits)
    const lifeIdx = argmax(lifecycleProbs)
    const lifeState = LIFECYCLES[lifeIdx]
    const lifeConfidence = lifecycleProbs[lifeIdx]

    // Parse completion
    const completionLogits = Array.from(outputs.completion.data) as number[]
    const delivered = sigmoid(completionLogits[0]) >= 0.5
    const accepted = sigmoid(completionLogits[1]) >= 0.5
    const cancelled = sigmoid(completionLogits[2]) >= 0.5

    const candidate = {
      candidateKey: targetMsg.messageId,
      createsWork: {
        value: createsWork,
        confidence: createsWork ? createsWorkConf : 1 - createsWorkConf,
        evidenceMessageIds: [targetMsg.messageId],
      },
      action: createsWork
        ? {
            predicate: 'handle',
            object: targetMsg.text?.slice(0, 40) ?? null,
            expectedOutcome: 'task completion',
            dueAt: null,
            sourceMessageIds: [targetMsg.messageId],
            confidence: createsWorkConf,
          }
        : null,
      ownership: {
        value: {
          state: ownState as any,
          owners: ownerKinds.map((k) => ({
            kind: k,
            stableId: null,
            displayName: null,
          })),
        },
        confidence: ownConfidence,
        evidenceMessageIds: [targetMsg.messageId],
      },
      dependency: {
        value: {
          state: depState as any,
          on: null,
        },
        confidence: depConfidence,
        evidenceMessageIds: [targetMsg.messageId],
      },
      lifecycle: {
        value: lifeState as any,
        confidence: lifeConfidence,
        evidenceMessageIds: [targetMsg.messageId],
      },
      completion: {
        value: {
          delivered,
          accepted,
          cancelled,
        },
        confidence: Math.max(
          sigmoid(completionLogits[0]),
          sigmoid(completionLogits[1]),
          sigmoid(completionLogits[2]),
        ),
        evidenceMessageIds: [targetMsg.messageId],
      },
    }

    return {
      dialogue: [
        {
          messageId: targetMsg.messageId,
          acts: detectedActs as any,
          confidence: sigmoid(maxActVal),
        },
      ],
      candidates: [candidate],
      modelId: this.id,
    }
  }
}
