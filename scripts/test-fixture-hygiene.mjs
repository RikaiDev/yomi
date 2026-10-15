import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const roots = ['src', 'desktop', 'scripts']
const candidates = []
function walk(path) {
  for (const name of readdirSync(path)) {
    if (['node_modules', 'target', 'Yomi.app'].includes(name)) continue
    const child = join(path, name)
    if (statSync(child).isDirectory()) walk(child)
    else if (/test/i.test(name) && ['.ts', '.swift'].includes(extname(name))) candidates.push(child)
  }
}
for (const root of roots) walk(root)

const failures = []
for (const file of candidates) {
  const source = readFileSync(file, 'utf8')
  if (/\b[ucm][0-9a-f]{32}\b/i.test(source)) {
    failures.push(`${file}: probable real LINE identifier in test fixture`)
  }
  for (const [index, line] of source.split('\n').entries()) {
    const cjkCount = (line.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length
    if (cjkCount >= 50) failures.push(`${file}:${index + 1}: fixture prose is too long; use minimal synthetic text`)
  }
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('Test fixture hygiene: pass')
