import { createHash } from 'node:crypto'

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

export interface FlexMessageGradient {
  type: 'linearGradient'
  angle: number
  startColor: string
  centerColor: string | null
  endColor: string
  centerPosition: number | null
}

export interface FlexMessageNode {
  type: string
  block: 'header' | 'hero' | 'body' | 'footer' | null
  layout: string | null
  text: string | null
  url: string | null
  color: string | null
  backgroundColor: string | null
  background: FlexMessageGradient | null
  size: string | null
  weight: string | null
  wrap: boolean | null
  margin: string | null
  spacing: string | null
  paddingAll: string | null
  paddingTop: string | null
  paddingBottom: string | null
  paddingStart: string | null
  paddingEnd: string | null
  style: string | null
  height: string | null
  width: string | null
  maxWidth: string | null
  maxHeight: string | null
  justifyContent: string | null
  alignItems: string | null
  cornerRadius: string | null
  borderColor: string | null
  borderWidth: string | null
  separator: boolean
  separatorColor: string | null
  maxLines: number | null
  decoration: string | null
  position: string | null
  offsetTop: string | null
  offsetBottom: string | null
  offsetStart: string | null
  offsetEnd: string | null
  resolved: FlexResolvedStyle
  aspectRatio: string | null
  aspectMode: 'fit' | 'cover' | null
  align: string | null
  gravity: string | null
  flex: number | null
  action: FlexMessageAction | null
  children: FlexMessageNode[]
}

export interface FlexMessageDocument {
  version: 1
  layoutVersion: 1
  layoutFingerprint: string
  kind: 'imagemap' | 'flex'
  altText: string
  width: number | null
  height: number | null
  imageUrl: string | null
  regions: FlexMessageRegion[]
  root: FlexMessageNode | null
}

function flexLayoutFingerprint(root: FlexMessageNode | null): string {
  return createHash('sha256').update(JSON.stringify(root)).digest('hex')
}

const FLEX_METRIC: Record<string, number> = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
}

function resolveMetric(value: unknown, fallback = 0): number {
  if (typeof value !== 'string') return fallback
  if (/^\d+(\.\d+)?px$/.test(value)) return Number(value.slice(0, -2))
  return FLEX_METRIC[value] ?? fallback
}

function resolveOptionalMetric(value: unknown): number | null {
  return typeof value === 'string' ? resolveMetric(value) : null
}

function resolveDimension(value: unknown): {
  points: number | null
  fraction: number | null
} {
  if (typeof value !== 'string') return { points: null, fraction: null }
  if (/^\d+(\.\d+)?px$/.test(value))
    return { points: Number(value.slice(0, -2)), fraction: null }
  if (/^\d+(\.\d+)?%$/.test(value))
    return { points: null, fraction: Number(value.slice(0, -1)) / 100 }
  return { points: null, fraction: null }
}

function resolveFontSize(value: unknown): number {
  if (typeof value === 'string' && /^\d+(\.\d+)?px$/.test(value))
    return Number(value.slice(0, -2))
  const sizes: Record<string, number> = {
    xxs: 10,
    xs: 11,
    sm: 12,
    md: 13,
    lg: 15,
    xl: 18,
    xxl: 22,
    '3xl': 26,
    '4xl': 30,
    '5xl': 34,
  }
  return sizes[typeof value === 'string' ? value : 'md'] ?? 13
}

function resolveAspectRatio(value: unknown): number {
  if (typeof value !== 'string') return 1
  const [width, height] = value.split(':').map(Number)
  return width > 0 && height > 0 ? width / height : 1
}

function normalizeGradient(value: unknown): FlexMessageGradient | null {
  const raw = parseObject(value)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const gradient = raw as Record<string, unknown>
  if (
    gradient.type !== 'linearGradient' ||
    typeof gradient.startColor !== 'string' ||
    typeof gradient.endColor !== 'string'
  )
    return null
  const angle =
    typeof gradient.angle === 'string'
      ? Number(gradient.angle.replace(/deg$/, ''))
      : 0
  const centerPosition =
    typeof gradient.centerPosition === 'string'
      ? Number(gradient.centerPosition.replace(/%$/, '')) / 100
      : null
  return {
    type: 'linearGradient',
    angle: Number.isFinite(angle) ? angle : 0,
    startColor: gradient.startColor,
    centerColor:
      typeof gradient.centerColor === 'string' ? gradient.centerColor : null,
    endColor: gradient.endColor,
    centerPosition:
      centerPosition !== null && Number.isFinite(centerPosition)
        ? centerPosition
        : null,
  }
}

