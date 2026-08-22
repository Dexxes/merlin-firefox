'use strict';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// i18n-Kürzel: liest lokalisierte Strings aus _locales/<lang>/messages.json
// (generiert via tools/i18n/export.py). `subs` mappt auf die $1/$2-Platzhalter.
const t = (key, subs) => browser.i18n.getMessage(key, subs);

// ─── Nextcloud URL — HTTPS erzwungen ────────────────────────────────────────
// Das Eingabefeld zeigt nur noch den Host/Pfad an; "https://" steht als
// fixes Präfix davor (siehe options.html, .url-prefix) und ist dem Nutzer so
// gar nicht erst eintippbar. Falls trotzdem ein Protokoll mit eingefügt
// wird (z. B. per Copy-Paste einer vollen URL), wird es hier entfernt.
function stripProtocol(value) {
  return (value || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function getFullNextcloudUrl() {
  const cleaned = stripProtocol($('nextcloudUrl').value);
  return cleaned ? `https://${cleaned}` : '';
}

function setNextcloudUrlInput(fullUrl) {
  $('nextcloudUrl').value = stripProtocol(fullUrl);
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

// ─── Storage helpers ───────────────────────────────────────────────────────────
//
// storage.sync ist die bevorzugte Ablage: Mozilla verschlüsselt sie serverseitig
// Ende-zu-Ende (Teil der Firefox-Sync-Infrastruktur, Schlüssel pro Firefox-Konto,
// für Mozilla selbst nicht einsehbar). Das App-Passwort wird so automatisch und
// geschützt auf alle Geräte verteilt — ohne eigene Passphrase. Ist storage.sync
// nicht verfügbar (kein Firefox-Konto angemeldet), dient storage.local als
// rein lokaler Fallback.

// backendKind: 'nextcloud' (Default, Bestandsschutz für bereits verbundene
// Installationen ohne gespeicherten Wert) oder 'standalone' (merlin-server).
// Steuert API-URL-Präfix und Login-Flow-Start-URL, siehe saveToMerlin()/
// startLoginFlow() weiter unten.
async function getCredentials() {
  try {
    const synced = await browser.storage.sync.get(['nextcloudUrl', 'username', 'appPassword', 'backendKind']);
    if (synced.nextcloudUrl || synced.username || synced.appPassword) return synced;
  } catch { /* storage.sync evtl. nicht verfügbar */ }
  return browser.storage.local.get(['nextcloudUrl', 'username', 'appPassword', 'backendKind']);
}

async function setCredentials(fields) {
  try {
    await browser.storage.sync.set(fields);
  } catch {
    await browser.storage.local.set(fields);
  }
}

async function clearCredentials() {
  try { await browser.storage.sync.remove(['nextcloudUrl', 'username', 'appPassword']); } catch { /* ignore */ }
  await browser.storage.local.remove(['nextcloudUrl', 'username', 'appPassword']);
}

// ─── Runtime host permission for the user's Nextcloud server ─────────────────
//
// host_permissions ist nur noch optional (manifest.json) statt pauschal
// <all_urls> — die Erweiterung fragt stattdessen genau die Origin an, die der
// Nutzer als Nextcloud-Server konfiguriert. Das funktioniert hier, weil der
// Request innerhalb eines Button-Klicks (User-Geste) ausgelöst wird.
function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function ensureHostPermission(url) {
  const origin = originPatternFor(url);
  if (!origin) return false;
  if (await browser.permissions.contains({ origins: [origin] })) return true;
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
  return selectedBackendKind() === 'standalone' ? t('options_loginButtonStandalone') : t('options_loginButton');
}

function updateLoginButtonLabel() {
  if (_lfActive) return; // don't clobber the "Cancel login…" label mid-flow
  $('loginFlowBtn').querySelector('span').textContent = loginButtonLabel();
}

function _lfReset() {
  _lfActive = false;
  $('loginFlowBtn').querySelector('span').textContent = loginButtonLabel();
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

  const url = getFullNextcloudUrl();
  if (!url) {
    showStatus(t('options_enterUrlFirst'), 'error');
    $('nextcloudUrl').focus();
    return;
  }

  const backendKind = selectedBackendKind();

  _lfActive = true;
  $('loginFlowBtn').querySelector('span').textContent = t('options_cancelLogin');

  // ── Step 0: request access to this specific server only ────────────────────
  // Direkt am Anfang, ohne vorherige awaits, damit der Request noch innerhalb
  // der Klick-Geste ausgelöst wird.
  if (!(await ensureHostPermission(url))) {
    _lfReset();
    showStatus(t('options_needsPermission'), 'error');
    return;
  }

  showStatus(t('options_connecting'), 'info', 0);

  // ── Step 1: initiate ────────────────────────────────────────────────────────
  // merlin-server bildet Nextclouds Login-Flow-v2-JSON identisch nach (siehe
  // merlin-server/src/Controller/LoginFlowController.php) - nur die Start-URL
  // unterscheidet sich, Polling/Parsing bleibt unverändert.
  let loginUrl, pollToken, pollEndpoint;
  try {
    const loginFlowPath = backendKind === 'standalone' ? '/login/v2' : '/index.php/login/v2';
    const r = await fetch(`${url}${loginFlowPath}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    loginUrl     = d.login;
    pollToken    = d.poll.token;
    pollEndpoint = d.poll.endpoint;
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotReach', [e.message]), 'error');
    return;
  }
  if (!_lfActive) return;

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
    setNextcloudUrlInput(result.serverUrl);
    showStatus(t('options_loggedInAs', [result.loginName]), 'success', 0);
    showCloseButton();
    updateLogoutButton(true);
  }
});

// ─── Load saved settings ──────────────────────────────────────────────────────

async function loadSettings() {
  const { nextcloudUrl, username, appPassword, backendKind } = await getCredentials();

  if (nextcloudUrl) setNextcloudUrlInput(nextcloudUrl);
  const radio = document.querySelector(`input[name="backendKind"][value="${backendKind === 'standalone' ? 'standalone' : 'nextcloud'}"]`);
  if (radio) radio.checked = true;
  updateLoginButtonLabel();

  // Show welcome hint when the page is opened and no credentials are stored yet
  if (!nextcloudUrl && !username && !appPassword) {
    showStatus(t('options_welcome'), 'info', 0);
  }

  updateLogoutButton(!!(username && appPassword));

  // Restore in-progress UI state if the background is still polling
  const { _merlinLoginFlow } = await browser.storage.local.get('_merlinLoginFlow');
  if (_merlinLoginFlow?.active) {
    _lfActive = true;
    $('loginFlowBtn').querySelector('span').textContent = t('options_cancelLogin');
    showStatus(t('options_completeLogin'), 'info', 0);
  }
}

// ─── Save settings (URL only, before login) ──────────────────────────────────

async function saveSettings() {
  const url = getFullNextcloudUrl();

  if (!url) {
    showStatus(t('options_enterUrlPlain'), 'error');
    return;
  }

  try {
    await setCredentials({ nextcloudUrl: url, backendKind: selectedBackendKind() });
    showStatus(t('options_urlSaved'), 'success', 0);
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

  // UI zurück in den "nicht verbunden"-Zustand wie beim ersten Start
  $('nextcloudUrl').value = '';
  updateLogoutButton(false);
  showStatus(t('options_loggedOutWelcome'), 'info', 0);
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
    radio.addEventListener('change', updateLoginButtonLabel);
  });
});
