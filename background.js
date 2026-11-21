'use strict';

// Gemeinsame Helfer (t, sleep, getCredentials, setCredentials,
// clearCredentials, originPatternFor, sameOrigin, isAllowedServerUrl,
// recordAuthFailure, resetAuthFailures) kommen aus common.js, das laut
// manifest.json vor dieser Datei geladen wird.

const MENU_ID_LINK      = 'merlin-send-link';
const MENU_ID_LINK_TAGS = 'merlin-send-link-tags';
const MENU_ID_PAGE      = 'merlin-save-page';
const MENU_ID_PAGE_TAGS = 'merlin-save-page-tags';

// Obergrenze für das mitgeschickte Seiten-HTML. Größere Seiten (z. B. mit
// eingebetteten data:-Bildern) werden nur als URL gespeichert, der Server
// lädt sie dann selbst.
const MAX_HTML_BYTES = 10 * 1024 * 1024;

// Timeouts für Server-Anfragen. Das Speichern bekommt mehr Zeit, weil bis zu
// 10 MB HTML hochgeladen werden können.
const SAVE_TIMEOUT_MS = 60_000;
const TAGS_TIMEOUT_MS = 10_000;

const PENDING_SAVE_PREFIX = '_merlinPendingSave_';
const LOGIN_POLL_ALARM    = 'merlin-login-poll';

// ─── Logo as base64 data URL ──────────────────────────────────────────────────
// Pages block moz-extension:// URLs via CSP, so we convert the icon once to
// an inline data URL and pass it as an argument into the injected function.

let _logoDataUrl = null;

