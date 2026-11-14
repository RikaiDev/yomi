/**
 * Universal 1-Click MCP Integrator for Claude Desktop, Claude Cowork, Codex, Cursor, Windsurf, VS Code (Cline/Roo).
 * Also automatically generates and registers Yomi Skills for AI Agent assistants.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface ClientTarget {
  id: string
  name: string
  configPath: string
  configType: 'mcpServers' | 'experimentalMcp' | 'custom'
  requiresApp?: string
}

export function getClientTargets(): ClientTarget[] {
  const home = homedir()
  return [
    {
      id: 'claude-desktop',
      name: 'Claude Desktop & Cowork',
      configPath: join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      ),
      configType: 'mcpServers',
      requiresApp: '/Applications/Claude.app',
    },
    {
      id: 'codex-desktop',
      name: 'Codex Desktop & CLI',
      configPath: join(home, '.codex', 'mcp.json'),
      configType: 'mcpServers',
    },
    {
      id: 'cursor',
      name: 'Cursor IDE',
      configPath: join(home, '.cursor', 'mcp.json'),
      configType: 'mcpServers',
      requiresApp: '/Applications/Cursor.app',
    },
    {
      id: 'windsurf',
      name: 'Windsurf (Codeium)',
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      configType: 'mcpServers',
      requiresApp: '/Applications/Windsurf.app',
    },
    {
      id: 'cline',
      name: 'VS Code (Cline)',
      configPath: join(
        home,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json',
      ),
      configType: 'mcpServers',
    },
    {
      id: 'roo-code',
      name: 'VS Code (Roo Code)',
      configPath: join(
        home,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'cline_mcp_settings.json',
      ),
      configType: 'mcpServers',
    },
    {
      id: 'claude-cli',
      name: 'Claude Code CLI',
      configPath: join(home, '.claude.json'),
      configType: 'mcpServers',
    },
  ]
}

export function getYomiMcpDefinition() {
  const home = homedir()
  const npxPath = existsSync('/opt/homebrew/bin/npx')
    ? '/opt/homebrew/bin/npx'
    : existsSync('/usr/local/bin/npx')
      ? '/usr/local/bin/npx'
      : 'npx'

  return {
    command: npxPath,
    args: ['-y', '@rikaidev/yomi'],
    env: {
      PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  }
}

export function installYomiAgentSkill(): { success: boolean; path: string } {
  const home = homedir()
  const skillContent = `---
name: yomi-line-manager
description: Manage and interact with user's LINE account via Yomi E2EE MCP Server. Query messages, summarize chats, search history, find contacts, and draft replies.
---

# Yomi LINE Copilot Skill

You have real-time access to the user's LINE account through the Yomi Letter-Sealing E2EE server. Check which of these tools your runtime actually exposes, and complete a scoped read before claiming that access; the names below describe expected capabilities, not proof they are connected.

## Reading
1. \`list_conversations\`: List the chats the account can see.
2. \`get_chat_messages\`: Read the recent decrypted messages of one chat.
3. \`collect_messages\`: Collect messages across several chats.
4. \`search_messages\`: Full-text search across conversations.
5. \`get_unread_digest\`: Summarize what is unread.
6. \`get_insight\`: Ask the account model for an insight about the messages.
7. \`get_style_profile\`: ALWAYS retrieve the user's personal writing style before drafting any reply (default behavior).
8. \`find_contact\` and \`list_contacts\`: Resolve a person or a group to its chat id.

## Writing
1. \`send_message\`: Send a text message to a chat.
2. \`unsend_message\`: Recall a message the account sent.

## Operating the server
- The Yomi Model Context Protocol server is registered globally for the coding tools on this machine. Every tool keeps its own server list, so a tool that does not expose the names above is missing its own registration, not the server.
- When the names above are in your tool list, call them directly. Start the server yourself only when they are absent.
- The Model Context Protocol server speaks stdio and lives only while its stdin stays open. A command that closes stdin ends the server, so keep the pipe open for as long as the session needs it.
- The \`yomi messages\` CLI reports an empty list; only the Model Context Protocol tools above return real messages.
- \`unsend_message\` is irreversible, and LINE accepts a recall only within one hour of sending. A recall past that window is refused by LINE itself, not by the tool.

## Recovering message text
- A message can come back with no text while the conversation still holds it. The local search index keeps the plaintext, so look the same message id up in \`search-index.db\` in the Yomi data directory before you report a message as empty.
- An empty text field is not proof of a recall. A recall is an unsend you made yourself, and LINE refuses one outside the first hour.

## Guidelines
- Summarize conversations concisely and highlight action items or mentions needing attention.
- Drafting does not authorize sending. Require explicit sending authorization for the recipient and content; reuse that exact authorization when already given.
- A recall writes to the conversation as well, so it needs the same explicit authorization as sending.
`

  const skillDirs = [
    join(home, '.agents', 'skills', 'yomi-line-manager'),
    join(home, '.claude', 'skills', 'yomi-line-manager'),
    join(
      home,
      '.gemini',
      'antigravity-cli',
      'builtin',
      'skills',
      'yomi-line-manager',
    ),
    join(home, '.codex', 'skills', 'yomi-line-manager'),
  ]

  let installedPath = ''
  for (const dir of skillDirs) {
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o755 })
      }
      const skillFile = join(dir, 'SKILL.md')
      writeFileSync(skillFile, skillContent, { mode: 0o644 })
      installedPath = skillFile
    } catch {
      // Ignore directory write failures for optional tools
    }
  }

  return { success: true, path: installedPath }
}

export function integrateClient(target: ClientTarget): {
  success: boolean
  message: string
  path: string
} {
  try {
    const dir = dirname(target.configPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o755 })
    }

    let config: any = {}
    if (existsSync(target.configPath)) {
      try {
        const raw = readFileSync(target.configPath, 'utf8')
        config = JSON.parse(raw)
      } catch {
        config = {}
      }
    }

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {}
    }

    config.mcpServers.yomi = getYomiMcpDefinition()

    writeFileSync(target.configPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
    })

    return {
      success: true,
      message: `Integrated Yomi MCP into ${target.name}`,
      path: target.configPath,
    }
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to configure ${target.name}: ${err.message}`,
      path: target.configPath,
    }
  }
}

export function integrateAllClients(): {
  results: Array<{
    id: string
    name: string
    success: boolean
    message: string
    path: string
  }>
  totalSuccess: number
  skillInstalled: boolean
} {
  const skillResult = installYomiAgentSkill()
  const targets = getClientTargets()
  const results = targets.map((t) => {
    const res = integrateClient(t)
    return {
      id: t.id,
      name: t.name,
      ...res,
    }
  })

  return {
    results,
    totalSuccess: results.filter((r) => r.success).length,
    skillInstalled: skillResult.success,
  }
}
