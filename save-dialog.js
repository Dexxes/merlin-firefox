'use strict';

const $ = id => document.getElementById(id);

// i18n-Kürzel: liest lokalisierte Strings aus _locales/<lang>/messages.json
// (generiert via tools/i18n/export.py). `subs` mappt auf die $1/$2-Platzhalter.
const t = (key, subs) => browser.i18n.getMessage(key, subs);

// Tags selected via chips (independent from the text input)
const selectedChipTags = new Set();

// Set by renderChips(): re-filters the tag tree after the text input changed.
let applyTagFilter = () => {};

// Guards against pasting an unbounded comma-separated string into the tag
// input — matches the server's own tag-name column width, kept in sync
// manually (no shared module between extension and backend).
const MAX_TAG_LENGTH = 100;
const MAX_TAGS       = 50;

document.addEventListener('DOMContentLoaded', async () => {

  // ─── Load pending save data ──────────────────────────────────────────────────
  let pendingSave = null;
  try {
    const result = await browser.storage.local.get('_merlinPendingSave');
    pendingSave = result._merlinPendingSave ?? null;
  } catch { /* ignore */ }

  const url = pendingSave?.url ?? '';
  $('urlDisplay').textContent = url;
  $('urlDisplay').title       = url;

  // ─── Auto-focus tag input ────────────────────────────────────────────────────
  $('tagsInput').focus();

  // ─── Load existing tags from API ────────────────────────────────────────────
  loadExistingTags(pendingSave);

  // ─── Save ────────────────────────────────────────────────────────────────────
  async function doSave() {
    // Collect tags from both the text input and chip selections, deduplicated
    const inputTags = $('tagsInput').value
      .split(',')
      .map(t => t.trim().slice(0, MAX_TAG_LENGTH))
      .filter(Boolean);

    const tags = [...new Set([...selectedChipTags, ...inputTags])].slice(0, MAX_TAGS);

    let windowId = null;
    try {
      const win = await browser.windows.getCurrent();
      windowId  = win.id;
    } catch { /* window API not available */ }

    try {
      await browser.runtime.sendMessage({ type: 'merlin:saveWithTags', tags, windowId });
    } catch { /* background will handle errors */ }

    window.close();
  }

  // ─── Cancel ──────────────────────────────────────────────────────────────────
  function doCancel() {
    browser.runtime.sendMessage({ type: 'merlin:cancelSave' }).catch(() => {});
    window.close();
  }

  // ─── Event listeners ─────────────────────────────────────────────────────────
  $('saveBtn').addEventListener('click', doSave);
  $('cancelBtn').addEventListener('click', doCancel);

  // Typing filters the existing tags by the tag currently being typed
  // (the text after the last comma).
  $('tagsInput').addEventListener('input', () => applyTagFilter());

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

async function loadExistingTags(pendingSave) {
  const spinner   = $('tagsSpinner');
  const chipsWrap = $('tagChips');

  if (!pendingSave?.nextcloudUrl || !pendingSave?.username || !pendingSave?.appPassword) {
    spinner.style.display = 'none';
    setChipsMessage(chipsWrap, 'tags-empty', t('saveDialog_noCredentials'));
    return;
  }

  const { nextcloudUrl, username, appPassword, backendKind } = pendingSave;
  const apiPrefix = backendKind === 'standalone' ? '/api' : '/index.php/apps/merlin/api';
  const apiUrl = `${nextcloudUrl.replace(/\/$/, '')}${apiPrefix}/tags`;
  const creds  = btoa(`${username}:${appPassword}`);

  try {
    const resp = await fetch(apiUrl, {
      method:  'GET',
      headers: { 'Authorization': `Basic ${creds}` },
      signal:  AbortSignal.timeout(8_000),
    });

    spinner.style.display = 'none';

    if (resp.status === 401) {
      // Zugangsdaten ungültig — löschen und Re-Login erzwingen, wie auch beim Speichern selbst.
      await browser.storage.sync.remove(['nextcloudUrl', 'username', 'appPassword']).catch(() => {});
      await browser.storage.local.remove(['nextcloudUrl', 'username', 'appPassword']);
      await notifyAuthFailed();
      setChipsMessage(chipsWrap, 'tags-error', t('saveDialog_authFailed'));
      return;
    }

    if (!resp.ok) {
      setChipsMessage(chipsWrap, 'tags-error', t('saveDialog_tagsLoadError', [String(resp.status)]));
      return;
    }

    const data = await resp.json();

    // API may return { tags: [...] } or directly an array
    const tags = Array.isArray(data) ? data : (data.tags ?? data.data ?? []);

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

// ─── Notification helper ───────────────────────────────────────────────────────

function notifyAuthFailed() {
  return browser.notifications.create({
    type:    'basic',
    iconUrl: browser.runtime.getURL('icons/icon-48.png'),
    title:   t('notification_authFailedTitle'),
    message: t('notification_authFailedMessage'),
  });
}

// ─── Nested tags ──────────────────────────────────────────────────────────────
// merlin-nextcloud tags carry `parentId` (null = top level). Mirrors
// src/tag-tree.js there: tree order (parents before children, siblings by
// name); a tag whose parent is missing counts as top level so it never
// disappears. Servers without nested tags simply yield a flat list.

function buildTagTree(rawTags) {
  const tags = rawTags
    .map(tag => typeof tag === 'string'
      ? { id: tag, name: tag, parentId: null }
      : { id: tag.id ?? tag.name, name: tag.name, parentId: tag.parentId ?? null })
    .filter(tag => tag.name);
  const byId = new Map(tags.map(tag => [tag.id, tag]));
  const children = new Map();
  for (const tag of tags) {
    const parent = tag.parentId != null && byId.has(tag.parentId) ? tag.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(tag);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  const rows = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const tag of children.get(parent) || []) {
      if (seen.has(tag.id)) continue;
      seen.add(tag.id);
      rows.push({ tag, depth });
      walk(tag.id, depth + 1);
    }
  };
  walk(null, 0);

  const ancestors = tag => {
    const result = [];
    const visited = new Set([tag.id]);
    let parent = byId.get(tag.parentId);
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      result.push(parent);
      parent = byId.get(parent.parentId);
    }
    return result;
  };

  const descendants = tag => {
    const result = [];
    const visited = new Set([tag.id]);
    const queue = [...(children.get(tag.id) || [])];
    while (queue.length) {
      const next = queue.shift();
      if (visited.has(next.id)) continue;
      visited.add(next.id);
      result.push(next);
      queue.push(...(children.get(next.id) || []));
    }
    return result;
  };

  const path = tag => [...ancestors(tag).reverse(), tag].map(t => t.name).join(' › ');

  return { rows, ancestors, descendants, path };
}

// ─── Filter by the tag being typed ────────────────────────────────────────────
// Only the part after the last comma counts: "news, tec" filters by "tec".

function currentTagTerm(input) {
  return input.value.split(',').pop().trim();
}

// Removes the partly typed tag after the last comma, so picking a tag from the
// filtered list doesn't also save the typed fragment ("tec") as a new tag.
function clearCurrentTagTerm(input) {
  const parts = input.value.split(',');
  parts[parts.length - 1] = '';
  const kept = parts.slice(0, -1).map(p => p.trim()).filter(Boolean);
  input.value = kept.length ? `${kept.join(', ')}, ` : '';
}

// Names of all tags to show for `term`: every tag whose name contains it
// (case- and accent-insensitive), plus their parent tags so the tree stays
// readable. Returns null for an empty term (= show everything).
function visibleTagIds(tree, term) {
  if (!term) return null;
  const norm = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  const needle = norm(term);
  const matches = new Set();
  const visible = new Set();
  for (const { tag } of tree.rows) {
    if (!norm(tag.name).includes(needle)) continue;
    matches.add(tag.id);
    visible.add(tag.id);
    for (const parent of tree.ancestors(tag)) visible.add(parent.id);
  }
  return { matches, visible };
}

// ─── Render the tag tree ──────────────────────────────────────────────────────

// Selecting a sub-tag also selects its parent tags; deselecting a tag also
// deselects its sub-tags, so a sub-tag is never saved without its parent.
// Tags are sent by name; names are unique across the whole tree.
function renderChips(tags, container) {
  const tree = buildTagTree(tags);
  container.replaceChildren();
  container.classList.add('tag-tree');

  const input = $('tagsInput');
  const emptyHint = document.createElement('span');
  emptyHint.className   = 'tags-empty tags-no-match';
  emptyHint.textContent = t('saveDialog_noMatchingTags');
  emptyHint.hidden      = true;

  const rowButtons = [];
  const refresh = () => {
    for (const { button, name } of rowButtons) {
      const selected = selectedChipTags.has(name);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-checked', String(selected));
    }
  };

  for (const { tag, depth } of tree.rows) {
    const row = document.createElement('button');
    row.type      = 'button';
    row.className = 'tag-row';
    row.setAttribute('role', 'checkbox');
    row.style.paddingInlineStart = `${10 + depth * 18}px`;
    if (depth > 0) row.title = tree.path(tag);

    const check = document.createElement('span');
    check.className = 'tag-check';
    const label = document.createElement('span');
    label.className   = 'tag-name';
    label.textContent = tag.name;
    row.append(check, label);

    row.addEventListener('click', () => {
      // Picking a tag while filtering consumes the typed fragment and resets
      // the filter, so the next tag can be typed right away.
      if (currentTagTerm(input)) {
        clearCurrentTagTerm(input);
        applyTagFilter();
        input.focus();
      }
      if (selectedChipTags.has(tag.name)) {
        for (const t of [tag, ...tree.descendants(tag)]) selectedChipTags.delete(t.name);
      } else {
        for (const t of [tag, ...tree.ancestors(tag)]) selectedChipTags.add(t.name);
      }
      refresh();
    });

    rowButtons.push({ button: row, name: tag.name, id: tag.id });
    container.appendChild(row);
  }
  container.appendChild(emptyHint);

  applyTagFilter = () => {
    const filter = visibleTagIds(tree, currentTagTerm(input));
    for (const { button, id } of rowButtons) {
      button.hidden = filter ? !filter.visible.has(id) : false;
      // Parent rows shown only for context are dimmed.
      button.classList.toggle('context-only', !!filter && !filter.matches.has(id));
    }
    emptyHint.hidden = !filter || filter.matches.size > 0;
  };

  refresh();
  applyTagFilter();
}
