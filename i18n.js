'use strict';

// ─── Static page localization via browser.i18n ────────────────────────────────
//
// browser.i18n does not replace __MSG_*__ placeholders in HTML (only in
// manifest.json and CSS). Extension pages therefore fill in their texts at
// runtime: elements name their message via data-i18n / data-i18n-placeholder /
// data-i18n-title, and this function inserts the translated strings.
//
// The message names are the keys of _locales/<lang>/messages.json. Those
// files are generated from the merlin-translations repository
// (https://github.com/Dexxes/merlin-translations, webext.* namespace) with
// `python3 export.py --platform webext` — never edit them by hand. See
// "Localization" in README.md.

function localizePage() {
  const msg = (key) => browser.i18n.getMessage(key);

  // Match the document language to the UI language actually used, so screen
  // readers and hyphenation pick the right language.
  document.documentElement.lang = browser.i18n.getUILanguage();

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const text = msg(el.dataset.i18n);
    if (text) el.textContent = text;
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const text = msg(el.dataset.i18nPlaceholder);
    if (text) el.placeholder = text;
  });

  // Page title: data-i18n-title on the <html> element.
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey) {
    const text = msg(titleKey);
    if (text) document.title = text;
  }
}

document.addEventListener('DOMContentLoaded', localizePage);