function resolveFlexStyle(node: Record<string, any>): FlexResolvedStyle {
  const all = resolveMetric(node.paddingAll)
  const width = resolveDimension(node.width)
  const maxWidth = resolveDimension(node.maxWidth)
  const height = resolveDimension(node.height)
  const maxHeight = resolveDimension(node.maxHeight)
  return {
    axis: ['horizontal', 'vertical', 'baseline'].includes(node.layout)
      ? node.layout
      : null,
    spacing: resolveMetric(node.spacing, 8),
    paddingTop: resolveMetric(node.paddingTop, all),
    paddingEnd: resolveMetric(node.paddingEnd, all),
    paddingBottom: resolveMetric(node.paddingBottom, all),
    paddingStart: resolveMetric(node.paddingStart, all),
    marginBefore: resolveMetric(node.margin),
    fontSize: resolveFontSize(node.size),
    fontWeight: node.weight === 'bold' ? 700 : 400,
    lineLimit: Number.isFinite(node.maxLines)
      ? Number(node.maxLines)
      : node.wrap === true
        ? null
        : 1,
    aspectRatio: resolveAspectRatio(node.aspectRatio),
    contentMode: node.aspectMode === 'cover' ? 'cover' : 'fit',
    buttonStyle:
      node.style === 'primary' || node.style === 'secondary'
        ? node.style
        : 'link',
    buttonHeight: node.height === 'sm' ? 34 : 40,
    cornerRadius: resolveMetric(node.cornerRadius),
    borderWidth: resolveMetric(node.borderWidth),
    flexGrow: Number.isFinite(node.flex) ? Math.max(0, Number(node.flex)) : 0,
    position: node.position === 'absolute' ? 'absolute' : 'relative',
    offsetTop: resolveOptionalMetric(node.offsetTop),
    offsetBottom: resolveOptionalMetric(node.offsetBottom),
    offsetStart: resolveOptionalMetric(node.offsetStart),
    offsetEnd: resolveOptionalMetric(node.offsetEnd),
    widthPoints: width.points,
    widthFraction: width.fraction,
    maxWidthPoints: maxWidth.points,
    maxWidthFraction: maxWidth.fraction,
    heightPoints: height.points,
    heightFraction: height.fraction,
    maxHeightPoints: maxHeight.points,
    maxHeightFraction: maxHeight.fraction,
  }
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

export function resolveImagemapImageUrl(
  rawUrl: unknown,
  _canvasWidth: unknown,
  targetPixelWidth = 640,
): string | null {
  const base = webUrl(rawUrl)
  if (!base) return null
  const supported = [240, 300, 460, 700, 1040]
  const requested = Math.max(1, targetPixelWidth)
  const width =
    supported.find((candidate) => candidate >= requested) ??
    supported[supported.length - 1]
  const url = new URL(base)
  if (!url.pathname.endsWith(`/${width}`)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${width}`
  }
  return url.toString()
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

function normalizeFlexNode(
  raw: unknown,
  depth = 0,
  block: FlexMessageNode['block'] = null,
  blockStyle: unknown = null,
): FlexMessageNode | null {
  if (depth > 24) return null
  const parsed = parseObject(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const node = parsed as Record<string, any>
  const nodeType = String(node.type ?? 'box').toLowerCase()
  const parsedBlockStyle = parseObject(blockStyle)
  const inherited =
    parsedBlockStyle &&
    typeof parsedBlockStyle === 'object' &&
    !Array.isArray(parsedBlockStyle)
      ? (parsedBlockStyle as Record<string, any>)
      : {}
  const childValues: Array<[unknown, FlexMessageNode['block'], unknown]> =
    Array.isArray(node.contents)
      ? node.contents.map((child: unknown) => [child, null, null])
      : (['header', 'hero', 'body', 'footer'] as const)
          .filter((key) => Boolean(node[key]))
          .map((key) => [node[key], key, node.styles?.[key]])
  if (node.altContent) childValues.push([node.altContent, null, null])
  return {
    type: nodeType,
    block,
    layout: typeof node.layout === 'string' ? node.layout : null,
    text: typeof node.text === 'string' ? node.text : null,
    url: webUrl(node.url) || webUrl(node.previewUrl),
    color: typeof node.color === 'string' ? node.color : null,
    backgroundColor:
      typeof node.backgroundColor === 'string'
        ? node.backgroundColor
        : typeof inherited.backgroundColor === 'string'
          ? inherited.backgroundColor
          : nodeType === 'bubble'
            ? '#FFFFFF'
            : null,
    background: normalizeGradient(node.background),
    size: typeof node.size === 'string' ? node.size : null,
    weight: typeof node.weight === 'string' ? node.weight : null,
    wrap: typeof node.wrap === 'boolean' ? node.wrap : null,
    margin: typeof node.margin === 'string' ? node.margin : null,
    spacing: typeof node.spacing === 'string' ? node.spacing : null,
    paddingAll: typeof node.paddingAll === 'string' ? node.paddingAll : null,
    paddingTop: typeof node.paddingTop === 'string' ? node.paddingTop : null,
    paddingBottom:
      typeof node.paddingBottom === 'string' ? node.paddingBottom : null,
    paddingStart:
      typeof node.paddingStart === 'string' ? node.paddingStart : null,
    paddingEnd: typeof node.paddingEnd === 'string' ? node.paddingEnd : null,
    style: typeof node.style === 'string' ? node.style : null,
    height: typeof node.height === 'string' ? node.height : null,
    width: typeof node.width === 'string' ? node.width : null,
    maxWidth: typeof node.maxWidth === 'string' ? node.maxWidth : null,
    maxHeight: typeof node.maxHeight === 'string' ? node.maxHeight : null,
    justifyContent:
      typeof node.justifyContent === 'string' ? node.justifyContent : null,
    alignItems: typeof node.alignItems === 'string' ? node.alignItems : null,
    cornerRadius:
      typeof node.cornerRadius === 'string' ? node.cornerRadius : null,
    borderColor: typeof node.borderColor === 'string' ? node.borderColor : null,
    borderWidth: typeof node.borderWidth === 'string' ? node.borderWidth : null,
    separator: inherited.separator === true,
    separatorColor:
      typeof inherited.separatorColor === 'string'
        ? inherited.separatorColor
        : null,
    maxLines: Number.isFinite(node.maxLines) ? Number(node.maxLines) : null,
    decoration: typeof node.decoration === 'string' ? node.decoration : null,
    position: typeof node.position === 'string' ? node.position : null,
    offsetTop: typeof node.offsetTop === 'string' ? node.offsetTop : null,
    offsetBottom:
      typeof node.offsetBottom === 'string' ? node.offsetBottom : null,
    offsetStart: typeof node.offsetStart === 'string' ? node.offsetStart : null,
    offsetEnd: typeof node.offsetEnd === 'string' ? node.offsetEnd : null,
    resolved: resolveFlexStyle(node),
    aspectRatio: typeof node.aspectRatio === 'string' ? node.aspectRatio : null,
    aspectMode:
      node.aspectMode === 'fit' || node.aspectMode === 'cover'
        ? node.aspectMode
        : null,
    align: typeof node.align === 'string' ? node.align : null,
    gravity: typeof node.gravity === 'string' ? node.gravity : null,
    flex: Number.isFinite(node.flex) ? Number(node.flex) : null,
    action: flexAction(node.action),
    children: childValues
      .map(([child, childBlock, childStyle]) =>
        normalizeFlexNode(child, depth + 1, childBlock, childStyle),
      )
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
        layoutVersion: 1,
        layoutFingerprint: flexLayoutFingerprint(null),
        kind: 'imagemap',
        altText: explicitAlt,
        width: Number(canvas.width) || null,
        height: Number(canvas.height) || null,
        imageUrl: resolveImagemapImageUrl(metadata.DOWNLOAD_URL, canvas.width),
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
        layoutVersion: 1,
        layoutFingerprint: flexLayoutFingerprint(root),
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
        layoutVersion: 1,
        layoutFingerprint: flexLayoutFingerprint(root),
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
export interface FlexResolvedStyle {
  axis: 'horizontal' | 'vertical' | 'baseline' | null
  spacing: number
  paddingTop: number
  paddingEnd: number
  paddingBottom: number
  paddingStart: number
  marginBefore: number
  fontSize: number
  fontWeight: 400 | 700
  lineLimit: number | null
  aspectRatio: number
  contentMode: 'fit' | 'cover'
  buttonStyle: 'primary' | 'secondary' | 'link'
  buttonHeight: number
  cornerRadius: number
  borderWidth: number
  flexGrow: number
  position: 'relative' | 'absolute'
  offsetTop: number | null
  offsetBottom: number | null
  offsetStart: number | null
  offsetEnd: number | null
  widthPoints: number | null
  widthFraction: number | null
  maxWidthPoints: number | null
  maxWidthFraction: number | null
  heightPoints: number | null
  heightFraction: number | null
  maxHeightPoints: number | null
  maxHeightFraction: number | null
}
