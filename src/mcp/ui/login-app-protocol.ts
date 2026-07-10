/**
 * JSON-RPC-over-postMessage transport for the login view, plus the MCP
 * Apps lifecycle handshake (`ui/initialize` -> `ui/notifications/initialized`)
 * and size-changed reporting. Emitted verbatim into ../login-app.ts's
 * `<script>` tag, ahead of ./login-app-view.ts's rendering code, inside one
 * shared `(function () { 'use strict'; ... })();` wrapper both blobs are
 * concatenated into — so the `var`/`function` declarations here are plain
 * ordinary bindings, visible to login-app-view.ts by simple scope, not
 * exported through any `window.*` global. Split out of login-app.ts purely
 * to keep that file (and this one) under the project's 500-scc-line module
 * cap.
 *
 * Per the MCP Apps spec (specification/2026-01-26/apps.mdx), the JSON-RPC
 * message IS the postMessage payload (no envelope), sent to `window.parent`
 * with targetOrigin `'*'` — the view must not perform origin checks; it
 * trusts `window.parent`. ONE `message` listener demultiplexes both
 * directions: a message carrying `id` plus `result`/`error` is a response
 * to a request THIS view sent (`sendRequest`/`callTool`); a message
 * carrying only `method` is a notification FROM the host (`onNotification`
 * subscribers). The spec's own reference snippet sets up one listener per
 * outstanding request, which leaks a listener per call — this file adds
 * exactly one, for the page's lifetime, and correlates by `id` instead.
 */

/**
 * Build the transport/handshake JS, parameterized by yomi's own version so
 * `ui/initialize`'s `clientInfo.version` reports it.
 *
 * @param version - `YOMI_VERSION` from ../../version.ts, a build-time
 * constant (not a runtime package.json read — that fails inside a `bun
 * build --compile` binary's virtual filesystem). version.test.ts asserts
 * it stays equal to package.json's "version" field so the two can't drift.
 */
export function buildLoginAppProtocolJs(version: string): string {
  const versionLiteral = JSON.stringify(version);
  return `
  var nextRequestId = 1;
  var pendingRequests = {};
  var notificationHandlers = {};

  function onNotification(method, handler) {
    notificationHandlers[method] = handler;
  }

  function sendRequest(method, params) {
    var id = nextRequestId++;
    return new Promise(function (resolve, reject) {
      pendingRequests[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');
    });
  }

  function sendNotification(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params || {} }, '*');
  }

  function callTool(name, toolArguments) {
    return sendRequest('tools/call', { name: name, arguments: toolArguments || {} });
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
    var hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    var isResponse = hasId && (Object.prototype.hasOwnProperty.call(message, 'result')
      || Object.prototype.hasOwnProperty.call(message, 'error'));
    if (isResponse) {
      var waiting = pendingRequests[message.id];
      if (!waiting) return;
      delete pendingRequests[message.id];
      if (message.error) {
        waiting.reject(new Error((message.error && message.error.message) || 'Request failed.'));
      }
      else {
        waiting.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      var handler = notificationHandlers[message.method];
      if (handler) handler(message.params || {});
    }
  });

  var lastReportedSize = null;

  function reportSize() {
    var width = document.documentElement.scrollWidth;
    var height = document.documentElement.scrollHeight;
    var key = width + 'x' + height;
    if (key === lastReportedSize) return;
    lastReportedSize = key;
    sendNotification('ui/notifications/size-changed', { width: width, height: height });
  }

  function applyTheme(theme) {
    var root = document.documentElement;
    root.classList.remove('theme-dark', 'theme-light');
    if (theme === 'dark') root.classList.add('theme-dark');
    else if (theme === 'light') root.classList.add('theme-light');
  }

  function initializeHost(onReady) {
    sendRequest('ui/initialize', {
      capabilities: {},
      clientInfo: { name: 'yomi login', version: ${versionLiteral} },
      protocolVersion: '2026-01-26',
      appCapabilities: { availableDisplayModes: ['inline'] },
    }).then(function (result) {
      var hostContext = (result && result.hostContext) || {};
      applyTheme(hostContext.theme || null);
      sendNotification('ui/notifications/initialized', {});
      onReady(hostContext, null);
    }).catch(function (error) {
      onReady(null, error);
    });
  }
`;
}
