"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const {
  normalizeLocale,
  resolveSystemLocale,
  isChineseLocale,
} = require("../locale");

test("normalizeLocale maps Chinese locales to zh-CN and non-Chinese/POSIX to en", () => {
  for (const value of ["zh", "zh-CN", "zh_CN.UTF-8", "zh-TW", "zh-HK", "zh-Hans-CN"]) {
    assert.equal(normalizeLocale(value), "zh-CN", `expected zh-CN for ${value}`);
    assert.equal(isChineseLocale(value), true);
  }

  for (const value of ["en", "en_US.UTF-8", "ja_JP.UTF-8", "fr_FR.UTF-8", "ko-KR", "C", "C.UTF-8", "POSIX"]) {
    assert.equal(normalizeLocale(value), "en", `expected en for ${value}`);
    assert.equal(isChineseLocale(value), false);
  }

  assert.equal(normalizeLocale(""), null);
  assert.equal(normalizeLocale("   "), null);
  assert.equal(normalizeLocale(undefined), null);
});

test("resolveSystemLocale prioritizes LC_ALL > LC_MESSAGES > LANG > appLocale > intlLocale > en", () => {
  assert.equal(
    resolveSystemLocale({
      env: { LC_ALL: "en_US.UTF-8", LC_MESSAGES: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8" },
      appLocale: "zh-CN",
    }),
    "en",
  );

  assert.equal(
    resolveSystemLocale({
      env: { LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US.UTF-8" },
      appLocale: "en-US",
    }),
    "zh-CN",
  );

  assert.equal(
    resolveSystemLocale({
      env: { LANG: "C" },
      appLocale: "zh-CN",
    }),
    "en",
  );

  assert.equal(
    resolveSystemLocale({
      env: { LANG: "ja_JP.UTF-8" },
      appLocale: "zh-CN",
    }),
    "en",
  );

  assert.equal(
    resolveSystemLocale({
      env: {},
      appLocale: "zh-CN",
    }),
    "zh-CN",
  );

  assert.equal(
    resolveSystemLocale({
      env: {},
      appLocale: "de-DE",
    }),
    "en",
  );

  assert.equal(
    resolveSystemLocale({
      env: {},
      appLocale: "",
      intlLocale: "fr-FR",
    }),
    "en",
  );
});

function loadWithMockElectron(modulePath) {
  const originalLoad = Module._load;
  const mockElectron = {
    Menu: {
      buildFromTemplate: (template) => template,
      setApplicationMenu: () => {},
      getApplicationMenu: () => null,
    },
    app: {
      name: "Nowen Note",
      isPackaged: true,
      getLocale: () => "en-US",
      quit: () => {},
    },
    shell: { openExternal: () => {} },
    BrowserWindow: {
      getFocusedWindow: () => null,
      getAllWindows: () => [],
    },
    Tray: function MockTray() {},
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  };

  delete require.cache[require.resolve(modulePath)];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return mockElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test("menu and tray templates follow zh-CN and fall back to English for non-Chinese locales", () => {
  const { buildMenuTemplate } = loadWithMockElectron("../menu");
  const { buildTrayMenuTemplate } = loadWithMockElectron("../tray");

  const enMenu = buildMenuTemplate({ locale: "ja-JP", appName: "Nowen Note", isDev: false });
  const zhMenu = buildMenuTemplate({ locale: "zh-CN", appName: "Nowen Note", isDev: false });

  assert.ok(enMenu.some((item) => String(item.label).includes("File")));
  assert.ok(enMenu.some((item) => String(item.label).includes("Edit")));
  assert.ok(zhMenu.some((item) => String(item.label).includes("文件")));
  assert.ok(zhMenu.some((item) => String(item.label).includes("编辑")));

  const enTray = buildTrayMenuTemplate({ locale: "fr-FR", mode: "full" });
  const zhTray = buildTrayMenuTemplate({ locale: "zh-CN", mode: "full" });

  assert.equal(enTray[0].label, "Show Window");
  assert.equal(enTray[1].label, "New Note");
  assert.equal(enTray[enTray.length - 1].label, "Quit");

  assert.equal(zhTray[0].label, "显示主窗口");
  assert.equal(zhTray[1].label, "新建笔记");
  assert.equal(zhTray[zhTray.length - 1].label, "退出");
});