async function getLogoDataUrl() {
  if (_logoDataUrl) return _logoDataUrl;
  try {
    const resp = await fetch(browser.runtime.getURL('icons/icon-128.png'));
    const blob = await resp.blob();
    _logoDataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch {
    _logoDataUrl = ''; // no logo on error — flyout still works
  }
  return _logoDataUrl;
}

// ─── Migration: storage.local → storage.sync ──────────────────────────────────
//
// Eine frühere Fix-Runde hatte Zugangsdaten nach storage.local verschoben, in
// der irrtümlichen Annahme, storage.sync sei unverschlüsselt. Tatsächlich
// verschlüsselt Mozilla storage.sync Ende-zu-Ende — wir holen bestehende
// lokale Zugangsdaten daher einmalig zurück nach storage.sync. Verwaiste
// Crypto-Reste (encPassphrase/credEnc) werden ebenfalls aufgeräumt.
async function migrateCredentialsToSync() {
  try {
    const local = await browser.storage.local.get(['nextcloudUrl', 'username', 'appPassword', 'backendKind']);
    if (local.nextcloudUrl || local.username || local.appPassword) {
      await browser.storage.sync.set(local);
      await browser.storage.local.remove(['nextcloudUrl', 'username', 'appPassword', 'backendKind']);
    } else if (local.backendKind) {
      // Reparatur für Installationen, bei denen eine ältere Version dieser
      // Migration backendKind in storage.local zurückgelassen hatte.
      await browser.storage.sync.set({ backendKind: local.backendKind });
      await browser.storage.local.remove('backendKind');
    }
    await browser.storage.local.remove(['encPassphrase', '_merlinPendingSave']);
    await browser.storage.sync.remove('credEnc');
  } catch {
    // storage.sync evtl. nicht verfügbar — Zugangsdaten bleiben dann lokal
  }
}

browser.runtime.onInstalled.addListener(migrateCredentialsToSync);
browser.runtime.onStartup.addListener(migrateCredentialsToSync);

// ─── Login Flow polling ───────────────────────────────────────────────────────
//
// Das Polling läuft im Hintergrundskript, nicht in der Options-Seite: Firefox
// öffnet die Options-Seite per Toolbar-Klick als Popup, das sich schließt,
// sobald der Login-Tab den Fokus bekommt. Das Ergebnis landet in
// storage.local, von wo aus die Options-Seite es per storage.onChanged abholt.
//
// Unter Manifest V3 ist das Hintergrundskript eine nicht-persistente Event
// Page, die Firefox jederzeit beenden kann. Der komplette Flow-Zustand liegt
// deshalb in storage.local (_merlinLoginFlow), und ein Alarm weckt die Seite
// alle 30 s auf. Läuft dann kein Polling mehr im Speicher, wird es aus dem
// gespeicherten Zustand fortgesetzt; ist die Frist abgelaufen, endet der Flow
// mit einer Timeout-Meldung statt still hängen zu bleiben.

const LOGIN_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

let _lfTimer  = null;
let _lfActive = false;

async function startBackgroundLoginPoll({ pollEndpoint, pollToken, serverUrl, loginTabId, backendKind }) {
  _lfStopTimer();

  // Das Poll-Token (und die Antwort mit dem App-Passwort) darf nur mit dem
  // Server ausgetauscht werden, den der Nutzer eingegeben hat.
  if (typeof pollToken !== 'string' || !pollToken
      || !sameOrigin(pollEndpoint, serverUrl) || !isAllowedServerUrl(pollEndpoint)) {
    await browser.storage.local.set({ _merlinLoginFlowResult: { error: t('options_loginInvalidResponse') } });
    return;
  }

  const flow = {
    active: true,
    loginTabId,
    pollEndpoint,
    pollToken,
    serverUrl,
    backendKind,
    deadline: Date.now() + LOGIN_FLOW_TIMEOUT_MS,
  };
  await browser.storage.local.set({ _merlinLoginFlow: flow });
  browser.alarms.create(LOGIN_POLL_ALARM, { periodInMinutes: 0.5 });

  _lfRun(flow, 2000);
}

function _lfStopTimer() {
  _lfActive = false;
  clearTimeout(_lfTimer);
  _lfTimer = null;
}

function _lfRun(flow, delayMs) {
  _lfActive = true;

  async function poll() {
    if (!_lfActive) return;

    if (Date.now() > flow.deadline) {
      await _lfFinish({ error: t('options_loginTimeout') });
      return;
    }

    try {
      const r = await fetch(flow.pollEndpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `token=${encodeURIComponent(flow.pollToken)}`,
        signal:  AbortSignal.timeout(5_000),
      });

      if (r.status === 404) {
        // Not yet authorised — check again in 2 s
        if (_lfActive) _lfTimer = setTimeout(poll, 2000);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const creds = await r.json();
      if (!_lfActive) return;

      await _lfFinish({ creds, serverUrl: flow.serverUrl, backendKind: flow.backendKind });
    } catch {
      // Transient network error — keep retrying
      if (_lfActive) _lfTimer = setTimeout(poll, 2000);
    }
  }

  _lfTimer = setTimeout(poll, delayMs);
}

// Setzt einen gespeicherten Flow fort, falls die Event Page zwischenzeitlich
// beendet wurde (Alarm) oder der Browser neu gestartet hat (onStartup).
async function resumeBackgroundLoginPoll() {
  if (_lfActive) return;
  const { _merlinLoginFlow: flow } = await browser.storage.local.get('_merlinLoginFlow');
  if (!flow?.active) {
    await browser.alarms.clear(LOGIN_POLL_ALARM);
    return;
  }
  if (Date.now() > flow.deadline) {
    await _lfFinish({ error: t('options_loginTimeout') });
    return;
  }
  _lfRun(flow, 0);
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOGIN_POLL_ALARM) resumeBackgroundLoginPoll();
});
browser.runtime.onStartup.addListener(resumeBackgroundLoginPoll);

async function cancelBackgroundLoginPoll() {
  _lfStopTimer();
  await browser.alarms.clear(LOGIN_POLL_ALARM);
  await browser.storage.local.remove('_merlinLoginFlow');
  await browser.storage.local.set({ _merlinLoginFlowResult: { cancelled: true } });
}

