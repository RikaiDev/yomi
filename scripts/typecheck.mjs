#!/usr/bin/env node
// typecheck — run the TypeScript check through the machine's sanctioned lane.
//
// Why a wrapper instead of calling `tsc` directly: on a machine with the
// compile supervisor, a compiler may only exist if it descends from the
// machine's singleflight coordinator. A compile launched straight from a
// package script does not, so the supervisor would end it as an unsanctioned
// compile. The wrapper makes the sanctioned path the only path this repo
// takes, while staying portable: on a machine (or CI runner) without the
// coordinator it falls back to the project's own compiler.
//
// Usage: node scripts/typecheck.mjs [tsc arguments...]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const coordinator =
  process.env.MACHINE_QOS_TYPECHECK ??
  join(homedir(), '.agents/skills/machine-qos/scripts/typecheck-singleflight.sh')
const localCompiler = join(process.cwd(), 'node_modules/.bin/tsc')
const args = process.argv.slice(2)

if (!existsSync(localCompiler)) {
  console.error(`typecheck: the project's compiler is missing: ${localCompiler}`)
  process.exit(69)
}

if (existsSync(coordinator)) {
  const result = spawnSync(coordinator, [localCompiler, ...args], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const result = spawnSync(localCompiler, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
