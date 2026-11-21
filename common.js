'use strict';

// ─── Shared helpers ───────────────────────────────────────────────────────────
//
// Loaded before background.js (manifest "background.scripts") and before the
// page scripts of options.html and save-dialog.html. Everything here is a
// plain global so the classic (non-module) scripts can use it.

// i18n shorthand: reads localized strings from _locales/<lang>/messages.json
// (generated from merlin-translations via export.py --platform webext).
// `subs` maps onto the $1/$2 placeholders of the message.
const t = (key, subs) => browser.i18n.getMessage(key, subs);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Server URL checks ────────────────────────────────────────────────────────

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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Credentials, URLs and page content must only travel encrypted. Plain
// http:// is accepted solely for loopback addresses (local development),
// where nothing leaves the machine.
function isAllowedServerUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// ─── Credential storage ───────────────────────────────────────────────────────
//
// storage.sync is preferred: Firefox Sync encrypts it end-to-end per Firefox
// Account, so the app password can be distributed to all devices without an
// extension-specific encryption layer. Without a signed-in Firefox Account,
// storage.local is the fallback.

const CREDENTIAL_KEYS = ['nextcloudUrl', 'username', 'appPassword', 'backendKind'];

async function getCredentials() {
  try {
    const synced = await browser.storage.sync.get(CREDENTIAL_KEYS);
    if (synced.nextcloudUrl || synced.username || synced.appPassword) return synced;
  } catch { /* storage.sync may be unavailable */ }
  return browser.storage.local.get(CREDENTIAL_KEYS);
}

async function setCredentials(fields) {
  try {
    await browser.storage.sync.set(fields);
  } catch {
    await browser.storage.local.set(fields);
  }
}

async function clearCredentials() {
  const keys = ['nextcloudUrl', 'username', 'appPassword'];
  try { await browser.storage.sync.remove(keys); } catch { /* ignore */ }
  await browser.storage.local.remove([...keys, '_merlinAuthFailures']);
}

// ─── Auth failure handling ────────────────────────────────────────────────────
//
// A single HTTP 401 can have harmless causes (wrong backend type selected,
// a misconfigured reverse proxy, a short server hiccup). Clearing the
// credentials right away would log the user out on every synced device, so
// they are only cleared after two consecutive 401s. Any successful request
// resets the counter.

const AUTH_FAILURE_LIMIT = 2;

// Returns true when the credentials were cleared.
async function recordAuthFailure() {
  const { _merlinAuthFailures = 0 } = await browser.storage.local.get('_merlinAuthFailures');
  const count = _merlinAuthFailures + 1;
  if (count < AUTH_FAILURE_LIMIT) {
    await browser.storage.local.set({ _merlinAuthFailures: count });
    return false;
  }
  await clearCredentials();
  await browser.notifications.create({
    type:    'basic',
    iconUrl: browser.runtime.getURL('icons/icon-48.png'),
    title:   t('notification_authFailedTitle'),
    message: t('notification_authFailedMessage'),
  });
  return true;
}

async function resetAuthFailures() {
  await browser.storage.local.remove('_merlinAuthFailures');
}
