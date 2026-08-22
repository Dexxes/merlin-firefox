'use strict';

const MENU_ID_LINK      = 'merlin-send-link';
const MENU_ID_LINK_TAGS = 'merlin-send-link-tags';
const MENU_ID_PAGE      = 'merlin-save-page';
const MENU_ID_PAGE_TAGS = 'merlin-save-page-tags';

// ─── i18n shorthand ───────────────────────────────────────────────────────────
// Liest lokalisierte Strings aus _locales/<lang>/messages.json (generiert aus
// localization/strings/*.json via tools/i18n/export.py). `subs` ist optional
// und wird auf die $1/$2-Platzhalter der jeweiligen Message abgebildet.
const t = (key, subs) => browser.i18n.getMessage(key, subs);

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

// ─── Credential storage helpers ───────────────────────────────────────────────
//
// storage.sync ist die bevorzugte Ablage: Mozilla verschlüsselt storage.sync
// serverseitig Ende-zu-Ende als Teil der Firefox-Sync-Infrastruktur (Schlüssel
// pro Firefox-Konto, für Mozilla selbst nicht einsehbar). Das App-Passwort kann
// damit gefahrlos automatisch auf alle Geräte verteilt werden — eine eigene
// Verschlüsselung im Code ist dafür nicht nötig. Ist storage.sync nicht
// verfügbar (kein Firefox-Konto angemeldet), dient storage.local als Fallback.

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

// ─── Migration: storage.local → storage.sync ──────────────────────────────────
//
// Eine frühere Fix-Runde hatte Zugangsdaten nach storage.local verschoben, in
// der irrtümlichen Annahme, storage.sync sei unverschlüsselt. Tatsächlich
// verschlüsselt Mozilla storage.sync serverseitig Ende-zu-Ende — wir holen
// bestehende lokale Zugangsdaten daher einmalig zurück nach storage.sync.
// Verwaiste Crypto-Reste (encPassphrase/credEnc) aus einem Zwischenschritt mit
// eigener AES-Verschlüsselung werden ebenfalls aufgeräumt (für Firefox/Thunderbird
// nicht mehr nötig, da Mozilla das bereits serverseitig erledigt).
async function migrateCredentialsToSync() {
  try {
    const local = await browser.storage.local.get(['nextcloudUrl', 'username', 'appPassword', 'backendKind']);
    if (local.nextcloudUrl || local.username || local.appPassword) {
      await browser.storage.sync.set(local);
      await browser.storage.local.remove(['nextcloudUrl', 'username', 'appPassword', 'backendKind']);
    } else if (local.backendKind) {
      // Reparatur für Installationen, bei denen eine ältere Version dieser
      // Migration nextcloudUrl/username/appPassword bereits nach sync verschoben
      // hatte, backendKind dabei aber in storage.local zurückließ (Bug: fehlte
      // im damaligen Feldset oben). getCredentials() liest bei vorhandenem Sync-
      // Eintrag storage.local gar nicht mehr — das verwaiste backendKind wäre
      // sonst dauerhaft unsichtbar und ein Standalone-Server-Save würde
      // fälschlich den Nextcloud-API-Pfad verwenden.
      await browser.storage.sync.set({ backendKind: local.backendKind });
      await browser.storage.local.remove('backendKind');
    }
    await browser.storage.local.remove('encPassphrase');
    await browser.storage.sync.remove('credEnc');
  } catch {
    // storage.sync evtl. nicht verfügbar — Zugangsdaten bleiben dann lokal
  }
}

browser.runtime.onInstalled.addListener(migrateCredentialsToSync);
browser.runtime.onStartup.addListener(migrateCredentialsToSync);

// ─── Runtime host permission for the user's Nextcloud server ─────────────────
//
// host_permissions ist nur noch optional (manifest.json) statt pauschal
// <all_urls> — die Erweiterung fragt stattdessen genau die Origin an, die der
// Nutzer als Nextcloud-Server konfiguriert. Das funktioniert hier, weil der
// Request innerhalb eines Kontextmenü-Klicks (User-Geste) ausgelöst wird.

function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// ─── Login Flow polling ───────────────────────────────────────────────────────
//
// Das Polling läuft hier im Hintergrundskript, nicht in der Options-Seite:
// Firefox öffnet die Options-Seite per Toolbar-Klick standardmäßig als kleines
// Popup (default_popup). Sobald der Login-Tab im Vordergrund den Fokus bekommt,
// schließt sich das Popup automatisch — ein dort laufendes Polling würde damit
// abreißen. Das Ergebnis landet in storage.local, von wo aus die Options-Seite
// (egal ob sie das noch ist oder gerade neu geöffnet wurde) es per
// storage.onChanged abholt.

let _lfTimer  = null;
let _lfActive = false;