async function _lfFinish({ creds, serverUrl, backendKind, error }) {
  _lfStopTimer();
  await browser.alarms.clear(LOGIN_POLL_ALARM);

  const { _merlinLoginFlow } = await browser.storage.local.get('_merlinLoginFlow');
  const loginTabId = _merlinLoginFlow?.loginTabId;
  await browser.storage.local.remove('_merlinLoginFlow');

  if (!error) {
    const valid = creds
      && typeof creds.loginName === 'string' && creds.loginName
      && typeof creds.appPassword === 'string' && creds.appPassword;
    if (!valid) error = t('options_loginInvalidResponse');
  }

  if (error) {
    await browser.storage.local.set({ _merlinLoginFlowResult: { error } });
    return;
  }

  // Die Poll-Response darf die Server-URL nur ersetzen, wenn sie zur selben
  // Origin gehört wie die ursprünglich eingegebene URL — sonst könnte ein
  // kompromittierter Server künftigen Save-Traffic (samt neu ausgestelltem
  // App-Passwort) stillschweigend auf eine andere Origin umleiten.
  const finalServerUrl = (sameOrigin(creds.server, serverUrl) ? creds.server : serverUrl).replace(/\/$/, '');
  await setCredentials({
    nextcloudUrl: finalServerUrl,
    username:     creds.loginName,
    appPassword:  creds.appPassword,
    backendKind,
  });
  await resetAuthFailures();

  // Close the Nextcloud login tab
  if (loginTabId != null) browser.tabs.remove(loginTabId).catch(() => {});

  // Notify options page via storage (falls sie noch offen ist)
  await browser.storage.local.set({
    _merlinLoginFlowResult: {
      success:     true,
      serverUrl:   finalServerUrl,
      loginName:   creds.loginName,
    },
  });

  // Automatisch zurück zu den Einstellungen: fokussiert eine bereits offene
  // Options-Seite oder öffnet sie neu.
  browser.runtime.openOptionsPage().catch(() => {});
}

// ─── Message handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  // Nur Nachrichten von der eigenen Extension akzeptieren (z. B. der
  // Options-Seite) — verhindert, dass ein künftig hinzugefügtes Content-Script
  // oder eine andere Extension startBackgroundLoginPoll() mit eigenen
  // pollEndpoint/serverUrl-Werten aufrufen könnte.
  if (sender.id !== browser.runtime.id) return;

  if (msg.type === 'merlin:startLoginPoll') {
    startBackgroundLoginPoll(msg);
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:cancelLoginPoll') {
    cancelBackgroundLoginPoll();
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:saveWithTags') {
    handleSaveWithTags(msg.saveId, msg.tags ?? []);
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:cancelSave') {
    takePendingSave(msg.saveId).then(p => {
      if (p?.windowId != null) browser.windows.remove(p.windowId).catch(() => {});
    });
    return Promise.resolve({ ok: true });
  }
});

// ─── Pending saves (Tag-Dialog) ───────────────────────────────────────────────
//
// Jeder geöffnete Tag-Dialog bekommt einen eigenen Eintrag (eigene ID statt
// eines globalen Slots), damit sich mehrere offene Dialoge nicht gegenseitig
// überschreiben. Der Eintrag enthält bewusst keine Zugangsdaten — die werden
// beim eigentlichen Speichern frisch über getCredentials() gelesen. Wird der
// Dialog über das Fenster-X geschlossen, räumt windows.onRemoved den Eintrag
// auf; beim Browserstart werden Reste vom letzten Lauf entfernt.

function pendingSaveKey(saveId) {
  return `${PENDING_SAVE_PREFIX}${saveId}`;
}

async function takePendingSave(saveId) {
  if (typeof saveId !== 'string' || !saveId) return null;
  const key = pendingSaveKey(saveId);
  const { [key]: pending } = await browser.storage.local.get(key);
  await browser.storage.local.remove(key);
  return pending ?? null;
}

async function removePendingSaves(filter) {
  const all = await browser.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(PENDING_SAVE_PREFIX) && filter(all[k]));
  if (keys.length) await browser.storage.local.remove(keys);
}

browser.windows.onRemoved.addListener((windowId) => {
  removePendingSaves(p => p?.windowId === windowId).catch(() => {});
});
browser.runtime.onStartup.addListener(() => {
  removePendingSaves(() => true).catch(() => {});
});

// ─── Save with tags (called from save-dialog) ─────────────────────────────────

