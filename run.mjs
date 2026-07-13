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

const args = process.argv.slice(2);
const cmd = args[0] ?? 'serve';

switch (cmd) {
  case 'login': {
    const { cliLogin } = await import('./src/cli/login.ts');
    const code = await cliLogin(args.slice(1));
    process.exit(code);
  }
  case 'serve':
    await import('./src/mcp/server.ts');
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
    const { YOMI_VERSION } = await import('./src/version.ts');
    console.log(YOMI_VERSION);
    break;
  }
  default:
    console.error(`Unknown command: ${cmd}\nRun 'yomi help' for usage.`);
    process.exit(1);
}
