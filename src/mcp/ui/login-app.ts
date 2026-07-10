/**
 * KNOWN CEILING — read before touching anything that depends on this view
 * actually rendering: this implementation follows the 2026-01-26 MCP Apps
 * spec (specification/2026-01-26/apps.mdx) and is spec-correct per
 * ext-apps#615 (renders fine under MCP Inspector). In production, the host
 * fetches this resource successfully and then NEVER completes the
 * `ui/initialize` handshake — no iframe is created, no response to this
 * view's `ui/initialize` request ever arrives. This is an open, unfixed,
 * upstream host bug, not something fixable from the server side:
 * anthropics/claude-ai-mcp#165 (stdio transport: resources/read succeeds,
 * tool calls succeed, `ui/initialize` hangs, no iframe) and #236 (Claude
 * Cowork with third-party inference renders plain text, no iframe, despite
 * identical protocol negotiation). Measured on the operator's real machine:
 * `resources.list` reports `supportsUi=true`, `resources.read` succeeds —
 * and still nothing renders.
 *
 * Consequence for every other file in ./ui and ../handlers-login.ts: THIS
 * VIEW HAS NEVER BEEN OBSERVED TO RENDER on any deployed client. Nothing in
 * this codebase may put it on the critical path of any flow — the plain
 * tool-result text the model sees must always be fully actionable on its
 * own, with or without this view. Do not remove the view; it costs nothing,
 * is spec-correct, and will start working the moment the host does.
 *
 * MCP Apps UI for the `login` tool — served as the `ui://yomi/login`
 * resource (see ../server.ts). Self-contained document: no external
 * requests, no CDN, no fonts. The composed document performs the MCP Apps
 * lifecycle handshake (`ui/initialize` -> `ui/notifications/initialized`,
 * see ./login-app-protocol.ts) as soon as it loads, then renders off
 * `ui/notifications/tool-result` — and it is no longer strictly read-only:
 * a submitted login form still calls `tools/call login` itself (a
 * HUMAN-initiated action). It no longer calls `login_complete` on its own —
 * that is the model's job, always (see ./login-app-view.ts).
 *
 * Composed from three sibling modules, split out purely to keep every
 * individual file under the project's 500-scc-line module cap as this view
 * grew from a read-only display into a form-driving client:
 *   - ./login-app-styles.ts   — the `<style>` block.
 *   - ./login-app-protocol.ts — JSON-RPC transport + lifecycle handshake.
 *   - ./login-app-view.ts     — stage rendering + tool-call orchestration.
 *
 * The PIN is remote data — rendered with `textContent`, never `innerHTML`;
 * same for any error message. All timing numbers (the 3-minute PIN code
 * lifetime, the client's poll-ceiling minutes) are read from
 * `structuredContent` at render time — none are written into this
 * HTML/JS source, so there is exactly one place (../handlers-login.ts,
 * sourced from ../../line/auth/pwless/index.ts) that owns each number.
 */
import { createRequire } from 'node:module';
import { buildLoginAppProtocolJs } from './login-app-protocol.js';
import { LOGIN_APP_CSS } from './login-app-styles.js';
import { LOGIN_APP_VIEW_JS } from './login-app-view.js';

// `import … from '../../../package.json'` would resolve outside tsconfig's
// `rootDir: "src"` and fail the build — there is no clean static-import
// path to the repo's own package.json from here. `createRequire` is the
// standard ESM escape hatch for exactly this: a runtime `require` call,
// resolved relative to this file, not subject to `rootDir`.
const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json');
const YOMI_VERSION = String(packageJson.version);

export const LOGIN_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>LINE Login</title>
<style>
${LOGIN_APP_CSS}
</style>
</head>
<body>
<main id="app"></main>
<script>
(function () {
  'use strict';
${buildLoginAppProtocolJs(YOMI_VERSION)}
${LOGIN_APP_VIEW_JS}
})();
</script>
</body>
</html>
`;