async function handleSaveWithTags(saveId, tags) {
  // Eintrag zuerst entnehmen, dann das Fenster schließen — sonst könnte
  // windows.onRemoved den Eintrag vorher wegräumen.
  const pending = await takePendingSave(saveId);
  if (!pending) return;
  if (pending.windowId != null) browser.windows.remove(pending.windowId).catch(() => {});

  const { url, tabId, isPage } = pending;
  const creds = await getCredentials();
  if (!creds.nextcloudUrl || !creds.username || !creds.appPassword) {
    await injectFlyout(tabId, t('notification_configureCredentials'), 'error');
    return;
  }

  await injectFlyout(tabId, t('flyout_saving'), 'loading');

  // HTML wird erst jetzt eingefangen, damit es nicht zwischenzeitlich in
  // storage.local liegen muss. Der Tab existiert noch, da der Save-Dialog nur
  // ein separates Popup-Fenster ist.
  let html = null;
  if (isPage && tabId != null) html = await captureTabHtml(tabId);

  await saveToMerlin({ ...creds, url, tabId, tags, html });
}

// ─── HTML-Capture für Seiten-Speichern ────────────────────────────────────────

async function captureTabHtml(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      // Läuft im Seitenkontext. Seiten über der Grenze liefern null, dann
      // wird nur die URL gespeichert. Die Länge in UTF-16-Einheiten ist nie
      // größer als die UTF-8-Bytegröße, daher die schnelle Vorprüfung.
      func: (maxBytes) => {
        const html = document.documentElement.outerHTML;
        if (html.length > maxBytes) return null;
        return new Blob([html]).size > maxBytes ? null : html;
      },
      args: [MAX_HTML_BYTES],
    });
    return results?.[0]?.result ?? null;
  } catch {
    return null;
  }
}

// ─── Context menu setup ───────────────────────────────────────────────────────

function setupContextMenu() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id:       MENU_ID_LINK,
      title:    t('contextMenu_sendLink'),
      contexts: ['link'],
    });
    browser.contextMenus.create({
      id:       MENU_ID_LINK_TAGS,
      title:    t('contextMenu_saveLinkWithTags'),
      contexts: ['link'],
    });
    browser.contextMenus.create({
      id:       MENU_ID_PAGE,
      title:    t('contextMenu_savePage'),
      contexts: ['page', 'selection', 'image'],
    });
    browser.contextMenus.create({
      id:       MENU_ID_PAGE_TAGS,
      title:    t('contextMenu_savePageWithTags'),
      contexts: ['page', 'selection', 'image'],
    });
  });
}

browser.runtime.onInstalled.addListener(setupContextMenu);
browser.runtime.onStartup.addListener(setupContextMenu);

