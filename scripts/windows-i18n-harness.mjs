#!/usr/bin/env node
/** Static i18n and parity gate for the Windows WebView surface. */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const html = readFileSync(join(root, 'desktop/src/popover/view.html'), 'utf8')
const css = readFileSync(join(root, 'desktop/src/popover/view.css'), 'utf8')
const js = readFileSync(join(root, 'desktop/src/popover/view.js'), 'utf8')
const rust = readFileSync(join(root, 'desktop/src/popover/mod.rs'), 'utf8')
const source = `${html}\n${css}\n${js}\n${rust}`
const requiredKeys = ['attention', 'all_chats', 'ambient', 'settings', 'search']
const locales = ['zh-TW', 'en', 'ja']
function fail(message) {
  console.error(`[desktop:windows:i18n] ${message}`)
  process.exit(1)
}
for (const key of requiredKeys) {
  if ((!html.includes(`data-i18n="${key}"`) && key !== 'search') || !source.includes(`${key}:`)) {
    fail(`missing translated UI key: ${key}`)
  }
}
for (const locale of locales) {
  if (!source.includes(`${locale}:`) && !source.includes(`'${locale}':`) && !source.includes(`"${locale}":`)) fail(`missing locale table: ${locale}`)
}
const localeBlocks = locales.map((locale) => {
  const match = source.match(new RegExp(`(?:['"]${locale}['"]|${locale}):\\s*\\{([\\s\\S]*?)(?:\\},\\n|\\}\\};)`))
  return new Set((match?.[1].match(/\b([A-Za-z][A-Za-z0-9_]*)\s*:/g) ?? []).map((key) => key.replace(/\s*:.*/, '')))
})
const usedKeys = [...html.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)].map((match) => match[1])
for (const key of usedKeys) {
  if (localeBlocks.some((keys) => !keys.has(key))) fail(`key ${key} is not translated in every locale`)
}
const visible = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
for (const text of [...visible.matchAll(/>([^<>]+)</g)].map((match) => match[1].trim()).filter(Boolean)) {
  if (/^(Yomi|[↻⚙×＋▣☺♩←☷YM]|TW|JP|TH|ID|US|[0-9+ ]+)+$/.test(text)) continue
  if (!text.includes('data-i18n') && !text.startsWith('${')) fail(`hardcoded visible UI text: ${text}`)
}
for (const command of [
  'chats', 'messages', 'send-message', 'send-image', 'send-file',
  'send-audio',
  'media-preview', 'rich-menu', 'list-stickers', 'sticker-previews',
  'send-sticker', 'mark-read', 'set-chat-muted', 'ambient-observe',
]) {
  if (!source.includes(`'${command}'`) && !source.includes(`"${command}"`)) fail(`missing Windows bridge operation: ${command}`)
}
if ((!source.includes('open_url:')) || (!source.includes('login_start:'))) {
  fail('missing safe URL or passwordless login bridge')
}
console.log('[desktop:windows:i18n] locale, action, and shared-core parity checks passed')
