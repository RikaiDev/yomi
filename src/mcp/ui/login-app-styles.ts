/**
 * CSS for the login view (../login-app.ts's `<style>` block). Split out
 * purely to keep login-app.ts under the project's 500-scc-line module cap
 * as this view grew from a read-only display into one that also renders a
 * credentials form and drives its own tool calls.
 *
 * Color scheme: `prefers-color-scheme` is the fallback (kept from before
 * this file existed), but `html.theme-dark` / `html.theme-light` — applied
 * by ./login-app-protocol.ts from the host's `hostContext.theme` once
 * `ui/initialize` resolves — take precedence via ordinary selector
 * specificity (a class selector always outranks a media-qualified type
 * selector), so an authoritative host theme always wins over the guess.
 */
export const LOGIN_APP_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1c1c1e;
  }
  @media (prefers-color-scheme: dark) {
    html, body { color: #ececec; }
  }
  html.theme-dark, html.theme-dark body { color: #ececec; }
  html.theme-light, html.theme-light body { color: #1c1c1e; }
  main {
    padding: 20px 24px;
    max-width: 420px;
    margin: 0 auto;
  }
  .prereq {
    font-size: 12px;
    opacity: 0.65;
    line-height: 1.5;
    margin: 0 0 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(127, 127, 127, 0.18);
  }
  .label {
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.6;
    margin: 0 0 8px;
  }
  .pin {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 40px;
    font-weight: 600;
    letter-spacing: 0.12em;
    user-select: text;
    -webkit-user-select: text;
    padding: 14px 0;
    margin: 0 0 20px;
    border-radius: 12px;
    text-align: center;
    background: rgba(127, 127, 127, 0.12);
  }
  .steps {
    margin: 0 0 20px;
    padding-left: 20px;
    line-height: 1.6;
  }
  .steps li { margin-bottom: 6px; }
  .status {
    font-size: 14px;
    opacity: 0.85;
    padding: 10px 14px;
    border-radius: 10px;
    background: rgba(127, 127, 127, 0.10);
    margin: 0 0 12px;
  }
  .idle {
    font-size: 13px;
    opacity: 0.55;
    margin: 0;
  }
  .countdown {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .note {
    font-size: 12px;
    opacity: 0.6;
    line-height: 1.5;
    margin: 16px 0 0;
  }
  .sources {
    font-size: 11px;
    opacity: 0.45;
    line-height: 1.6;
    margin: 20px 0 0;
    padding-top: 12px;
    border-top: 1px solid rgba(127, 127, 127, 0.18);
    word-break: break-all;
  }
  .error {
    font-size: 14px;
    padding: 12px 14px;
    border-radius: 10px;
    background: rgba(127, 127, 127, 0.14);
  }
  .form-field {
    margin: 0 0 14px;
  }
  .form-field label {
    display: block;
    font-size: 12px;
    opacity: 0.65;
    margin: 0 0 6px;
  }
  .form-field input,
  .form-field select {
    width: 100%;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid rgba(127, 127, 127, 0.3);
    background: transparent;
    color: inherit;
    font-size: 14px;
    font-family: inherit;
  }
  button.primary {
    width: 100%;
    padding: 12px;
    border: none;
    border-radius: 10px;
    background: rgba(127, 127, 127, 0.16);
    color: inherit;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  button.primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
`;
