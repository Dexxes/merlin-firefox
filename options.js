'use strict';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// t, sleep, getCredentials, setCredentials, clearCredentials,
// originPatternFor, sameOrigin, serverBase and isAllowedServerUrl come from
// common.js.

// The URL as typed, trimmed and without a trailing slash.
function readServerUrl() {
  return serverBase($('nextcloudUrl').value.trim());
}

function showCloseButton() {
  const existing = $('closeTabBtn');
  if (existing) { existing.style.display = 'inline-flex'; return; }

  const btn = document.createElement('button');
  btn.id        = 'closeTabBtn';
  btn.className = 'btn btn-close-tab';
  btn.textContent = t('options_closeTab');
  btn.addEventListener('click', () => window.close());
  $('status').appendChild(btn);
}

function showStatus(message, type /* 'success' | 'error' | 'info' */, durationMs = 5000) {
  const wrap = $('status');
  const icon = $('statusIcon');
  const text = $('statusText');

  const icons = { success: '✓', error: '✕', info: '…' };

  icon.textContent = icons[type] ?? '•';
  text.textContent = message;
  wrap.className   = `status visible ${type}`;

  clearTimeout(showStatus._timer);
  if (durationMs > 0) {
    showStatus._timer = setTimeout(() => { wrap.className = 'status'; }, durationMs);
  }
}

// ─── Runtime host permission for the user's server ───────────────────────────
//
// host_permissions are only optional (manifest.json) instead of a standing
// <all_urls> grant — the extension requests exactly the origin the user
// configures as their server. This works here because the request is made
// from within a button click (user gesture).
//
// backendKind: 'nextcloud' (default) or 'standalone' (merlin-server).

async function ensureHostPermission(url) {
  const origin = originPatternFor(url);
  if (!origin) return false;
  // No permissions.contains() pre-check: request() resolves immediately
  // without a prompt when the permission is already granted. An await before
  // it would break the click's user gesture — Firefox requires an
  // uninterrupted gesture for permissions.request(), otherwise it throws
  // "permissions.request may only be called from a user input handler".
  return browser.permissions.request({ origins: [origin] });
}

// ─── Nextcloud Login Flow v2 ──────────────────────────────────────────────────
//
// The options page handles:
//   1. POST {nextcloudUrl}/index.php/login/v2  →  { login, poll: { token, endpoint } }
//   2. Open the `login` URL in a new tab
//   3. Hand off polling to the background script — it survives the toolbar
//      popup closing when the new login tab takes focus
//   4. React to the result written to storage by the background script
//
// The button doubles as a cancel button while a flow is in progress.

let _lfActive = false;

function selectedBackendKind() {
  return document.querySelector('input[name="backendKind"]:checked')?.value || 'nextcloud';
}

// "Login with Nextcloud" only makes sense for the Nextcloud backend — the
// standalone server has no Nextcloud account behind it, so it gets a neutral label.
function loginButtonLabel() {
  return backendText('options_loginButton', 'options_loginButtonStandalone');
}

// Several hints name the "Login with Nextcloud" button; the standalone
// backend has its own wording with the neutral "Log in" button.
function backendText(nextcloudKey, standaloneKey) {
  return t(selectedBackendKind() === 'standalone' ? standaloneKey : nextcloudKey);
}

function setLoginButtonText(text) {
  $('loginFlowBtn').querySelector('span').textContent = text;
}

function updateLoginButtonLabel() {
  if (_lfActive) return; // don't clobber the "Cancel login…" label mid-flow
  setLoginButtonText(loginButtonLabel());
}

// Marks a login flow as running (button becomes "Cancel login…") or as idle.
function setLoginFlowActive(active) {
  _lfActive = active;
  setLoginButtonText(active ? t('options_cancelLogin') : loginButtonLabel());
}

function _lfReset() {
  setLoginFlowActive(false);
}

function cancelLoginFlow() {
  if (!_lfActive) return;
  _lfReset();
  browser.runtime.sendMessage({ type: 'merlin:cancelLoginPoll' }).catch(() => {});
  showStatus(t('options_loginCancelled'), 'info');
}

