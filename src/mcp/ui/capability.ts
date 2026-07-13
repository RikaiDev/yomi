/**
 * MCP Apps ("io.modelcontextprotocol/ui") capability detection.
 *
 * The SDK's `ClientCapabilities` type (see node_modules/@modelcontextprotocol/
 * sdk/dist/esm/types.d.ts, `ClientCapabilitiesSchema`) DOES declare an
 * `extensions` field: `Record<string, object> | undefined` — so no cast is
 * needed to reach `capabilities.extensions`. What it does NOT know about is
 * the shape of any individual extension's value; each entry is typed as the
 * bare `object`, since extensions are an open set the SDK doesn't enumerate.
 * So `capabilities.extensions['io.modelcontextprotocol/ui']` is `object`,
 * and reading `.mimeTypes` off it needs a runtime shape check rather than an
 * `as` assertion. TypeScript's `in`-operator narrowing (supported for plain
 * `object` since TS 4.9) does this without a cast: after
 * `'mimeTypes' in value`, `value` narrows to `object & Record<'mimeTypes',
 * unknown>`, so `value.mimeTypes` is accessible as `unknown`.
 */
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js'

/** The MCP Apps UI mime type the host must declare support for. */
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app'

/** The extension key the MCP Apps spec registers capability support under. */
const MCP_APPS_EXTENSION_KEY = 'io.modelcontextprotocol/ui'

/**
 * Does the connected client's negotiated capabilities include MCP Apps UI
 * support (the `text/html;profile=mcp-app` mime type under the
 * `io.modelcontextprotocol/ui` extension)?
 *
 * @param capabilities - Result of `server.getClientCapabilities()`.
 * @returns True only when the client explicitly declared the mime type.
 */
export function supportsMcpApps(
  capabilities: ClientCapabilities | undefined,
): boolean {
  const extension = capabilities?.extensions?.[MCP_APPS_EXTENSION_KEY]
  if (!extension || typeof extension !== 'object') {
    return false
  }
  if (!('mimeTypes' in extension)) {
    return false
  }
  const { mimeTypes } = extension
  if (!Array.isArray(mimeTypes)) {
    return false
  }
  return mimeTypes.includes(MCP_APPS_MIME_TYPE)
}