async function startBackgroundLoginPoll({ pollEndpoint, pollToken, serverUrl, loginTabId, backendKind }) {
  if (_lfActive) {
    _lfActive = false;
    clearTimeout(_lfTimer);
    _lfTimer = null;
  }

  _lfActive = true;
  await browser.storage.local.set({ _merlinLoginFlow: { active: true, loginTabId } });

  const deadline = Date.now() + 5 * 60 * 1000; // 5-Minuten-Timeout

  async function poll() {
    if (!_lfActive) return;

    if (Date.now() > deadline) {
      await _lfFinish({ error: t('options_loginTimeout') });
      return;
    }

    try {
      const r = await fetch(pollEndpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `token=${encodeURIComponent(pollToken)}`,
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

      await _lfFinish({ creds, serverUrl, backendKind });
    } catch {
      // Transient network error — keep retrying
      if (_lfActive) _lfTimer = setTimeout(poll, 2000);
    }
  }

  _lfTimer = setTimeout(poll, 2000);
}

async function cancelBackgroundLoginPoll() {
  if (!_lfActive) return;
  _lfActive = false;
  clearTimeout(_lfTimer);
  _lfTimer = null;
  await browser.storage.local.remove('_merlinLoginFlow');
  await browser.storage.local.set({ _merlinLoginFlowResult: { cancelled: true } });
}

async function _lfFinish({ creds, serverUrl, backendKind, error }) {
  _lfActive = false;
  clearTimeout(_lfTimer);
  _lfTimer = null;

  const { _merlinLoginFlow } = await browser.storage.local.get('_merlinLoginFlow');
  const loginTabId = _merlinLoginFlow?.loginTabId;
  await browser.storage.local.remove('_merlinLoginFlow');

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
  // Options-Seite oder öffnet sie neu — wichtig, falls das Popup beim Öffnen
  // des Login-Tabs bereits geschlossen wurde.
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
    handleSaveWithTags(msg.tags ?? [], msg.windowId ?? null);
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:cancelSave') {
    browser.storage.local.remove('_merlinPendingSave').catch(() => {});
    return Promise.resolve({ ok: true });
  }
});

// ─── Save with tags (called from save-dialog) ─────────────────────────────────

async function handleSaveWithTags(tags, windowId) {
  // Close the dialog window
  if (windowId != null) browser.windows.remove(windowId).catch(() => {});

  const { _merlinPendingSave } = await browser.storage.local.get('_merlinPendingSave');
  await browser.storage.local.remove('_merlinPendingSave');

  if (!_merlinPendingSave) return;

  const { url, tabId, nextcloudUrl, username, appPassword, backendKind, isPage } = _merlinPendingSave;

  // HTML wird erst jetzt (statt schon beim Öffnen des Dialogs) eingefangen, um
  // es nicht zwischenzeitlich in storage.local ablegen zu müssen — bei großen
  // Seiten würde das an dessen Quota stoßen. Der Tab existiert zu diesem
  // Zeitpunkt noch, da der Save-Dialog nur ein separates Popup-Fenster ist und
  // den ursprünglichen Tab nicht schließt.
  let html = null;
  if (isPage && tabId != null) html = await captureTabHtml(tabId);

  await saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, tabId, tags, html });
}

// ─── HTML-Capture für Seiten-Speichern ────────────────────────────────────────

async function captureTabHtml(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func:   () => document.documentElement.outerHTML,
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

  const url   = isLink ? info.linkUrl : tab?.url;
  const tabId = tab?.id;
  if (!url) return;

  const { nextcloudUrl, username, appPassword, backendKind } = await getCredentials();

  // No credentials yet → show flyout + open settings
  if (!nextcloudUrl || !username || !appPassword) {
    await injectFlyout(tabId, t('notification_configureCredentials'), 'error');
    // Brief pause so the flyout is visible before the new tab opens
    await sleep(700);
    browser.runtime.openOptionsPage();
    return;
  }

  // Host-Permission ist seit dem Permissions-Fix nur noch optional und auf die
  // konkrete Nextcloud-Origin beschränkt (statt <all_urls>) — wird normalerweise
  // schon beim Login in den Optionen erteilt (dort passiert das synchron-direkt
  // im Klick-Handler, siehe ensureHostPermission() in options.js). Hier können
  // wir die Permission NICHT per request() nachfordern: bis hier hin ist schon
  // ein await (getCredentials) gelaufen, und Firefox verlangt für
  // permissions.request() eine ununterbrochene User-Geste direkt aus dem
  // Event-Handler — sonst "permissions.request may only be called from a user
  // input handler". Daher nur passiv prüfen (contains, kein await davor nötig)
  // und bei fehlender Berechtigung auf die Einstellungen verweisen, wo der
  // saubere Re-Grant passiert.
  const origin = originPatternFor(nextcloudUrl);
  if (origin && !(await browser.permissions.contains({ origins: [origin] }))) {
    await injectFlyout(tabId, t('notification_needsPermission'), 'error');
    browser.runtime.openOptionsPage();
    return;
  }

  // ── Direct save (no dialog) ─────────────────────────────────────────────────
  if (!withTags) {
    // Show loading flyout immediately
    await injectFlyout(tabId, t('flyout_saving'), 'loading');

    // For page saves, capture the current rendered HTML so the server can skip
    // its own HTTP fetch (works for paywalled and JS-rendered pages). For link
    // saves the server fetches the target URL directly — no HTML needed.
    const html = isPage ? await captureTabHtml(tabId) : null;
    await saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, html, tabId, tags: [] });
    return;
  }

  // ── Save with tags — open dialog ────────────────────────────────────────────
  await browser.storage.local.set({
    _merlinPendingSave: { url, tabId, nextcloudUrl, username, appPassword, backendKind, isPage },
  });

  try {
    await browser.windows.create({
      url:    browser.runtime.getURL('save-dialog.html'),
      type:   'popup',
      width:  460,
      height: 420,
    });
  } catch {
    // Fallback: save directly if window creation fails
    await browser.storage.local.remove('_merlinPendingSave');
    await injectFlyout(tabId, t('flyout_saving'), 'loading');
    const html = isPage ? await captureTabHtml(tabId) : null;
    await saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, html, tabId, tags: [] });
  }
});