// ─── Context menu click ───────────────────────────────────────────────────────

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const { menuItemId } = info;
  const isLink   = menuItemId === MENU_ID_LINK || menuItemId === MENU_ID_LINK_TAGS;
  const isPage   = menuItemId === MENU_ID_PAGE || menuItemId === MENU_ID_PAGE_TAGS;
  const withTags = menuItemId === MENU_ID_LINK_TAGS || menuItemId === MENU_ID_PAGE_TAGS;
  if (!isLink && !isPage) return;

  // tab.url steht hier über activeTab zur Verfügung (der Kontextmenü-Klick
  // gewährt es), dafür ist keine tabs-Berechtigung nötig.
  const url   = isLink ? info.linkUrl : tab?.url;
  const tabId = tab?.id;
  if (!url) return;

  const creds = await getCredentials();
  const { nextcloudUrl, username, appPassword } = creds;

  // No credentials yet → show flyout + open settings
  if (!nextcloudUrl || !username || !appPassword) {
    await injectFlyout(tabId, t('notification_configureCredentials'), 'error');
    // Brief pause so the flyout is visible before the new tab opens
    await sleep(700);
    browser.runtime.openOptionsPage();
    return;
  }

  // Ältere Installationen können noch eine http://-URL gespeichert haben.
  if (!isAllowedServerUrl(nextcloudUrl)) {
    await injectFlyout(tabId, t('flyout_httpBlocked'), 'error');
    browser.runtime.openOptionsPage();
    return;
  }

  // Host-Permission ist nur optional und auf die konkrete Server-Origin
  // beschränkt — wird beim Login in den Optionen erteilt. Hier können wir sie
  // NICHT per request() nachfordern: bis hier ist schon ein await gelaufen,
  // und Firefox verlangt für permissions.request() eine ununterbrochene
  // User-Geste. Daher nur passiv prüfen und auf die Einstellungen verweisen.
  const origin = originPatternFor(nextcloudUrl);
  if (origin && !(await browser.permissions.contains({ origins: [origin] }))) {
    await injectFlyout(tabId, t('notification_needsPermission'), 'error');
    browser.runtime.openOptionsPage();
    return;
  }

  // ── Direct save (no dialog) ─────────────────────────────────────────────────
  if (!withTags) {
    await injectFlyout(tabId, t('flyout_saving'), 'loading');

    // Für Seiten-Saves das gerenderte HTML mitschicken, damit der Server
    // keinen eigenen Abruf braucht (Paywalls, JS-Seiten). Link-Saves holt der
    // Server selbst.
    const html = isPage ? await captureTabHtml(tabId) : null;
    await saveToMerlin({ ...creds, url, html, tabId, tags: [] });
    return;
  }

  // ── Save with tags — open dialog ────────────────────────────────────────────
  const saveId = crypto.randomUUID();
  const key    = pendingSaveKey(saveId);
  await browser.storage.local.set({ [key]: { url, tabId, isPage, windowId: null } });

  try {
    const win = await browser.windows.create({
      url:    browser.runtime.getURL(`save-dialog.html?id=${encodeURIComponent(saveId)}`),
      type:   'popup',
      width:  460,
      height: 420,
    });
    // Fenster-ID nachtragen, damit windows.onRemoved den Eintrag aufräumen
    // kann. Hat der Dialog in der Zwischenzeit schon gespeichert, ist der
    // Eintrag weg und wird nicht neu angelegt.
    const { [key]: pending } = await browser.storage.local.get(key);
    if (pending) await browser.storage.local.set({ [key]: { ...pending, windowId: win.id } });
  } catch {
    // Fallback: save directly if window creation fails
    await browser.storage.local.remove(key);
    await injectFlyout(tabId, t('flyout_saving'), 'loading');
    const html = isPage ? await captureTabHtml(tabId) : null;
    await saveToMerlin({ ...creds, url, html, tabId, tags: [] });
  }
});

// ─── API call ─────────────────────────────────────────────────────────────────

