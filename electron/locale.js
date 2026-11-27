"use strict";

const CHINESE_LOCALE_RE = /^zh(?:[-_.]|$)/i;
const POSIX_DEFAULT_RE = /^(?:C|POSIX)(?:\..+)?$/i;

/**
 * Normalize a POSIX / BCP 47 locale tag into "zh-CN" or "en".
 * Returns null only when input is empty or non-string.
 */
function normalizeLocale(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (POSIX_DEFAULT_RE.test(trimmed)) return "en";
  return CHINESE_LOCALE_RE.test(trimmed) ? "zh-CN" : "en";
}

/**
 * Resolve the desktop system language from POSIX environment variables and Electron/OS locale.
 *
 * Priority:
 *   1. LC_ALL
 *   2. LC_MESSAGES
 *   3. LANG
 *   4. Electron app.getLocale() (passed in as appLocale)
 *   5. Intl.DateTimeFormat().resolvedOptions().locale (passed in as intlLocale)
 *   6. Fallback: "en"
 *
 * Any non-Chinese locale (including "C" / "POSIX", "ja_JP.UTF-8", "fr-FR", etc.) falls back to "en".
 */
function resolveSystemLocale({ env = process.env, appLocale, intlLocale } = {}) {
  const safeEnv = env && typeof env === "object" ? env : {};
  const candidates = [
    safeEnv.LC_ALL,
    safeEnv.LC_MESSAGES,
    safeEnv.LANG,
    appLocale,
    intlLocale,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }

  try {
    const runtimeLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    const normalized = normalizeLocale(runtimeLocale);
    if (normalized) return normalized;
  } catch {
    // Ignore Intl errors in restricted runtimes.
  }

  return "en";
}

function isChineseLocale(locale) {
  return normalizeLocale(locale) === "zh-CN";
}

module.exports = {
  normalizeLocale,
  resolveSystemLocale,
  isChineseLocale,
};