// ─── API call ─────────────────────────────────────────────────────────────────

// merlin-server hat keine Pocket-kompatible Extension-API (/api/v1/add), die
// Tag-Namen serverseitig auflöst - Tag-IDs müssen hier vorab per /api/tags
// aufgelöst (bzw. bei Bedarf neu angelegt) werden.
async function resolveTagIdsStandalone(nextcloudUrl, creds, tagNames) {
  if (!tagNames || tagNames.length === 0) return [];

  const base = nextcloudUrl.replace(/\/$/, '');
  const headers = { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' };

  let existing = [];
  try {
    const resp = await fetch(`${base}/api/tags`, { method: 'GET', headers });
    if (resp.ok) existing = await resp.json();
  } catch { /* fällt unten auf "alle neu anlegen" zurück */ }

  const ids = [];
  for (const name of tagNames) {
    const match = existing.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (match) {
      ids.push(match.id);
      continue;
    }
    try {
      const resp = await fetch(`${base}/api/tags`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name }),
      });
      if (resp.ok) {
        const created = await resp.json();
        ids.push(created.id);
        existing.push(created);
      }
    } catch { /* einzelnes Tag konnte nicht angelegt werden - überspringen */ }
  }
  return ids;
}

async function saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, html, tabId, tags = [] }) {
  const creds = btoa(`${username}:${appPassword}`);

  let apiUrl, body;
  if (backendKind === 'standalone') {
    // merlin-server hat keine Pocket-kompatible Extension-API (/api/v1/add) -
    // stattdessen wird der native Endpunkt genutzt, den auch die Leseliste
    // (library.php) zum Hinzufügen nutzt. /api/articles akzeptiert html genau
    // wie /index.php/apps/merlin/api/v1/add unten (extractFromHtml()-Pipeline
    // ist ein 1:1-Port aus Nextcloud).
    apiUrl = `${nextcloudUrl.replace(/\/$/, '')}/api/articles`;
    const tagIds = await resolveTagIdsStandalone(nextcloudUrl, creds, tags);
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
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    await injectFlyout(tabId, t('flyout_connectionFailed', [networkError.message]), 'error');
    return;
  }

  if (response.status === 401) {
    await injectFlyout(tabId, t('flyout_authFailed'), 'error');
    await handleAuthFailure();
    return;
  }
  if (!response.ok) {
    await injectFlyout(tabId, t('flyout_serverError', [String(response.status)]), 'error');
    return;
  }

  // Show success immediately — the link has been handed off to the server.
  // Content extraction runs asynchronously; no need to wait for it here.
  const message = tags && tags.length > 0
    ? t('flyout_articleAddedWithTags', [tags.join(', ')])
    : t('flyout_addedToReadingList');
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Auth failure handling ──────────────────────────────────────────────────────
//
// Bei HTTP 401 ist das App-Passwort tot (widerrufen/abgelaufen). Wir löschen die
// Credentials sofort, damit der Nutzer nicht mit einem ungültigen Passwort
// weiterläuft, und zeigen eine Notification, da das Hintergrundskript sonst
// unsichtbar bleibt.
async function handleAuthFailure() {
  await clearCredentials();
  await browser.notifications.create({
    type:    'basic',
    iconUrl: browser.runtime.getURL('icons/icon-48.png'),
    title:   t('notification_defaultTitle'),
    message: t('notification_authFailedMessage'),
  });
}