// merlin-server hat keine Pocket-kompatible Extension-API (/api/v1/add), die
// Tag-Namen serverseitig auflöst - Tag-IDs müssen hier vorab per /api/tags
// aufgelöst (bzw. bei Bedarf neu angelegt) werden. Gibt zusätzlich die Namen
// zurück, die nicht gesetzt werden konnten, damit der Toast das ehrlich meldet.
async function resolveTagIdsStandalone(nextcloudUrl, creds, tagNames) {
  if (!tagNames || tagNames.length === 0) return { ids: [], failed: [] };

  const base = nextcloudUrl.replace(/\/$/, '');
  const headers = { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' };

  // Ohne die bestehende Tag-Liste würden alle Tags neu angelegt und damit
  // Duplikate entstehen — dann lieber keinen Tag setzen und das melden.
  let existing;
  try {
    const resp = await fetch(`${base}/api/tags`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!resp.ok) return { ids: [], failed: [...tagNames] };
    const data = await resp.json();
    existing = Array.isArray(data) ? data : (data.tags ?? data.data ?? []);
  } catch {
    return { ids: [], failed: [...tagNames] };
  }

  const ids = [];
  const failed = [];
  for (const name of tagNames) {
    const match = existing.find(tag => String(tag.name).toLowerCase() === name.toLowerCase());
    if (match) {
      ids.push(match.id);
      continue;
    }
    try {
      const resp = await fetch(`${base}/api/tags`, {
        method: 'POST',
        headers,
        body:   JSON.stringify({ name }),
        signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
      });
      if (!resp.ok) { failed.push(name); continue; }
      const created = await resp.json();
      ids.push(created.id);
      existing.push(created);
    } catch {
      failed.push(name);
    }
  }
  return { ids, failed };
}

async function saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, html, tabId, tags = [] }) {
  if (!isAllowedServerUrl(nextcloudUrl)) {
    await injectFlyout(tabId, t('flyout_httpBlocked'), 'error');
    return;
  }

  const creds = btoa(`${username}:${appPassword}`);
  let failedTags = [];

  let apiUrl, body;
  if (backendKind === 'standalone') {
    // merlin-server nutzt den nativen Endpunkt /api/articles, der html genau
    // wie /index.php/apps/merlin/api/v1/add akzeptiert.
    apiUrl = `${nextcloudUrl.replace(/\/$/, '')}/api/articles`;
    const { ids: tagIds, failed } = await resolveTagIdsStandalone(nextcloudUrl, creds, tags);
    failedTags = failed;
    body = tagIds.length > 0 ? { url, tagIds } : { url };
    if (html) body.html = html;
  } else {
    apiUrl = `${nextcloudUrl.replace(/\/$/, '')}/index.php/apps/merlin/api/v1/add`;
    body = { url };
    if (tags && tags.length > 0) body.tags = tags;
    if (html) body.html = html;
  }

  let response;
  try {
    response = await fetch(apiUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch (networkError) {
    const message = networkError?.name === 'TimeoutError'
      ? t('flyout_timeout')
      : t('flyout_connectionFailed', [networkError.message]);
    await injectFlyout(tabId, message, 'error');
    return;
  }

  if (response.status === 401) {
    const cleared = await recordAuthFailure();
    await injectFlyout(tabId, cleared ? t('flyout_authFailed') : t('flyout_authFailedRetry'), 'error');
    return;
  }
  if (!response.ok) {
    // Merlin lehnt bekannt unscrapbare Domains (siehe content-filters/$unsupported.xml
    // im Nextcloud-Backend) schon synchron ab. merlin-server kennt diese
    // Fehlerform evtl. (noch) nicht - dann greift einfach der generische Zweig.
    let payload = null;
    try { payload = await response.clone().json(); } catch { /* kein JSON-Body */ }
    if (payload && payload.error === 'unsupported_site' && payload.domain) {
      await injectFlyout(tabId, t('flyout_unsupportedSite', [payload.domain]), 'error');
      return;
    }
    await injectFlyout(tabId, t('flyout_serverError', [String(response.status)]), 'error');
    return;
  }

  await resetAuthFailures();

  // Show success immediately — the link has been handed off to the server.
  // Content extraction runs asynchronously; no need to wait for it here.
  let message;
  if (failedTags.length > 0) {
    message = t('flyout_articleAddedTagsFailed', [failedTags.join(', ')]);
  } else if (tags && tags.length > 0) {
    message = t('flyout_articleAddedWithTags', [tags.join(', ')]);
  } else {
    message = t('flyout_addedToReadingList');
  }
  await injectFlyout(tabId, message, 'success');
}

// ─── Flyout injection ─────────────────────────────────────────────────────────
//
// Injects a small toast into the current page via browser.scripting.
// Falls back to a browser notification on privileged pages (about:*, etc.).

async function injectFlyout(tabId, message, state) {
  if (tabId == null) { await fallbackNotify(state, message); return; }

  const logoUrl = await getLogoDataUrl();

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      func:   renderFlyout,
      args:   [message, state, logoUrl],
    });
  } catch {
    // Scripting blocked (privileged page, pdf viewer, etc.)
    await fallbackNotify(state, message);
  }
}