async function startLoginFlow() {
  // Toggle: clicking the button again cancels an in-progress flow
  if (_lfActive) { cancelLoginFlow(); return; }

  const url = readServerUrl();
  if (!url) {
    showStatus(t('options_enterUrlFirst'), 'error');
    $('nextcloudUrl').focus();
    return;
  }

  // Plain http:// only for localhost (local development). The check is
  // synchronous, so it does not break the user gesture.
  if (!isAllowedServerUrl(url)) {
    showStatus(t('options_httpBlocked'), 'error');
    $('nextcloudUrl').focus();
    return;
  }

  const backendKind = selectedBackendKind();

  setLoginFlowActive(true);

  // ── Step 0: request access to this specific server only ────────────────────
  // Right at the start, before any await, so the request still happens
  // within the click gesture.
  if (!(await ensureHostPermission(url))) {
    _lfReset();
    showStatus(t('options_needsPermission'), 'error');
    return;
  }

  showStatus(backendText('options_connecting', 'options_connectingShort'), 'info', 0);

  // ── Step 1: initiate ────────────────────────────────────────────────────────
  // merlin-server mirrors Nextcloud's Login Flow v2 JSON exactly (see
  // merlin-server/src/Controller/LoginFlowController.php) — only the start
  // URL differs, polling and parsing stay the same.
  let loginUrl, pollToken, pollEndpoint;
  try {
    const loginFlowPath = backendKind === 'standalone' ? '/login/v2' : '/index.php/login/v2';
    const r = await fetch(`${url}${loginFlowPath}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    loginUrl     = d?.login;
    pollToken    = d?.poll?.token;
    pollEndpoint = d?.poll?.endpoint;
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotReach', [e.message]), 'error');
    return;
  }
  if (!_lfActive) return;

  // Validate the response: the login page must be encrypted (or localhost),
  // and the poll token may only go back to the server the user entered —
  // the poll response carries the new app password.
  if (typeof pollToken !== 'string' || !pollToken
      || !isAllowedServerUrl(loginUrl)
      || !isAllowedServerUrl(pollEndpoint) || !sameOrigin(pollEndpoint, url)) {
    _lfReset();
    showStatus(t('options_loginInvalidResponse'), 'error');
    return;
  }

  // ── Step 2: open login tab ───────────────────────────────────────────────────
  let loginTabId = null;
  try {
    const tab = await browser.tabs.create({ url: loginUrl });
    loginTabId = tab.id;
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotOpenLogin', [e.message]), 'error');
    return;
  }
  showStatus(t('options_completeLogin'), 'info', 0);

  // ── Step 3: hand polling off to the background script ─────────────────────
  try {
    await browser.runtime.sendMessage({
      type:         'merlin:startLoginPoll',
      pollEndpoint,
      pollToken,
      serverUrl:    url,
      loginTabId,
      backendKind,
    });
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotStartPolling', [e.message]), 'error');
  }
}

// ── Step 4: react to background result ────────────────────────────────────────

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes._merlinLoginFlowResult) return;

  const result = changes._merlinLoginFlowResult.newValue;
  if (!result) return;

  // Clean up immediately so stale results don't fire on next open
  browser.storage.local.remove('_merlinLoginFlowResult').catch(() => {});

  _lfReset();

  if (result.cancelled) {
    return;
  }

  if (result.error) {
    showStatus(result.error, 'error');
    return;
  }

  if (result.success) {
    $('nextcloudUrl').value = result.serverUrl;
    showStatus(t('options_loggedInAs', [result.loginName]), 'success', 0);
    showCloseButton();
    updateLogoutButton(true);
  }
});

// Keeps a visible welcome hint in line with the selected backend, since it
// names that backend's login button.
const WELCOME_KEYS = [
  ['options_welcome', 'options_welcomeStandalone'],
  ['options_loggedOutWelcome', 'options_loggedOutWelcomeStandalone'],
];

function refreshWelcomeText() {
  const current = $('statusText').textContent;
  for (const [nextcloudKey, standaloneKey] of WELCOME_KEYS) {
    if (current === t(nextcloudKey) || current === t(standaloneKey)) {
      $('statusText').textContent = backendText(nextcloudKey, standaloneKey);
      return;
    }
  }
}

// ─── Load saved settings ──────────────────────────────────────────────────────

async function loadSettings() {
  const { nextcloudUrl, username, appPassword, backendKind } = await getCredentials();

  if (nextcloudUrl) $('nextcloudUrl').value = nextcloudUrl;
  const radio = document.querySelector(`input[name="backendKind"][value="${backendKind === 'standalone' ? 'standalone' : 'nextcloud'}"]`);
  if (radio) radio.checked = true;
  updateLoginButtonLabel();

  // Show welcome hint when the page is opened and no credentials are stored yet
  if (!nextcloudUrl && !username && !appPassword) {
    showStatus(backendText('options_welcome', 'options_welcomeStandalone'), 'info', 0);
  }

  updateLogoutButton(!!(username && appPassword));

  // Restore in-progress UI state if the background is still polling
  const { _merlinLoginFlow } = await browser.storage.local.get('_merlinLoginFlow');
  // An expired flow (e.g. because Firefox unloaded the background page) no
  // longer counts as active; the background script cleans it up on its next
  // alarm.
  if (_merlinLoginFlow?.active && Date.now() <= (_merlinLoginFlow.deadline ?? 0)) {
    setLoginFlowActive(true);
    showStatus(t('options_completeLogin'), 'info', 0);
  }
}

// ─── Save settings (URL only, before login) ──────────────────────────────────

async function saveSettings() {
  const url = readServerUrl();

  if (!url) {
    showStatus(t('options_enterUrlPlain'), 'error');
    return;
  }

  if (!isAllowedServerUrl(url)) {
    showStatus(t('options_httpBlocked'), 'error');
    return;
  }

  try {
    await setCredentials({ nextcloudUrl: url, backendKind: selectedBackendKind() });
    showStatus(backendText('options_urlSaved', 'options_urlSavedStandalone'), 'success', 0);
    showCloseButton();
  } catch (e) {
    showStatus(t('options_couldNotSave', [e.message]), 'error');
  }
}

// ─── Logout ───────────────────────────────────────────────────────────────────

function updateLogoutButton(hasCredentials) {
  const btn = $('logoutBtn');
  if (!btn) return;
  btn.style.display = hasCredentials ? 'block' : 'none';
}

async function logout() {
  await clearCredentials();

  // Reset the UI to the "not connected" state of a first start
  $('nextcloudUrl').value = '';
  updateLogoutButton(false);
  showStatus(backendText('options_loggedOutWelcome', 'options_loggedOutWelcomeStandalone'), 'info', 0);
}

// ─── Keyboard shortcut: Ctrl/Cmd+S saves ─────────────────────────────────────

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveSettings();
  }
});

// ─── Wire everything up ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  $('loginFlowBtn').addEventListener('click', startLoginFlow);
  $('saveBtn').addEventListener('click', saveSettings);
  $('logoutBtn').addEventListener('click', logout);

  document.querySelectorAll('input[name="backendKind"]').forEach(radio => {
    radio.addEventListener('change', () => {
      updateLoginButtonLabel();
      refreshWelcomeText();
    });
  });
});
