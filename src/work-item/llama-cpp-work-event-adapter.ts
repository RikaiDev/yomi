import type { LocalGraphModelAdapter } from './local-work-event-provider.js'

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
const PARTICIPANT_KINDS = [
  'self',
  'conversation_member',
  'external_party',
  'unknown',
]
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

const evidenceField = {
  type: 'object',
  required: ['confidence', 'evidenceMessageIds'],
  properties: {
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidenceMessageIds: { type: 'array', items: { type: 'string' } },
  },
} as const

export const WORK_EVENT_GRAPH_JSON_SCHEMA = {
  type: 'object',
  required: ['dialogue', 'candidates'],
  properties: {
    dialogue: {
      type: 'array',
      items: {
        type: 'object',
        required: ['messageId', 'acts', 'confidence'],
        properties: {
          messageId: { type: 'string' },
          acts: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', enum: ACTS },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'candidateKey',
          'createsWork',
          'action',
          'ownership',
          'dependency',
          'lifecycle',
          'completion',
        ],
        properties: {
          candidateKey: { type: 'string' },
          createsWork: {
            ...evidenceField,
            required: ['value', 'confidence', 'evidenceMessageIds'],
            properties: {
              ...evidenceField.properties,
              value: { type: 'boolean' },
            },
          },
          action: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                required: [
                  'predicate',
                  'object',
                  'expectedOutcome',
                  'dueAt',
                  'sourceMessageIds',
                  'confidence',
                ],
                properties: {
                  predicate: { type: 'string' },
                  object: { type: ['string', 'null'] },
                  expectedOutcome: { type: ['string', 'null'] },
                  dueAt: { type: ['number', 'null'] },
                  sourceMessageIds: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string' },
                  },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                },
              },
            ],
          },
          ownership: {
            ...evidenceField,
            required: ['value', 'confidence', 'evidenceMessageIds'],
            properties: {
              ...evidenceField.properties,
              value: {
                type: 'object',
                required: ['state', 'owners'],
                properties: {
                  state: { type: 'string', enum: OWNER_STATES },
                  owners: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['kind', 'stableId', 'displayName'],
                      properties: {
                        kind: { type: 'string', enum: PARTICIPANT_KINDS },
                        stableId: { type: ['string', 'null'] },
                        displayName: { type: ['string', 'null'] },
                      },
                    },
                  },
                },
              },
            },
          },
          dependency: {
            ...evidenceField,
            required: ['value', 'confidence', 'evidenceMessageIds'],
            properties: {
              ...evidenceField.properties,
              value: {
                type: 'object',
                required: ['state', 'on'],
                properties: {
                  state: { type: 'string', enum: DEPENDENCIES },
                  on: { type: ['object', 'null'] },
                },
              },
            },
          },
          lifecycle: {
            ...evidenceField,
            required: ['value', 'confidence', 'evidenceMessageIds'],
            properties: {
              ...evidenceField.properties,
              value: { type: 'string', enum: LIFECYCLES },
            },
          },
          completion: {
            ...evidenceField,
            required: ['value', 'confidence', 'evidenceMessageIds'],
            properties: {
              ...evidenceField.properties,
              value: {
                type: 'object',
                required: ['delivered', 'accepted', 'cancelled'],
                properties: {
                  delivered: { type: 'boolean' },
                  accepted: { type: 'boolean' },
                  cancelled: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  },
} as const

const SYSTEM_PROMPT = `Infer a revisable work-event graph from the complete event context. Dialogue acts are message-level. Return zero or more distinct candidates; one message may cancel one action and propose another, so candidates may share evidence. Information and answers can create work. Acknowledgement is not acceptance. Never infer work from read state, names, or account identity. Action frames must cite source message IDs. If uncertain, use low confidence rather than inventing evidence.`

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export class LlamaCppWorkEventAdapter implements LocalGraphModelAdapter {
  readonly id: string
  private readonly endpoint: URL

  constructor(
    baseUrl: string,
    private readonly model: string,
    private readonly request: Fetcher = fetch,
    private readonly timeoutMs = 120_000,
  ) {
    const url = new URL(baseUrl)
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)
    ) {
      throw new Error('Work-event model endpoint must be loopback HTTP')
    }
    this.endpoint = new URL('/v1/chat/completions', url)
    this.id = `llama.cpp:${model}`
  }

  async generate(input: string): Promise<unknown> {
    const response = await this.request(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'work_event_graph',
            strict: true,
            schema: WORK_EVENT_GRAPH_JSON_SCHEMA,
          },
        },
        temperature: 0,
        max_tokens: 1800,
      }),
    })
    if (!response.ok)
      throw new Error(`Local model request failed (${response.status})`)
    const payload = (await response.json()) as any
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length > 1024 * 1024)
      throw new Error('Local model response is missing or oversized')
    const parsed = JSON.parse(content)
    return { ...parsed, modelId: this.id }
  }
}
