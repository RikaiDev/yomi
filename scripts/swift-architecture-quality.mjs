import fs from 'node:fs'

// Ownership boundaries, not a global API ban. Low-level work must remain in
// named services/stores so observable state and views only coordinate/render.
const rules = [
  {
    file: 'desktop/mac-native/Core/AppState.swift',
    forbidden: [
      /import\s+(?:Compression|CryptoKit|Security)\b/,
      /Data\(contentsOf:/,
      /\.write\(to:/,
      /NSImage\(data:/,
      /ImageCache\./,
      /\bProcess\(\)/,
      /\bPipe\(\)/,
    ],
  },
  {
    file: 'desktop/mac-native/Features/Conversation/ConversationView.swift',
    forbidden: [/\bProcess\(\)/, /Data\(contentsOf:/, /FileManager\./],
  },
]

const failures = []
for (const rule of rules) {
  const source = fs.readFileSync(rule.file, 'utf8')
  for (const pattern of rule.forbidden ?? []) {
    if (pattern.test(source)) failures.push(`${rule.file}: ownership violation ${pattern}`)
  }
  for (const pattern of rule.required ?? []) {
    if (!pattern.test(source)) failures.push(`${rule.file}: missing Work Tray regression guard ${pattern}`)
  }
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('Swift architecture boundaries: pass')
