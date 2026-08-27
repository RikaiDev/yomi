export interface FlexMessageInterpretation {
  summary: string
  imageUrl: string | null
  actionUrl: string | null
  actionLabels: string[]
}

export interface FlexMessageAction {
  type: 'uri' | 'message' | 'postback' | 'unknown'
  label: string
  uri: string | null
  text: string | null
  data: string | null
}

export interface FlexMessageRegion {
  x: number
  y: number
  width: number
  height: number
  action: FlexMessageAction
}

export interface FlexMessageNode {
  type: string
  layout: string | null
  text: string | null
  url: string | null
  color: string | null
  backgroundColor: string | null
  size: string | null
  align: string | null
  gravity: string | null
  flex: number | null
  action: FlexMessageAction | null
  children: FlexMessageNode[]
}

export interface FlexMessageDocument {
  version: 1
  kind: 'imagemap' | 'flex'
  altText: string
  width: number | null
  height: number | null
  imageUrl: string | null
  regions: FlexMessageRegion[]
  root: FlexMessageNode | null
}

const FLEX_PAYLOAD_KEYS = [
  'FLEX_JSON',
  'FLEX_CONTENTS',
  'FLEX_MESSAGE',
  'CONTENTS',
  'MARKUP_JSON',
] as const

function parseObject(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function flexAction(raw: unknown): FlexMessageAction | null {
  const parsed = parseObject(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const record = parsed as Record<string, any>
  const params =
    record.params && typeof record.params === 'object' ? record.params : record
  const rawType = String(record.type ?? '').toLowerCase()
  const uri = webUrl(params.linkUri) || webUrl(record.uri)
  const text =
    typeof params.text === 'string'
      ? params.text
      : typeof record.text === 'string'
        ? record.text
        : null
  const label = String(
    record.label ?? record.text ?? params.displayText ?? '',
  ).trim()
  const data =
    typeof record.data === 'string'
      ? record.data
      : typeof params.data === 'string'
        ? params.data
        : null
  const type =
    rawType === 'web' || rawType === 'uri'
      ? 'uri'
      : rawType === 'message' || rawType === 'sendmessage'
        ? 'message'
        : rawType === 'postback'
          ? 'postback'
          : 'unknown'
  return { type, label, uri, text, data }
}

function normalizeFlexNode(raw: unknown, depth = 0): FlexMessageNode | null {
  if (depth > 24) return null
  const parsed = parseObject(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const node = parsed as Record<string, any>
  const childValues = Array.isArray(node.contents)
    ? node.contents
    : ['header', 'hero', 'body', 'footer']
        .map((key) => node[key])
        .filter(Boolean)
  return {
    type: String(node.type ?? 'box').toLowerCase(),
    layout: typeof node.layout === 'string' ? node.layout : null,
    text: typeof node.text === 'string' ? node.text : null,
    url: webUrl(node.url) || webUrl(node.previewUrl),
    color: typeof node.color === 'string' ? node.color : null,
    backgroundColor:
      typeof node.backgroundColor === 'string' ? node.backgroundColor : null,
    size: typeof node.size === 'string' ? node.size : null,
    align: typeof node.align === 'string' ? node.align : null,
    gravity: typeof node.gravity === 'string' ? node.gravity : null,
    flex: Number.isFinite(node.flex) ? Number(node.flex) : null,
    action: flexAction(node.action),
    children: childValues
      .map((child) => normalizeFlexNode(child, depth + 1))
      .filter((child): child is FlexMessageNode => Boolean(child)),
  }
}

export function processFlexMessage(message: any): FlexMessageDocument | null {
  const metadata =
    message?.contentMetadata && typeof message.contentMetadata === 'object'
      ? (message.contentMetadata as Record<string, unknown>)
      : {}
  const explicitAlt =
    typeof metadata.ALT_TEXT === 'string' ? metadata.ALT_TEXT : ''
  const markup = parseObject(metadata.MARKUP_JSON)
  if (markup && typeof markup === 'object' && !Array.isArray(markup)) {
    const record = markup as Record<string, any>
    const canvas = record.canvas
    const scene = record.scenes?.[canvas?.initialScene]
    if (canvas && scene && Array.isArray(scene.listeners)) {
      const regions = scene.listeners.flatMap((listener: any) => {
        const [x, y, width, height] = listener?.params ?? []
        const action = flexAction(record.actions?.[listener?.action])
        if (![x, y, width, height].every(Number.isFinite) || !action) return []
        return [{ x, y, width, height, action }]
      })
      return {
        version: 1,
        kind: 'imagemap',
        altText: explicitAlt,
        width: Number(canvas.width) || null,
        height: Number(canvas.height) || null,
        imageUrl: webUrl(metadata.DOWNLOAD_URL),
        regions,
        root: null,
      }
    }
  }
  for (const key of FLEX_PAYLOAD_KEYS) {
    if (key === 'MARKUP_JSON') continue
    const parsed = parseObject(metadata[key])
    if (!parsed) continue
    const root = normalizeFlexNode(parsed)
    if (root) {
      return {
        version: 1,
        kind: 'flex',
        altText: explicitAlt,
        width: null,
        height: null,
        imageUrl: null,
        regions: [],
        root,
      }
    }
  }
  const textPayload = parseObject(message?.text)
  const root = normalizeFlexNode(textPayload)
  return root
    ? {
        version: 1,
        kind: 'flex',
        altText: explicitAlt,
        width: null,
        height: null,
        imageUrl: null,
        regions: [],
        root,
      }
    : null
}

/** Interpret LINE bubble/carousel content in header→hero→body→footer order. */
export function interpretFlexPayload(
  payload: unknown,
): FlexMessageInterpretation {
  const texts: string[] = []
  const images: string[] = []
  const actions: Array<{ label: string; url: string | null }> = []
  const seen = new Set<unknown>()
  let visited = 0

  const addText = (value: unknown) => {
    if (typeof value !== 'string') return
    const clean = value.replace(/\s+/g, ' ').trim()
    if (clean && !texts.includes(clean)) texts.push(clean)
  }

  const walk = (raw: unknown, depth = 0) => {
    if (depth > 24 || visited >= 800) return
    const value = parseObject(raw)
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    visited += 1
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }

    const node = value as Record<string, unknown>
    const type = typeof node.type === 'string' ? node.type.toLowerCase() : ''
    if (type === 'text' || type === 'span') addText(node.text)
    if (type === 'image' || type === 'video') {
      const image = webUrl(node.url) || webUrl(node.previewUrl)
      if (image && !images.includes(image)) images.push(image)
    }

    const action = parseObject(node.action)
    if (action && typeof action === 'object' && !Array.isArray(action)) {
      const record = action as Record<string, unknown>
      const label =
        [record.label, record.displayText, record.text].find(
          (item): item is string =>
            typeof item === 'string' && item.trim().length > 0,
        ) ?? ''
      const url = webUrl(record.uri)
      if (label || url) actions.push({ label: label.trim(), url })
    }

    const ordered = [
      'header',
      'hero',
      'body',
      'footer',
      'contents',
      'altContent',
    ]
    for (const key of ordered) if (key in node) walk(node[key], depth + 1)
    for (const [key, child] of Object.entries(node)) {
      if (
        ordered.includes(key) ||
        ['action', 'type', 'text', 'url', 'previewUrl'].includes(key)
      )
        continue
      if (child && typeof child === 'object') walk(child, depth + 1)
    }
  }

  walk(payload)
  const machineLabels = new Set(['uri', 'url', 'link', 'open', 'action'])
  const actionLabels = actions.map((item) => item.label).filter(Boolean)
  const readableActionLabels = actionLabels.filter(
    (label) => !machineLabels.has(label.toLowerCase()),
  )
  const readable = [
    ...texts,
    ...readableActionLabels.filter((label) => !texts.includes(label)),
  ]
  return {
    summary: readable.join(' · ').slice(0, 700),
    imageUrl: images[0] ?? null,
    actionUrl: actions.find((item) => item.url)?.url ?? null,
    actionLabels,
  }
}

export function interpretFlexMessage(message: any): FlexMessageInterpretation {
  const metadata =
    message?.contentMetadata && typeof message.contentMetadata === 'object'
      ? (message.contentMetadata as Record<string, unknown>)
      : {}
  for (const key of FLEX_PAYLOAD_KEYS) {
    const parsed = parseObject(metadata[key])
    if (parsed) return interpretFlexPayload(parsed)
  }
  const textPayload = parseObject(message?.text)
  return textPayload
    ? interpretFlexPayload(textPayload)
    : {
        summary: '',
        imageUrl: null,
        actionUrl: null,
        actionLabels: [],
      }
}
