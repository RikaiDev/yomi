/**
 * Attaches the MCP Apps `_meta.ui` linkage to the `login` tool definition,
 * but only for clients that negotiated MCP Apps support (see
 * ./capability.ts) — on a client without it, the tool list served must stay
 * byte-for-byte what it always was. Kept separate from ../tools.ts (a flat,
 * static schema registry) because this step is per-connection, not static.
 */
import { LOGIN_UI_RESOURCE_URI } from './resource.js'

/**
 * Return `tools` as-is for a client without MCP Apps support, or a copy with
 * the `login` entry augmented with `_meta.ui.resourceUri` for one that has
 * it. Never mutates the input array/objects. Generic over the caller's
 * exact tool type (rather than a loosened `Record<string, unknown>`) so the
 * SDK's stricter `Tool[]` return type still checks at the call site in
 * ../server.ts.
 *
 * @param tools - The static tool list (../tools.ts's TOOLS).
 * @param supportsMcpApps - Result of ./capability.ts's `supportsMcpApps`.
 * @returns The tool list to serve for this client.
 */
export function toolsForClient<T extends { name: string; _meta?: unknown }>(
  tools: T[],
  supportsMcpApps: boolean,
): (
  | T
  | (T & { _meta: { ui: { resourceUri: string; visibility: string[] } } })
)[] {
  if (!supportsMcpApps) {
    return tools
  }
  return tools.map((tool) => {
    if (tool.name !== 'login') {
      return tool
    }
    return {
      ...tool,
      _meta: {
        ...(typeof tool._meta === 'object' && tool._meta ? tool._meta : {}),
        ui: {
          resourceUri: LOGIN_UI_RESOURCE_URI,
          visibility: ['model', 'app'],
        },
      },
    }
  })
}
