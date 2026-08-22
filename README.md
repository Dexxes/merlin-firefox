# Merlin for Firefox

A Firefox extension for saving links and pages to Merlin, a
cross-platform read-it-later app backed by either a Nextcloud instance
([`merlin-nextcloud`](https://github.com/Dexxes/merlin-nextcloud/)) or an independent standalone
server ([`merlin-standalone-server`](https://github.com/Dexxes/merlin-standalone-server)).

Save the page you're viewing, or a link on it, to your Merlin reading list via the
right-click context menu — no separate reader UI, just a fast, one-click save tool.

## Features

- **Save link / save page** from the right-click context menu, with or without tags
- Works against either backend: a Nextcloud instance running the Merlin app, or a
  [`merlin-standalone-server`](https://github.com/Dexxes/merlin-standalone-server)
- **Nextcloud Login Flow v2** support — connect without typing an app password by hand
  (reimplemented identically for the standalone backend)
- Sends the rendered page HTML along with page saves, so paywalled or JS-rendered pages
  don't need a second server-side fetch
- Credentials are stored in `storage.sync` (end-to-end encrypted by Firefox Sync's own
  infrastructure), with a `storage.local` fallback if no Firefox Account is signed in
- Host access to your Merlin server is requested at runtime, scoped to that one origin —
  no standing `<all_urls>` permission
- Animated in-page toast reports save progress/success/failure, with a desktop
  notification fallback on privileged pages (`about:*`, PDF viewer, etc.)
- Localized UI (English, German)

## Requirements

- Firefox 109 or later (Manifest V3)
- A reachable Merlin backend: either a Nextcloud instance with the
  [`merlin-nextcloud`](https://github.com/Dexxes/merlin-nextcloud/) app installed, or a
  [`merlin-standalone-server`](https://github.com/Dexxes/merlin-standalone-server) instance

## Installation

Install from addons.mozilla.org, or load unpacked for development:

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select `manifest.json` in this directory

## Setup

Open the extension's settings page (toolbar icon), choose your backend type (Nextcloud
or standalone server), enter the server URL, and click **Login**. On the
first save (or the first login), Firefox will prompt for permission to access that one
server — this is expected and only needs to be granted once.

## Architecture

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3, optional host permissions) |
| `background.js` | Context menu, save flow, tag resolution, Nextcloud Login Flow polling, in-page toast injection |
| `options.html` / `options.js` | Settings UI: backend selection, login, URL storage |
| `save-dialog.html` / `save-dialog.js` | Popup dialog for entering/selecting tags before saving |
| `i18n.js` | Localization helper |
| `_locales/` | Translated strings (`en`, `de`) |

## Notes

- No persistent content script runs on visited pages — the save toast (`renderFlyout`)
  and the HTML capture (`document.documentElement.outerHTML`) are injected on demand via
  `browser.scripting.executeScript`, only in direct response to a context-menu click.
- Host permission for the configured Merlin server is requested at runtime
  (`optional_host_permissions` + `browser.permissions.request`), not granted at install
  time — see the comments in `background.js` and `options.js`.
- `storage.sync` is preferred over `storage.local` for credentials: Firefox Sync
  encrypts it server-side end-to-end per Firefox Account, so no extension-local
  encryption layer is needed (unlike `merlin-chrome`/`merlin-thunderbird`, which lack an
  equivalent E2E-encrypted sync channel).

## License

AGPL-3.0-or-later — see [LICENCE.md](LICENCE.md).
