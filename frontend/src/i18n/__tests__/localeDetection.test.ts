import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../index";
import {
  detectPreferredLanguage,
  isChineseLanguage,
  normalizeAppLanguage,
  syncDocumentLanguage,
} from "../locale";

describe("frontend locale normalization and detection", () => {
  afterEach(() => {
    delete (window as unknown as { nowenDesktop?: unknown }).nowenDesktop;
  });

  it("maps Chinese locales to zh-CN and all non-Chinese or empty locales to en", () => {
    for (const locale of ["zh", "zh-CN", "zh-TW", "zh-HK", "zh-Hans", "zh_CN.UTF-8", "ZH-SG"]) {
      expect(normalizeAppLanguage(locale)).toBe("zh-CN");
      expect(isChineseLanguage(locale)).toBe(true);
    }

    for (const locale of ["en", "en-US", "en-GB", "ja-JP", "ko-KR", "fr-FR", "de-DE", "C", "POSIX", "", null, undefined]) {
      expect(normalizeAppLanguage(locale)).toBe("en");
      expect(isChineseLanguage(locale)).toBe(false);
    }
  });

  it("respects priority: storedLanguage > desktopSystemLocale > navigatorLanguages > navigatorLanguage > en", () => {
    expect(
      detectPreferredLanguage({
        storedLanguage: "zh-CN",
        desktopSystemLocale: "en",
        navigatorLanguages: ["ja-JP"],
        navigatorLanguage: "fr-FR",
      }),
    ).toBe("zh-CN");

    expect(
      detectPreferredLanguage({
        storedLanguage: null,
        desktopSystemLocale: "en",
        navigatorLanguages: ["zh-CN"],
        navigatorLanguage: "zh-CN",
      }),
    ).toBe("en");

    expect(
      detectPreferredLanguage({
        storedLanguage: null,
        desktopSystemLocale: "zh-CN",
        navigatorLanguages: ["en-US"],
        navigatorLanguage: "en-US",
      }),
    ).toBe("zh-CN");

    expect(
      detectPreferredLanguage({
        storedLanguage: null,
        desktopSystemLocale: null,
        navigatorLanguages: ["ja-JP", "zh-CN"],
        navigatorLanguage: "zh-CN",
      }),
    ).toBe("en");

    expect(
      detectPreferredLanguage({
        storedLanguage: null,
        desktopSystemLocale: null,
        navigatorLanguages: ["zh-TW", "en-US"],
        navigatorLanguage: "en-US",
      }),
    ).toBe("zh-CN");

    expect(detectPreferredLanguage({})).toBe("en");
  });

  it("uses en as i18n fallbackLng and syncs documentElement.lang & desktop bridge on language change", async () => {
    expect(i18n.options.fallbackLng).toEqual(["en"]);
    const setLanguage = vi.fn();
    (window as unknown as { nowenDesktop?: unknown }).nowenDesktop = { isDesktop: true, setLanguage };

    await i18n.changeLanguage("en");
    expect(document.documentElement.lang).toBe("en");
    expect(setLanguage).toHaveBeenLastCalledWith("en");

    await i18n.changeLanguage("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(setLanguage).toHaveBeenLastCalledWith("zh-CN");

    expect(syncDocumentLanguage("fr-FR")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
