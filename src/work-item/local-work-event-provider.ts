import type { EventContext } from './event-context.js'
import {
  type FactorizedGraphModelOutput,
  type FactorizedWorkEventProvider,
  validateFactorizedGraphModelOutput,
} from './work-event-inference.js'
import {
  assertProductionEligibleModel,
  type WorkEventModelManifest,
} from './work-event-model-manifest.js'

export interface LocalGraphModelAdapter {
  readonly id: string
  generate(input: string): Promise<unknown>
}

export class LocalModelOutputError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Local work-event model output is invalid: ${reasons.join(', ')}`)
  }
}

export function serializeEventContextForModel(context: EventContext): string {
  const messages = context.messages.map((message, index) =>
    JSON.stringify({
      index,
      messageId: message.messageId,
      speaker: message.isSelf ? 'self' : 'other',
      sentAt: message.sentAt,
      text: message.text,
      mediaType: message.mediaType ?? null,
      mentionsSelf: message.mentionsSelf ?? false,
    }),
  )
  const edges = context.edges.map((edge) =>
    JSON.stringify({
      parentId: edge.parentId,
      childId: edge.childId,
      weight: edge.weight,
      entropy: edge.entropy,
    }),
  )
  return [
    JSON.stringify({
      schemaVersion: 1,
      chatId: context.chatId,
      anchorMessageIds: context.anchorMessageIds,
      complete: context.complete,
      boundary: context.boundary,
    }),
    ...messages,
    'EDGES',
    ...edges,
  ].join('\n')
}

export class LocalFactorizedWorkEventProvider
  implements FactorizedWorkEventProvider
{
  readonly id: string

  constructor(
    private readonly adapter: LocalGraphModelAdapter,
    manifest: WorkEventModelManifest,
  ) {
    assertProductionEligibleModel(manifest)
    if (manifest.modelId !== adapter.id)
      throw new Error('Model manifest does not match the local adapter')
    this.id = `local:${adapter.id}`
  }

  async infer(context: EventContext): Promise<FactorizedGraphModelOutput> {
    const raw = await this.adapter.generate(
      serializeEventContextForModel(context),
    )
    const reasons = validateFactorizedGraphModelOutput(raw)
    if (reasons.length > 0) throw new LocalModelOutputError(reasons)
    return { ...(raw as FactorizedGraphModelOutput), modelId: this.id }
  }
}
