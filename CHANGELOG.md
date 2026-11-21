# Changelog

All notable changes to Merlin for Firefox are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning based on
[SemVer](https://semver.org/).

## [1.3.0] - 2026-11-21

### Added
- Nested tags (merlin-nextcloud): the "save with tags" dialog lists existing
  tags as an indented tree with sub-tags below their parent instead of a row
  of chips. Selecting a sub-tag also selects its parent tags; deselecting a
  tag also deselects its sub-tags. Servers without nested tags show a flat list.
- The "save with tags" window is taller (640 px) so the full tag list and the
  buttons fit below the browser's title and address bar.
- The "save with tags" window opens centered on the screen (on multiple
  monitors: the screen the browser window is on).
- Typing in the tag field filters the existing tags by the tag currently being
  typed (the text after the last comma); parent tags of a match stay visible,
  dimmed, for context. Picking a tag from the filtered list replaces the typed
  fragment, so it isn't saved as an extra new tag.

### Changed
- `data_collection_permissions` now declares `browsingActivity` and `websiteContent`
  instead of `none`, matching what a save actually sends to the configured server
- Requires Firefox 140 (`strict_min_version`), the first version with built-in data
  collection consent
- Dropped the `tabs` permission (not needed; `activeTab` covers the context-menu tab)
- Page HTML is only sent up to 10 MB; larger pages are saved by URL only
- A single HTTP 401 no longer logs you out on every synced device; credentials are
  cleared after the second consecutive 401

### Fixed
- Standalone server: tags that could not be resolved or created are now reported
  instead of showing a plain success message, and tags are no longer re-created as
  duplicates when the tag list fails to load
- Saving now times out after 60 s (tag requests after 10 s) instead of leaving the
  loading toast up forever
- Login Flow polling survives Firefox suspending the background page and no longer
  leaves the settings page stuck on "complete login" after a timeout
- Several tag dialogs can be open at once without overwriting each other; closing a
  dialog with the window's close button cleans up its pending entry

### Security
- `http://` server URLs are rejected (except `localhost`), so credentials and page
  content are never sent unencrypted
- Login Flow responses are validated: the poll endpoint must be on the entered
  server, the login page must use `https://`, and the returned credentials must be
  present
- The pending tag-dialog entry no longer stores a copy of the app password
- The in-page toast now lives in a closed shadow root, so page CSS can no longer
  hide or restyle it and page scripts cannot read it

### Internal
- Shared helpers (credentials, URL checks, tag API, notifications) moved to `common.js`
- Context-menu items are only created on install/update; they persist across restarts
- Code comments are now consistently in English

## [1.2.2] - 2026-09-27

### Added
- Added detection of unsupported domains. When an article of such a domain is added
  the extension shows a clear error message

## [1.2.0] - 2026-08-23

### Added
- Save link / save page **with tags** from the context menu, opening a small dialog
  with a tag input and clickable chips for existing tags (`save-dialog.html`/`.js`) —
  brings Firefox to parity with `merlin-thunderbird`
  - Standalone-server saves resolve tag names to IDs via `/api/tags` (creating new
    tags as needed) before submitting, since `merlin-server`'s `/api/articles` takes
    `tagIds` rather than tag names

### Fixed
- Login button no longer says "Login with Nextcloud" when the standalone-server
  backend is selected
- `background.js`'s `getCredentials()` never read `backendKind` from storage, so every
  save silently used the Nextcloud API path (`/index.php/apps/merlin/api/v1/add`) even
  with the standalone-server backend selected, causing a 404. Also repairs installs
  where an earlier version of the storage.local → storage.sync migration moved
  credentials to sync but left `backendKind` stranded in `storage.local`
- Context-menu save no longer tries to re-request the host permission after an
  `await` has already broken the user-gesture chain (Firefox rejects
  `permissions.request()` outside a direct input handler) — it now only checks
  `permissions.contains()` and, if missing, points the user at the settings page,
  matching the pattern already proven in `merlin-thunderbird`
- The settings page's own permission request (`ensureHostPermission()`, used when
  starting the Nextcloud Login Flow) threw the same "permissions.request may only be
  called from a user input handler" error, because it awaited a `permissions.contains()`
  pre-check before calling `request()` — even that one intervening `await` was enough
  to break the click's user-gesture chain in Firefox. `permissions.request()` already
  resolves immediately without a prompt when the permission is present, so the
  pre-check was both unnecessary and the actual cause; removed

### Security
- Host permission for the Merlin server is now requested at runtime, scoped to that
  one origin (`optional_host_permissions` + `browser.permissions.request`), instead of
  a standing `<all_urls>` grant at install time
- `runtime.onMessage` listener now verifies `sender.id` before acting on a message,
  as defense-in-depth against a future messaging-surface expansion
- Login Flow v2: the server URL returned by the poll response is only accepted if it
  is same-origin as the URL the user originally entered, closing a theoretical
  credential-redirect path via a compromised server
- Options page now warns (non-blocking) when the entered server URL uses `http://`,
  since Basic Auth credentials would then be sent unencrypted

## [1.0.0]

Initial release.

### Added
- Save link and save page from the context menu
- Support for `merlin-server` as an alternative backend to Nextcloud, with a
  backend-type toggle in the settings UI
- Nextcloud Login Flow v2 for credential setup without manual app-password entry
  (reimplemented identically for the standalone backend)
- Rendered-HTML capture on page saves, so paywalled/JS-rendered pages don't need a
  second server-side fetch
- Credentials stored in `storage.sync` (Firefox Sync end-to-end encryption), with
  `storage.local` fallback
- Animated in-page toast for save feedback, with desktop-notification fallback on
  privileged pages
- Localization (English, German)
