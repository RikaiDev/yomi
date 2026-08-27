import type { EventContext } from './event-context.js'
import {
  reviseWorkEvent,
  type WorkEventInference,
  type WorkEventRevision,
} from './work-event.js'
import {
  type FactorizedGraphInferenceResult,
  type FactorizedGraphModelOutput,
  type FactorizedWorkEventProvider,
  type InferenceThresholds,
  projectFactorizedGraphInference,
} from './work-event-inference.js'
import { matchWorkEventRevisions } from './work-event-matcher.js'

export interface WorkEventRevisionSink {
  appendMany(revisions: WorkEventRevision[]): Promise<void>
}

export interface WorkEventGraphUpdate {
  projection: FactorizedGraphInferenceResult
  revisions: WorkEventRevision[]
}

export class WorkEventGraphEngine {
  private latest = new Map<string, WorkEventRevision>()

  constructor(
    private readonly provider: FactorizedWorkEventProvider,
    private readonly sink: WorkEventRevisionSink,
    initial: WorkEventRevision[] = [],
  ) {
    for (const revision of initial) this.latest.set(revision.eventId, revision)
  }

  async observe(
    context: EventContext,
    thresholds?: InferenceThresholds,
    inferredAt = Date.now(),
  ): Promise<WorkEventGraphUpdate> {
    let output: FactorizedGraphModelOutput
    try {
      output = await this.provider.infer(context)
    } catch {
      return {
        projection: {
          dialogue: [],
          candidates: [
            {
              candidateKey: '',
              result: {
                kind: 'abstain',
                reasons: ['provider_inference_failed'],
                modelId: this.provider.id,
              },
            },
          ],
          modelId: this.provider.id,
        },
        revisions: [],
      }
    }
    const projection = projectFactorizedGraphInference(
      context,
      output,
      thresholds,
      inferredAt,
    )
    const incoming = projection.candidates.flatMap((candidate) =>
      candidate.result.kind === 'inference' ? [candidate.result.inference] : [],
    )
    const previous = [...this.latest.values()].filter(
      (revision) => revision.chatId === context.chatId,
    )
    const matches = matchWorkEventRevisions(previous, incoming)
    const previousByIncoming = new Map(
      matches.map((match) => [
        match.incomingIndex,
        previous[match.previousIndex],
      ]),
    )
    const revisions = incoming.map((inference, index) => {
      const prior = previousByIncoming.get(index) ?? null
      const stableInference: WorkEventInference = prior
        ? { ...inference, eventId: prior.eventId }
        : inference
      return reviseWorkEvent(prior, stableInference)
    })
    if (revisions.length > 0) {
      await this.sink.appendMany(revisions)
      for (const revision of revisions)
        this.latest.set(revision.eventId, revision)
    }
    return { projection, revisions }
  }

  current(): WorkEventRevision[] {
    return [...this.latest.values()].sort(
      (left, right) => right.inferredAt - left.inferredAt,
    )
  }
}
