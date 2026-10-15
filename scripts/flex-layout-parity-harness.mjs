#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processFlexMessage } from '../dist/line/core/flex-message.js'
import { resolveImagemapImageUrl } from '../dist/line/core/flex-message.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixture = JSON.parse(readFileSync(resolve(root, 'scripts/fixtures/flex-gift-carousel.json'), 'utf8'))
const document = processFlexMessage({ contentMetadata: { FLEX_JSON: JSON.stringify(fixture) } })
const fail = (message) => {
  console.error(`[flex:parity] ${message}`)
  process.exit(1)
}

if (!document || document.layoutVersion !== 1 || !/^[0-9a-f]{64}$/.test(document.layoutFingerprint)) {
  fail('shared layout version/fingerprint is missing')
}
if (
  resolveImagemapImageUrl(
    'https://vos.line-scdn.net/img-bucket-real/images/fixture',
    1040,
  ) !== 'https://vos.line-scdn.net/img-bucket-real/images/fixture/700'
) fail('imagemap base URL did not resolve to a fetchable density variant')

let nodeCount = 0
const nodeTypes = new Set()
let gradientCount = 0
let separatorCount = 0
let absoluteCount = 0
const walk = (node) => {
  if (!node) return
  nodeCount += 1
  nodeTypes.add(node.type)
  if (node.background?.type === 'linearGradient') gradientCount += 1
  if (node.separator) separatorCount += 1
  if (node.resolved?.position === 'absolute') absoluteCount += 1
  const resolved = node.resolved
  for (const key of [
    'spacing', 'paddingTop', 'paddingEnd', 'paddingBottom', 'paddingStart',
    'marginBefore', 'fontSize', 'fontWeight', 'aspectRatio', 'contentMode',
    'buttonStyle', 'buttonHeight', 'cornerRadius', 'borderWidth',
    'flexGrow', 'position', 'offsetTop', 'offsetBottom', 'offsetStart', 'offsetEnd',
    'widthPoints', 'widthFraction', 'maxWidthPoints', 'maxWidthFraction',
    'heightPoints', 'heightFraction', 'maxHeightPoints', 'maxHeightFraction',
  ]) {
    if (resolved?.[key] === undefined) fail(`node ${node.type} lacks resolved.${key}`)
  }
  for (const child of node.children || []) walk(child)
}
walk(document.root)
if (nodeCount < 18) fail(`fixture normalized only ${nodeCount} nodes`)
for (const type of ['span', 'icon', 'video', 'image']) {
  if (!nodeTypes.has(type)) fail(`fixture lost ${type} components`)
}
if (gradientCount !== 1) fail(`fixture normalized ${gradientCount} gradients`)
if (separatorCount !== 1) fail(`fixture normalized ${separatorCount} block separators`)
if (absoluteCount !== 1) fail(`fixture normalized ${absoluteCount} absolute nodes`)

const mac = readFileSync(resolve(root, 'desktop/mac-native/Features/Media/FlexMessageView.swift'), 'utf8')
const windows = readFileSync(resolve(root, 'desktop/src/popover/view.js'), 'utf8')
for (const [macToken, windowsToken] of [
  ['resolved.fontSize', 'resolved.fontSize'],
  ['resolved.spacing', 'r.spacing'],
  ['resolved.aspectRatio', 'resolved.aspectRatio'],
  ['resolved.buttonStyle', 'resolved.buttonStyle'],
  ['resolved.flexGrow', 'r.flexGrow'],
  ['resolved.axis', 'r.axis'],
  ['resolved.widthFraction', 'r.widthFraction'],
]) {
  if (!mac.includes(macToken)) fail(`macOS adapter does not consume ${macToken}`)
  if (!windows.includes(windowsToken)) fail(`Windows adapter does not consume ${windowsToken}`)
}
for (const forbidden of ['flexFontSize(', 'parseRatio(', 'flexLength(']) {
  if (windows.includes(forbidden)) fail(`Windows reintroduced local resolver ${forbidden}`)
}
if (!mac.includes('document.layoutFingerprint') || !windows.includes('data-layout-fingerprint')) {
  fail('platform output fingerprint is not observable')
}

console.log(`[flex:parity] v${document.layoutVersion} ${document.layoutFingerprint} nodes=${nodeCount}`)
