#!/usr/bin/env node
/**
 * Build a Desktop Extension bundle (.mcpb) for one platform.
 *
 * Why this exists: the documented npx install needs a terminal, Node v24+, and
 * a hand-edited claude_desktop_config.json. A GUI-only user (especially on
 * Windows, where Claude Desktop's MSIX packaging reads a *different* config
 * file than the one "Edit Config" opens — anthropics/claude-code#26073) cannot
 * realistically get through that. A .mcpb is drag-and-drop: no terminal, no
 * Node install (Claude Desktop ships its own runtime), no JSON, no MSIX path.
 *
 * Why per-platform: transformers.js pulls in onnxruntime-node and sharp, both
 * of which carry native binaries. npm only fetches the CURRENT platform's
 * optional deps, so a Windows bundle cannot be built by simply copying this
 * machine's node_modules — we re-resolve with --os/--cpu and then prune every
 * platform we are not shipping (onnxruntime-node alone carries ~215MB across
 * all five; a single target is ~60MB).
 *
 * Usage:
 *   node scripts/build-mcpb.mjs                     # host platform
 *   node scripts/build-mcpb.mjs --os win32 --cpu x64
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { platform, arch } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not .pathname: on Windows the latter yields "/D:/a/yomi",
// which join() turns into "D:\D:\a\yomi".
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const TARGET_OS = flag('os', platform())
const TARGET_CPU = flag('cpu', arch())
const OUT = join(ROOT, 'build', `mcpb-${TARGET_OS}-${TARGET_CPU}`)

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * Run a command, echoing it, with output inherited.
 *
 * shell: true because on Windows `npm`/`npx` are .cmd shims, which
 * execFileSync cannot spawn directly (ENOENT).
 */
const run = (cmd, cmdArgs, cwd = ROOT) => {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`)
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: true })
}

// The bundle ships compiled JS. Shipping src/*.ts would reproduce the bug that
// made 0.1.0-0.1.2 unstartable (Node will not strip types under node_modules).
console.log('\n=== build dist/ ===')
run('npx', ['tsc'])
if (!existsSync(join(ROOT, 'dist/mcp/server.js'))) {
  throw new Error('tsc did not emit dist/mcp/server.js')
}

console.log(`\n=== stage ${TARGET_OS}-${TARGET_CPU} ===`)
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

for (const file of ['run.mjs', 'README.md', 'LICENSE', 'NOTICE', 'PRIVACY.md']) {
  cpSync(join(ROOT, file), join(OUT, file))
}
cpSync(join(ROOT, 'dist'), join(OUT, 'dist'), { recursive: true })

// A package.json with runtime deps only — npm resolves the target platform's
// optional native packages (sharp, onnxruntime) from it.
writeFileSync(
  join(OUT, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      type: 'module',
      private: true,
      dependencies: pkg.dependencies,
    },
    null,
    2,
  )}\n`,
)

console.log(`\n=== install deps for ${TARGET_OS}/${TARGET_CPU} ===`)
run(
  'npm',
  [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    `--os=${TARGET_OS}`,
    `--cpu=${TARGET_CPU}`,
  ],
  OUT,
)

console.log('\n=== prune ===')
const modules = join(OUT, 'node_modules')

// onnxruntime-web is a browser build; nothing in a Node MCP server loads it.
rmSync(join(modules, 'onnxruntime-web'), { recursive: true, force: true })

// onnxruntime-node ships binaries for every platform in one package.
const bins = join(modules, 'onnxruntime-node/bin/napi-v6')
if (existsSync(bins)) {
  for (const os of ['darwin', 'linux', 'win32']) {
    if (os === TARGET_OS) continue
    rmSync(join(bins, os), { recursive: true, force: true })
  }
  const kept = join(bins, TARGET_OS)
  if (existsSync(kept)) {
    for (const cpu of ['x64', 'arm64']) {
      if (cpu === TARGET_CPU) continue
      rmSync(join(kept, cpu), { recursive: true, force: true })
    }
  }
}

// transformers.js ships its TS sources and .d.ts alongside the dist bundle,
// and caches downloaded models under .cache when it has been run.
for (const dir of ['types', 'src', '.cache']) {
  rmSync(join(modules, '@huggingface/transformers', dir), {
    recursive: true,
    force: true,
  })
}

console.log('\n=== manifest.json ===')
const manifest = {
  manifest_version: '0.1',
  name: 'yomi',
  display_name: 'Yomi (読み)',
  version: pkg.version,
  description: pkg.description,
  long_description:
    'Read your LINE from an AI agent — and reply, send images, and search ' +
    'across every conversation — without a browser and without LINE\'s own ' +
    'client. Yomi speaks LINE\'s protocol directly, decrypts Letter-Sealing ' +
    '(E2EE) messages and media, and keeps everything on this machine.',
  author: { name: 'RikaiDev' },
  homepage: pkg.homepage,
  repository: pkg.repository,
  license: pkg.license,
  keywords: pkg.keywords,
  server: {
    type: 'node',
    entry_point: 'run.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/run.mjs'],
      env: {},
    },
  },
  compatibility: {
    claude_desktop: '>=0.10.0',
    platforms: [TARGET_OS],
    runtimes: { node: '>=20.0.0' },
  },
}
writeFileSync(
  join(OUT, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
)

console.log('\n=== pack ===')
run('npx', ['-y', '@anthropic-ai/mcpb', 'validate', 'manifest.json'], OUT)
run('npx', ['-y', '@anthropic-ai/mcpb', 'pack', '.', `yomi-${TARGET_OS}-${TARGET_CPU}.mcpb`], OUT)

console.log(`\nDone: ${join(OUT, `yomi-${TARGET_OS}-${TARGET_CPU}.mcpb`)}`)
