#!/usr/bin/env bun
/**
 * Yomi entry point.
 *
 * `bun run.mjs login [--phone +886...] [--region TW]` runs the passwordless
 * login flow in a terminal (see src/cli/login.ts) — the guaranteed-to-work
 * path when there is no MCP client around to elicit phone/region or show
 * the PIN.
 *
 * Anything else (including no args) is the MCP stdio launcher.
 */

const args = process.argv.slice(2);

if (args[0] === 'login') {
  const { cliLogin } = await import('./src/cli/login.ts');
  const code = await cliLogin(args.slice(1));
  process.exit(code);
}
else {
  await import('./src/mcp/server.ts');
}
