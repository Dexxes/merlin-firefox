'use strict';

const $ = id => document.getElementById(id);

// t, getCredentials, recordAuthFailure and the tag API helpers come from
// common.js.

// ID of this save, which the background script puts into the dialog's URL
// (save-dialog.html?id=…).
const saveId = new URLSearchParams(location.search).get('id') ?? '';

// Tags selected via chips (independent from the text input)
const selectedChipTags = new Set();

// Guards against pasting an unbounded comma-separated string into the tag
// input — matches the server's own tag-name column width, kept in sync
// manually (no shared module between extension and backend).
const MAX_TAG_LENGTH = 100;
const MAX_TAGS       = 50;

document.addEventListener('DOMContentLoaded', async () => {

  // ─── Load pending save data ──────────────────────────────────────────────────
  let pendingSave = null;
  try {
    const key = `_merlinPendingSave_${saveId}`;
    const result = await browser.storage.local.get(key);
    pendingSave = result[key] ?? null;
  } catch { /* ignore */ }

  const url = pendingSave?.url ?? '';
  $('urlDisplay').textContent = url;
  $('urlDisplay').title       = url;

  // ─── Auto-focus tag input ────────────────────────────────────────────────────
  $('tagsInput').focus();

  // ─── Load existing tags from API ────────────────────────────────────────────
  loadExistingTags();

  // ─── Save ────────────────────────────────────────────────────────────────────
  async function doSave() {
    // Collect tags from both the text input and chip selections, deduplicated
    const inputTags = $('tagsInput').value
      .split(',')
      .map(t => t.trim().slice(0, MAX_TAG_LENGTH))
      .filter(Boolean);

    const tags = [...new Set([...selectedChipTags, ...inputTags])].slice(0, MAX_TAGS);

    try {
      await browser.runtime.sendMessage({ type: 'merlin:saveWithTags', saveId, tags });
    } catch { /* background will handle errors */ }

    window.close();
  }

  // ─── Cancel ──────────────────────────────────────────────────────────────────
  function doCancel() {
    browser.runtime.sendMessage({ type: 'merlin:cancelSave', saveId }).catch(() => {});
    window.close();
  }

  // ─── Event listeners ─────────────────────────────────────────────────────────
  $('saveBtn').addEventListener('click', doSave);
  $('cancelBtn').addEventListener('click', doCancel);

  $('tagsInput').addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { doCancel(); }
  });
});

// ─── Fetch & render existing tags ─────────────────────────────────────────────

// Renders a single status/empty/error message via the DOM API (no innerHTML) —
// keeps this file consistent with background.js's renderFlyout(), so an
// interpolated value can never be mistaken for markup, even if a future
// change starts passing through server-supplied text.
function setChipsMessage(container, className, text) {
  const span = document.createElement('span');
  span.className   = className;
  span.textContent = text;
  container.replaceChildren(span);
}

async function loadExistingTags() {
  const spinner   = $('tagsSpinner');
  const chipsWrap = $('tagChips');

  // Read credentials fresh instead of carrying them in the pending-save entry.
  const { nextcloudUrl, username, appPassword, backendKind } = await getCredentials();
  if (!nextcloudUrl || !username || !appPassword || !isAllowedServerUrl(nextcloudUrl)) {
    spinner.style.display = 'none';
    setChipsMessage(chipsWrap, 'tags-empty', t('saveDialog_noCredentials'));
    return;
  }

  try {
    const resp = await fetch(tagsEndpoint(nextcloudUrl, backendKind), {
      method:  'GET',
      headers: { 'Authorization': basicAuthHeader(username, appPassword) },
      signal:  AbortSignal.timeout(8_000),
    });

    spinner.style.display = 'none';

    if (resp.status === 401) {
      // Same rule as when saving: credentials are only cleared on the second
      // 401 in a row (see recordAuthFailure in common.js).
      const cleared = await recordAuthFailure();
      setChipsMessage(chipsWrap, 'tags-error', cleared ? t('saveDialog_authFailed') : t('saveDialog_authFailedRetry'));
      return;
    }

    if (!resp.ok) {
      setChipsMessage(chipsWrap, 'tags-error', t('saveDialog_tagsLoadError', [String(resp.status)]));
      return;
    }

    const tags = normalizeTagList(await resp.json());

    if (!tags.length) {
      setChipsMessage(chipsWrap, 'tags-empty', t('saveDialog_noTags'));
      return;
    }

    renderChips(tags, chipsWrap);

  } catch (err) {
    spinner.style.display = 'none';
    if (err.name === 'TimeoutError') {
      setChipsMessage(chipsWrap, 'tags-error', t('saveDialog_tagsTimeout'));
    } else {
      // Silently hide the section on network errors — don't block the user
      $('tagsSection').style.display = 'none';
    }
  }
}

// ─── Render clickable tag chips ───────────────────────────────────────────────

function renderChips(tags, container) {
  container.replaceChildren();

  tags.forEach(tag => {
    const name = tag.name ?? tag;   // support both objects and plain strings
    if (!name) return;

    const chip = document.createElement('button');
    chip.type        = 'button';
    chip.textContent = name;
    chip.className   = 'tag-chip';
    if (selectedChipTags.has(name)) chip.classList.add('selected');

    chip.addEventListener('click', () => {
      if (selectedChipTags.has(name)) {
        selectedChipTags.delete(name);
        chip.classList.remove('selected');
      } else {
        selectedChipTags.add(name);
        chip.classList.add('selected');
      }
    });

    container.appendChild(chip);
  });
}
