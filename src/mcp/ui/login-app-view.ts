/**
 * Rendering + orchestration for the login view (../login-app.ts's
 * `<script>` tag, concatenated after ./login-app-protocol.ts inside the
 * same wrapping IIFE — see that file's header for why this can call
 * `onNotification`/`callTool`/`reportSize`/`initializeHost` directly with
 * no import). Split out of login-app.ts purely to keep that file (and this
 * one) under the project's 500-scc-line module cap.
 *
 * Renders five states off one `stage`/outcome: `need_credentials` (a login
 * form, submitted via `callTool('login', …)` — a HUMAN-initiated action),
 * `pin` (a PIN was issued), `cert` (a stored certificate skipped the PIN
 * step), `error`, and a plain cancelled state.
 *
 * This view has never been observed to render on any deployed MCP client —
 * see ../login-app.ts's header for the upstream host bug tracking this. The
 * MODEL, not this view, is always the driver of login completion
 * (../handlers-login.ts always tells it to call `login_complete` itself).
 * Accordingly `pin`/`cert` are display-only: they show the PIN/steps and a
 * note that completion is in progress elsewhere, and do NOT call
 * `login_complete` themselves — a prior version did, which raced the
 * model's own call against this view's for the same `pendingLogin`. There
 * is now exactly one driver.
 *
 * The `success` stage/renderer was NOT kept as a distinct visual (no "Signed
 * in as …" card): this view no longer calls `login_complete` itself, so it
 * has no business rendering that result. `interpretToolResult`'s fallback
 * branch (a `login_complete`-shaped `{ loggedIn, mid, displayName }` JSON
 * with no `structuredContent`) is technically still reachable — the host
 * could in principle forward that tool-result notification even though this
 * view never initiated the call — so it is handled, but only with a plain,
 * non-optimistic `renderDone()` acknowledgement, never a profile card built
 * from data this view did not ask for.
 *
 * The PIN and any error message are untrusted server/host data — written
 * via `textContent`, never `innerHTML`; nothing interpolates into an HTML
 * string anywhere below. All timing numbers arrive via `structuredContent`
 * at render time — none are written into this source.
 */
