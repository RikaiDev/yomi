/**
 * The single MCP Apps UI resource this server exposes: the login view.
 * Registered by ../server.ts's `resources/list` and `resources/read`
 * handlers, gated on client capability (see ./capability.ts) so a client
 * without MCP Apps support sees an empty resource list, unchanged from
 * before this feature existed.
 *
 * The `csp` key within `_meta.ui` is deliberately omitted: the login view
 * makes no outbound connections and loads nothing external, so the host's
 * most restrictive default (no external connections at all) is exactly right.
 * The `_meta.ui` block itself (containing `prefersBorder`) is present in both
 * the `resources/list` entry and the `resources/read` contents, matching the
 * MCP Apps spec.
 */
import { MCP_APPS_MIME_TYPE } from './capability.js';
import { LOGIN_APP_HTML } from './login-app.js';

/** The `ui://` resource URI for the login view. */
export const LOGIN_UI_RESOURCE_URI = 'ui://yomi/login';

/** UI metadata shared by both resources/list and resources/read entries. */
const LOGIN_UI_META = { ui: { prefersBorder: true } } as const;

/** `resources/list` entry for the login view. */
export const LOGIN_UI_RESOURCE_LISTING = {
  uri: LOGIN_UI_RESOURCE_URI,
  name: 'login_view',
  description: 'Interactive LINE login view — shows the PIN or device-approval step with a live countdown.',
  mimeType: MCP_APPS_MIME_TYPE,
  _meta: LOGIN_UI_META,
};

/** `resources/read` contents entry for the login view. */
export const LOGIN_UI_RESOURCE_CONTENTS = {
  uri: LOGIN_UI_RESOURCE_URI,
  mimeType: MCP_APPS_MIME_TYPE,
  text: LOGIN_APP_HTML,
  _meta: LOGIN_UI_META,
};
