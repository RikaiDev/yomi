#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)

function valueOf(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function fail(message) {
  console.error(`[desktop:core] ${message}`)
  process.exit(1)
}

function run(command, commandArgs, cwd = root) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} failed (${result.status ?? 'signal'})`)
}

function directorySize(path) {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (stat.isFile()) return stat.size
  return readdirSync(path).reduce((total, entry) => total + directorySize(join(path, entry)), 0)
}

function findNodeLicense(nodeBinary) {
  const explicit = valueOf('--node-license')
  if (explicit && existsSync(explicit)) return resolve(explicit)
  let directory = dirname(nodeBinary)
  for (let depth = 0; depth < 4; depth++) {
    for (const name of ['LICENSE', 'LICENSE.md']) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
    directory = dirname(directory)
  }
  return null
}

const output = valueOf('--output')
const platform = valueOf('--platform')
const nodeBinary = resolve(valueOf('--node-binary') || process.execPath)
const semantic = valueOf('--semantic') || 'lite'
const skipBuild = args.includes('--skip-build')
if (!output || !platform) fail('usage: --output DIR --platform macos|windows [--node-binary PATH] [--node-license PATH] [--semantic lite|full]')
if (!['macos', 'windows'].includes(platform)) fail(`unsupported platform: ${platform}`)
if (!['lite', 'full'].includes(semantic)) fail(`unsupported semantic mode: ${semantic}`)
if (!existsSync(nodeBinary)) fail(`Node runtime not found: ${nodeBinary}`)
if (!skipBuild) run('npm', ['run', 'build'])
if (!existsSync(join(root, 'dist', 'mcp', 'server.js'))) fail('dist/ is missing; run npm run build first')

let nodeLicense = findNodeLicense(nodeBinary)
if (!nodeLicense) {
  const fallback = join(root, 'LICENSE')
  if (existsSync(fallback)) {
    console.warn(`[desktop:core] Node LICENSE not found at ${nodeBinary}, using project LICENSE as fallback for preview`)
    nodeLicense = fallback
  } else {
    fail('Node LICENSE not found; pass --node-license so redistribution remains compliant')
  }
}

const destination = resolve(output)
const core = join(destination, 'YomiCore')
const runtime = join(destination, 'runtime')
rmSync(destination, { recursive: true, force: true })
mkdirSync(core, { recursive: true })
mkdirSync(runtime, { recursive: true })

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dependencies = { ...packageJson.dependencies }
if (semantic === 'lite') delete dependencies['@huggingface/transformers']

const installRoot = mkdtempSync(join(tmpdir(), 'yomi-desktop-core-'))
process.once('exit', () => rmSync(installRoot, { recursive: true, force: true }))
writeFileSync(
  join(installRoot, 'package.json'),
  `${JSON.stringify({ private: true, type: 'module', dependencies }, null, 2)}\n`,
)
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], installRoot)

if (semantic === 'full') {
  const modules = join(installRoot, 'node_modules')
  // Transformers uses the native Node backend in Desktop. Browser WASM and
  // binaries for other operating systems are not runtime fallbacks; shipping
  // them would add hundreds of megabytes without ever being loaded.
  rmSync(join(modules, 'onnxruntime-web'), { recursive: true, force: true })
  const nativeRoot = join(modules, 'onnxruntime-node', 'bin', 'napi-v6')
  const targetPlatform = platform === 'macos' ? 'darwin' : 'win32'
  for (const platformName of readdirSync(nativeRoot)) {
    const platformPath = join(nativeRoot, platformName)
    if (platformName !== targetPlatform) {
      rmSync(platformPath, { recursive: true, force: true })
      continue
    }
    for (const architecture of readdirSync(platformPath)) {
      const expectedArchitecture = platform === 'macos' ? process.arch : 'x64'
      if (architecture !== expectedArchitecture) {
        rmSync(join(platformPath, architecture), { recursive: true, force: true })
      }
    }
  }
}

cpSync(join(root, 'dist'), join(core, 'dist'), { recursive: true })
cpSync(join(root, 'run.mjs'), join(core, 'run.mjs'))
cpSync(join(installRoot, 'node_modules'), join(core, 'node_modules'), { recursive: true })
rmSync(join(core, 'node_modules', '.bin'), { recursive: true, force: true })
for (const file of ['LICENSE', 'NOTICE', 'PRIVACY.md']) {
  cpSync(join(root, file), join(core, file))
}
writeFileSync(
  join(core, 'package.json'),
  `${JSON.stringify({ name: '@rikaidev/yomi-desktop-core', version: packageJson.version, private: true, type: 'module', dependencies }, null, 2)}\n`,
)

const runtimeName = platform === 'windows' ? 'node.exe' : 'node'
cpSync(nodeBinary, join(runtime, runtimeName))
cpSync(nodeLicense, join(runtime, 'NODE-LICENSE'))
if (platform !== 'windows') chmodSync(join(runtime, runtimeName), 0o755)

const coreBytes = directorySize(core)
const runtimeBytes = directorySize(runtime)
const totalBytes = coreBytes + runtimeBytes
const maxBytes = Number(process.env.YOMI_DESKTOP_MAX_UNPACKED_MB || 220) * 1024 * 1024
const manifest = {
  version: packageJson.version,
  platform,
  arch: process.arch,
  semantic,
  runtime: basename(nodeBinary),
  bytes: { core: coreBytes, runtime: runtimeBytes, total: totalBytes },
}
writeFileSync(join(destination, 'desktop-bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`)

if (totalBytes > maxBytes) {
  fail(`unpacked bundle is ${(totalBytes / 1024 / 1024).toFixed(1)} MB, above ${Math.round(maxBytes / 1024 / 1024)} MB budget`)
}

const smoke = spawnSync(join(runtime, runtimeName), [join(core, 'run.mjs'), 'version'], {
  cwd: core,
  encoding: 'utf8',
  env: { ...process.env, YOMI_SKIP_UPDATE_CHECK: '1' },
})
if (smoke.status !== 0 || smoke.stdout.trim() !== packageJson.version) {
  fail(`bundled core smoke failed: ${smoke.stderr || smoke.stdout}`)
}

console.log(
  `[desktop:core] ${platform}/${semantic} ${(totalBytes / 1024 / 1024).toFixed(1)} MB ` +
    `(core ${(coreBytes / 1024 / 1024).toFixed(1)} MB, runtime ${(runtimeBytes / 1024 / 1024).toFixed(1)} MB)`,
)
