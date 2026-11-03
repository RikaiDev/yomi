/**
 * Tests for MCP integrator and skill installation hygiene.
 * Ensures the agent skill definition never drifts from registered tools in TOOLS.
 */

import { describe, expect, test } from 'bun:test'
import { getClientTargets, getYomiMcpDefinition } from './integrator.js'
import { TOOLS } from './tools.js'

describe('MCP Integrator', () => {
  test('returns known client targets including desktop and CLI runners', () => {
    const targets = getClientTargets()
    const ids = targets.map((t) => t.id)
    expect(ids).toContain('claude-desktop')
    expect(ids).toContain('codex-desktop')
    expect(ids).toContain('cursor')
    expect(ids).toContain('claude-cli')
  })

  test('getYomiMcpDefinition produces executable npx invocation', () => {
    const def = getYomiMcpDefinition()
    expect(def.command).toBeDefined()
    expect(def.args).toContain('@rikaidev/yomi')
  })

  test('skill template tools exist in registered TOOLS without drift', async () => {
    // Read the skill file template from integrator
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')

    const integratorPath = fileURLToPath(
      new URL('integrator.ts', import.meta.url),
    )
    const source = readFileSync(integratorPath, 'utf8')

    // Find the skillContent template inside integrator.ts
    const match = source.match(
      /const skillContent = `([\s\S]*?)`\n\n\s*const skillDirs/,
    )
    expect(match).not.toBeNull()
    const skillContent = match![1]

    // Verify phantom tools are absent
    expect(skillContent).not.toContain('get_recent_messages')

    // Extract tool names cited in escaped backticks (\`tool_name\`) under Reading and Writing
    const toolRegex = /\\`([a-z_]+)\\`/g
    const mentionedTools = new Set<string>()
    for (const match of skillContent.matchAll(toolRegex)) {
      const name = match[1]
      // Exclude CLI command references like `yomi`
      if (name !== 'yomi') {
        mentionedTools.add(name)
      }
    }

    const registeredNames = new Set(TOOLS.map((t) => t.name))

    for (const tool of mentionedTools) {
      expect(registeredNames.has(tool)).toBe(true)
    }

    // Verify key expected tools are documented in the skill
    expect(mentionedTools.has('list_conversations')).toBe(true)
    expect(mentionedTools.has('get_chat_messages')).toBe(true)
    expect(mentionedTools.has('send_message')).toBe(true)
    expect(mentionedTools.has('unsend_message')).toBe(true)
  })
})