// This function runs INSIDE the page context — must be fully self-contained.
function renderFlyout(message, state, logoUrl) {
  const ID      = '__merlin_ext_flyout__';
  const STYLE_ID = '__merlin_ext_styles__';

  // Inject keyframe animation once
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      @keyframes __merlin_spin { to { transform: rotate(360deg); } }
      @keyframes __merlin_in   { from { opacity:0; transform:translateY(-10px) } to { opacity:1; transform:translateY(0) } }
    `;
    document.head.appendChild(s);
  }

  let flyout = document.getElementById(ID);
  if (!flyout) {
    flyout = document.createElement('div');
    flyout.id = ID;
    Object.assign(flyout.style, {
      position:      'fixed',
      top:           '24px',
      right:         '24px',
      zIndex:        '2147483647',
      display:       'flex',
      alignItems:    'center',
      gap:           '11px',
      background:    '#fff',
      border:        '1px solid #e0e4ea',
      borderRadius:  '13px',
      boxShadow:     '0 6px 24px rgba(0,0,0,0.13)',
      padding:       '13px 16px',
      minWidth:      '230px',
      maxWidth:      '340px',
      fontFamily:    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      fontSize:      '13px',
      lineHeight:    '1.4',
      animation:     '__merlin_in 0.2s ease both',
      transition:    'opacity 0.25s ease, transform 0.25s ease',
    });
    document.body.appendChild(flyout);
  }

  // Clear auto-hide timer if updating
  clearTimeout(flyout.__hideTimer);

  // Build flyout content via DOM API (avoids unsafe innerHTML with dynamic values)
  flyout.replaceChildren();

  // Left column: logo + state badge
  const logoWrap = Object.assign(document.createElement('div'), {});
  Object.assign(logoWrap.style, { flexShrink:'0', position:'relative', width:'50px', height:'50px' });

  const img = document.createElement('img');
  img.src = logoUrl;
  img.alt = 'Merlin';
  Object.assign(img.style, { width:'50px', height:'50px', borderRadius:'10px', display:'block' });
  logoWrap.appendChild(img);

  const badgeWrap = document.createElement('div');
  Object.assign(badgeWrap.style, {
    position:'absolute', bottom:'-4px', right:'-4px', background:'#fff',
    borderRadius:'50%', width:'20px', height:'20px',
    display:'flex', alignItems:'center', justifyContent:'center',
    boxShadow:'0 1px 4px rgba(0,0,0,0.18)',
  });

  const badgeEl = document.createElement('div');
  if (state === 'success') {
    badgeEl.textContent = '✓';
    Object.assign(badgeEl.style, { color:'#256029', fontSize:'12px', fontWeight:'700', lineHeight:'1' });
  } else if (state === 'error') {
    badgeEl.textContent = '✕';
    Object.assign(badgeEl.style, { color:'#9b1c1c', fontSize:'12px', fontWeight:'700', lineHeight:'1' });
  } else {
    // loading spinner
    Object.assign(badgeEl.style, {
      width:'12px', height:'12px',
      border:'2px solid #0082c9', borderTopColor:'transparent',
      borderRadius:'50%', animation:'__merlin_spin 0.75s linear infinite',
    });
  }
  badgeWrap.appendChild(badgeEl);
  logoWrap.appendChild(badgeWrap);
  flyout.appendChild(logoWrap);

  // Right column: label + message
  const textCol = document.createElement('div');
  Object.assign(textCol.style, { flex:'1', minWidth:'0' });

  const label = document.createElement('div');
  label.textContent = 'Merlin';
  Object.assign(label.style, {
    fontWeight:'700', color:'#0082c9', fontSize:'12px',
    letterSpacing:'.03em', textTransform:'uppercase', marginBottom:'2px',
  });
  textCol.appendChild(label);

  const msgEl = document.createElement('div');
  msgEl.textContent = message;
  Object.assign(msgEl.style, { color:'#444', overflow:'hidden', textOverflow:'ellipsis' });
  textCol.appendChild(msgEl);

  flyout.appendChild(textCol);

  // Auto-dismiss after 3.5 s for finished states
  if (state !== 'loading') {
    flyout.__hideTimer = setTimeout(() => {
      flyout.style.opacity   = '0';
      flyout.style.transform = 'translateY(-10px)';
      setTimeout(() => flyout.remove(), 280);
    }, 3500);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fallbackNotify(state, message) {
  const titles = {
    success: t('notification_savedTitle'),
    error:   t('notification_errorTitle'),
    loading: t('notification_loadingTitle'),
  };
  return browser.notifications.create({
    type:    'basic',
    iconUrl: browser.runtime.getURL('icons/icon-48.png'),
    title:   titles[state] ?? t('notification_defaultTitle'),
    message,
  });
}