export const LOGIN_APP_VIEW_JS = `
  var SOURCE_A = 'help.line.me/line/IOSSecondary/?contentId=20018574&lang=zh-Hant';
  var SOURCE_B = 'help.line.me/line/smartphone/pc?lang=zh-Hant&contentId=20000112';

  var app = document.getElementById('app');

  function clear(container) {
    while (container.firstChild) container.removeChild(container.firstChild);
    return container;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function appendPrereq(container) {
    container.appendChild(el('p', 'prereq',
      'Requires: on the primary phone, 設定 > 我的帳號 > 允許自其他裝置登入 must be enabled, '
      + 'or LINE will not offer this device a sign-in prompt at all.'));
  }

  function appendSources(container) {
    var sources = el('p', 'sources', null);
    sources.appendChild(document.createTextNode('Sources: ' + SOURCE_A));
    sources.appendChild(document.createElement('br'));
    sources.appendChild(document.createTextNode(SOURCE_B));
    container.appendChild(sources);
  }

  var countdownTimer = null;

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function renderCountdown(target, totalSeconds, onExpire) {
    stopCountdown();
    var deadline = Date.now() + totalSeconds * 1000;
    function tick() {
      var remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      target.textContent = remaining + 's';
      if (remaining <= 0) {
        stopCountdown();
        onExpire();
      }
    }
    tick();
    countdownTimer = setInterval(tick, 500);
  }

  function afterRender() {
    reportSize();
  }

  function renderIdle() {
    stopCountdown();
    var container = clear(app);
    container.appendChild(el('p', 'idle', 'Waiting for the host.'));
    afterRender();
  }

  function renderError(message) {
    stopCountdown();
    var container = clear(app);
    container.appendChild(el('p', 'error', message || 'Login failed.'));
    afterRender();
  }

  function renderCancelled() {
    stopCountdown();
    var container = clear(app);
    container.appendChild(el('p', 'status', 'Login was cancelled.'));
    afterRender();
  }

  // No dedicated "success" renderer: this view is never the driver of login
  // completion (the model always is, per ../handlers-login.ts), so it has
  // no business rendering a signed-in profile. If a \`login_complete\`
  // tool-result notification ever reaches this view anyway (see
  // interpretToolResult below), it gets this same plain acknowledgement,
  // not a fabricated success card built from data this view did not ask for.
  function renderDone() {
    stopCountdown();
    var container = clear(app);
    container.appendChild(el('p', 'status', 'Sign-in finished. See the conversation for details.'));
    afterRender();
  }

  function renderNeedCredentials(data) {
    stopCountdown();
    var container = clear(app);

    appendPrereq(container);
    container.appendChild(el('p', 'label', 'Sign in to LINE'));

    var form = document.createElement('form');

    var phoneField = el('div', 'form-field');
    phoneField.appendChild(el('label', null, 'Phone number (E.164, e.g. +8869XXXXXXXX)'));
    var phoneInput = document.createElement('input');
    phoneInput.type = 'tel';
    phoneInput.required = true;
    phoneInput.placeholder = '+8869XXXXXXXX';
    phoneField.appendChild(phoneInput);
    form.appendChild(phoneField);

    var regionField = el('div', 'form-field');
    regionField.appendChild(el('label', null, 'Region'));
    var regionSelect = document.createElement('select');
    var regions = Array.isArray(data.regions) ? data.regions : [];
    for (var i = 0; i < regions.length; i++) {
      var option = document.createElement('option');
      option.value = regions[i];
      option.textContent = regions[i];
      regionSelect.appendChild(option);
    }
    regionField.appendChild(regionSelect);
    form.appendChild(regionField);

    var submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'primary';
    submitButton.textContent = 'Continue';
    form.appendChild(submitButton);
    container.appendChild(form);

    var formStatus = el('p', 'status', null);
    formStatus.style.display = 'none';
    container.appendChild(formStatus);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitButton.disabled = true;
      formStatus.style.display = '';
      formStatus.textContent = 'Starting login…';
      callTool('login', { phone: phoneInput.value, region: regionSelect.value }).then(function (result) {
        interpretToolResult(result);
      }).catch(function (error) {
        renderError((error && error.message) || 'Login failed.');
      });
    });

    appendSources(container);
    afterRender();
  }

  function renderPinStage(data) {
    stopCountdown();
    var container = clear(app);

    appendPrereq(container);

    container.appendChild(el('p', 'label', 'LINE login PIN'));
    container.appendChild(el('p', 'pin', data.pin || ''));

    var steps = el('ol', 'steps');
    steps.appendChild(el('li', null, 'Open LINE on your primary phone.'));
    steps.appendChild(el('li', null, 'Enter the PIN shown above.'));
    steps.appendChild(el('li', null, 'Tick the device that is signing in.'));
    steps.appendChild(el('li', null, 'Tap 「用戶確認」.'));
    steps.appendChild(el('li', null, 'Approve the new device when the primary phone asks.'));
    container.appendChild(steps);

    var pinStatus = el('p', 'status');
    var pinLabel = document.createTextNode('Time left to enter the code: ');
    var pinCount = el('span', 'countdown');
    pinStatus.appendChild(pinLabel);
    pinStatus.appendChild(pinCount);
    container.appendChild(pinStatus);

    var clientPinMinutes = Math.round(data.clientPinPollCeilingSeconds / 60);
    container.appendChild(el('p', 'note',
      'yomi keeps listening for about ' + clientPinMinutes + ' minutes, so a slow phone is not a '
      + 'problem — the code\\'s own 3-minute limit above is the real deadline.'));
    container.appendChild(el('p', 'note',
      'This PIN step is skipped on future logins once a login certificate has been stored.'));

    var pinSeconds = data.pinCodeLifetimeSeconds;
    renderCountdown(pinCount, pinSeconds, function () {
      pinStatus.replaceChild(document.createTextNode('The code has expired. '), pinLabel);
      pinCount.textContent = '';
      container.appendChild(el('p', 'error', 'This code is no longer valid. Call login again to get a new one.'));
      afterRender();
    });

    container.appendChild(el('p', 'note', 'The assistant is completing this sign-in; the result will appear in the conversation.'));

    appendSources(container);
    afterRender();
  }

  function renderCertStage(data) {
    stopCountdown();
    var container = clear(app);

    appendPrereq(container);

    container.appendChild(el('p', 'label', 'Device approval'));
    container.appendChild(el('p', 'status',
      'No PIN is needed — a stored login certificate from a previous login was recognised.'));

    var steps = el('ol', 'steps');
    steps.appendChild(el('li', null, 'Open LINE on your primary phone.'));
    steps.appendChild(el('li', null, 'Approve the new device when it asks.'));
    container.appendChild(steps);

    var approvalStatus = el('p', 'status');
    var approvalLabel = document.createTextNode('yomi is waiting for approval: ');
    var approvalCount = el('span', 'countdown');
    approvalStatus.appendChild(approvalLabel);
    approvalStatus.appendChild(approvalCount);
    container.appendChild(approvalStatus);

    var approvalSeconds = data.clientApprovalPollCeilingSeconds;
    renderCountdown(approvalCount, approvalSeconds, function () {
      approvalStatus.replaceChild(document.createTextNode('yomi has stopped waiting for approval. '), approvalLabel);
      approvalCount.textContent = '';
    });

    container.appendChild(el('p', 'note', 'The assistant is completing this sign-in; the result will appear in the conversation.'));

    appendSources(container);
    afterRender();
  }

  function extractText(content) {
    if (!Array.isArray(content)) return null;
    for (var i = 0; i < content.length; i++) {
      if (content[i] && content[i].type === 'text' && typeof content[i].text === 'string') {
        return content[i].text;
      }
    }
    return null;
  }

  function parseJsonText(text) {
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text);
    }
    catch (error) {
      return null;
    }
  }

  function renderFromStage(data) {
    if (data.stage === 'need_credentials') renderNeedCredentials(data);
    else if (data.stage === 'pin') renderPinStage(data);
    else if (data.stage === 'cert') renderCertStage(data);
    else renderError(typeof data.message === 'string' ? data.message : 'Login failed.');
  }

  /**
   * Interpret one CallToolResult-shaped object (from either a
   * \`ui/notifications/tool-result\` notification or the direct response
   * to this view's own \`tools/call\`) and render accordingly.
   */
  function interpretToolResult(toolResult) {
    if (!toolResult || typeof toolResult !== 'object') {
      renderError('No result received.');
      return;
    }
    if (toolResult.isError) {
      renderError(extractText(toolResult.content) || 'The tool reported an error.');
      return;
    }
    if (toolResult.structuredContent && typeof toolResult.structuredContent === 'object') {
      renderFromStage(toolResult.structuredContent);
      return;
    }
    // login_complete's success result has no structuredContent — its JSON
    // ({ loggedIn, mid, displayName }) is in content[0].text. This view is
    // never the one that called login_complete (the model always is), so it
    // only ever sees this if the host independently forwards that result —
    // acknowledge it plainly rather than build a success card from it.
    var parsed = parseJsonText(extractText(toolResult.content));
    if (parsed && parsed.loggedIn) {
      renderDone();
      return;
    }
    renderError('Unrecognized tool result.');
  }

  /**
   * A \`ui/notifications/tool-result\` notification's \`params\` may carry
   * the CallToolResult directly, or nested under a \`result\`/\`toolResult\`/
   * \`output\` wrapper — the spec does not pin down one exact shape, so this
   * checks for either without assuming.
   */
  function unwrapToolResult(params) {
    if (!params || typeof params !== 'object') return null;
    if (params.content || params.structuredContent || params.isError !== undefined) return params;
    var candidates = [params.result, params.toolResult, params.output];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && typeof candidates[i] === 'object') return candidates[i];
    }
    return null;
  }

  onNotification('ui/notifications/tool-result', function (params) {
    interpretToolResult(unwrapToolResult(params));
  });

  onNotification('ui/notifications/tool-cancelled', function () {
    renderCancelled();
  });

  renderIdle();
  initializeHost(function (hostContext, error) {
    if (error) {
      renderError('Could not connect to host: ' + ((error && error.message) || String(error)));
    }
    // Otherwise stay idle — the next thing to arrive is
    // ui/notifications/tool-input(-partial) (ignored, carries only the call's
    // arguments) followed by tool-result, which drives the first real render.
  });
`;
