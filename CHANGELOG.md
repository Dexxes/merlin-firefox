# Changelog

All notable changes to Merlin for Firefox are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning based on
[SemVer](https://semver.org/).

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
