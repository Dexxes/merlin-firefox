'use strict';

// ─── Statische Seiten-Lokalisierung via browser.i18n ─────────────────────────
//
// browser.i18n ersetzt in HTML keine __MSG_*__-Platzhalter automatisch (das
// passiert nur in manifest.json und CSS). Für Erweiterungsseiten füllen wir
// die Texte daher zur Laufzeit: Elemente markieren ihren Message-Namen über
// data-i18n / data-i18n-placeholder / data-i18n-title, diese Funktion trägt
// die übersetzten Strings ein. Die Message-Namen entsprechen den Keys aus
// _locales/<lang>/messages.json (generiert aus localization/strings/*.json,
// siehe tools/i18n/export.py — niemals direkt editieren).

function localizePage() {
  const msg = (key) => browser.i18n.getMessage(key);

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const text = msg(el.dataset.i18n);
    if (text) el.textContent = text;
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const text = msg(el.dataset.i18nPlaceholder);
    if (text) el.placeholder = text;
  });

  // Seitentitel: data-i18n-title am <html>-Element.
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey) {
    const text = msg(titleKey);
    if (text) document.title = text;
  }
}

document.addEventListener('DOMContentLoaded', localizePage);
