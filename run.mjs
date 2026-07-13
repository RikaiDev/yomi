#!/usr/bin/env node
/**
 * Yomi entry point — the npm shim.
 *
 * Usage:
 *   yomi                Start the MCP stdio server (default)
 *   yomi serve          Same as above, explicit
 *   yomi login [...]    Run the passwordless login flow in a terminal
 *   yomi help           Show this help
 *   yomi version        Print version
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load the compiled `dist/` build when it exists (this is what the npm
// tarball ships), and fall back to the TypeScript sources for a repo
// checkout that has not been built yet.
//
// The fallback CANNOT rescue an installed package: Node refuses to strip
// types for files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_
// STRIPPING), which is exactly how every 0.1.x release failed to start.
// `files` in package.json must therefore always ship `dist/`.
const distUrl = new URL('./dist/', import.meta.url);
const built = existsSync(fileURLToPath(new URL('mcp/server.js', distUrl)));
const base = built ? distUrl : new URL('./src/', import.meta.url);
const ext = built ? '.js' : '.ts';

/** Import a module by its path under src/, resolved to dist/ when built. */
const load = (path) => import(new URL(path + ext, base).href);

const args = process.argv.slice(2);
const cmd = args[0] ?? 'serve';

switch (cmd) {
  case 'login': {
    const { cliLogin } = await load('cli/login');
    const code = await cliLogin(args.slice(1));
    process.exit(code);
  }
  case 'serve':
    await load('mcp/server');
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(`Yomi (読み) — read, reply, send images to, and search your LINE from any AI agent.

Usage:
  yomi                Start the MCP stdio server (default)
  yomi serve          Same as above, explicit
  yomi login [...]    Run the passwordless login flow in a terminal
  yomi help           Show this help
  yomi version        Print version

Examples:
  npx @rikaidev/yomi                  # start MCP server
  npx @rikaidev/yomi login            # interactive login
  npx @rikaidev/yomi login --phone +886912345678 --region TW`);
    break;
  case 'version':
  case '--version':
  case '-v': {
    const { YOMI_VERSION } = await load('version');
    console.log(YOMI_VERSION);
    break;
  }
  default:
    console.error(`Unknown command: ${cmd}\nRun 'yomi help' for usage.`);
    process.exit(1);
}
