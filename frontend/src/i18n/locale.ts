export type SupportedAppLanguage = "zh-CN" | "en";

const CHINESE_LOCALE_RE = /^zh(?:[-_.]|$)/i;

/**
 * Normalize any BCP 47 / POSIX locale string (e.g. "zh-CN", "zh_TW.UTF-8", "en-US", "ja-JP", "C", "POSIX")
 * to one of the two app languages: Chinese ("zh-CN") or English ("en").
 * Any non-Chinese or empty locale falls back to "en".
 */
export function normalizeAppLanguage(raw?: string | null): SupportedAppLanguage {
  if (typeof raw !== "string") return "en";
  const trimmed = raw.trim();
  if (!trimmed) return "en";
  return CHINESE_LOCALE_RE.test(trimmed) ? "zh-CN" : "en";
}

export function isChineseLanguage(raw?: string | null): boolean {
  return normalizeAppLanguage(raw) === "zh-CN";
}

export interface DetectPreferredLanguageOptions {
  storedLanguage?: string | null;
  desktopSystemLocale?: string | null;
  navigatorLanguages?: readonly string[] | null;
  navigatorLanguage?: string | null;
}

/**
 * Resolve the initial app language across Web, Electron Desktop, and Mobile WebViews.
 * Priority:
 *   1. User-selected language stored in localStorage ("i18nextLng")
 *   2. Desktop host system locale (resolved from LC_ALL / LC_MESSAGES / LANG / app.getLocale())
 *   3. Browser / Mobile WebView navigator.languages / navigator.language
 * Non-Chinese or missing locales always fall back to "en".
 */
export function detectPreferredLanguage(
  options: DetectPreferredLanguageOptions = {},
): SupportedAppLanguage {
  const candidates: Array<string | null | undefined> = [
    options.storedLanguage,
    options.desktopSystemLocale,
    ...(Array.isArray(options.navigatorLanguages) ? options.navigatorLanguages : []),
    options.navigatorLanguage,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    return normalizeAppLanguage(trimmed);
  }

  return "en";
}

export function readStoredLanguage(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem("i18nextLng") : null;
  } catch {
    return null;
  }
}

export function readDesktopSystemLocale(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const desktop = (window as unknown as { nowenDesktop?: { systemLocale?: unknown } }).nowenDesktop;
    return typeof desktop?.systemLocale === "string" && desktop.systemLocale.trim()
      ? desktop.systemLocale.trim()
      : null;
  } catch {
    return null;
  }
}

export function detectRuntimeLanguage(): SupportedAppLanguage {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return detectPreferredLanguage({
    storedLanguage: readStoredLanguage(),
    desktopSystemLocale: readDesktopSystemLocale(),
    navigatorLanguages: nav?.languages,
    navigatorLanguage: nav?.language,
  });
}

export function syncDocumentLanguage(language?: string | null): SupportedAppLanguage {
  const normalized = normalizeAppLanguage(language);
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = normalized;
    }
  } catch {
    // Ignore environments without DOM access.
  }
  return normalized;
}
