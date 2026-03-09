/**
 * electron-builder 配置
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: "com.nowen.note",
  productName: "Nowen Note",
  directories: {
    output: "release",
  },
  files: [
    "electron/**/*",
    "!electron/builder.config.js",
  ],
  extraResources: [
    {
      from: "backend/dist",
      to: "backend/dist",
      filter: ["**/*"],
    },
    {
      from: "backend/node_modules",
      to: "backend/node_modules",
      filter: ["**/*"],
    },
    {
      from: "backend/package.json",
      to: "backend/package.json",
    },
    {
      from: "backend/templates",
      to: "backend/templates",
      filter: ["**/*"],
    },
    {
      from: "frontend/dist",
      to: "frontend/dist",
      filter: ["**/*"],
    },
  ],
  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"],
      },
    ],
    icon: "electron/icon.png",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Nowen Note",
  },
  mac: {
    target: ["dmg"],
    icon: "electron/icon.png",
    category: "public.app-category.productivity",
  },
  linux: {
    target: ["AppImage"],
    icon: "electron/icon.png",
    category: "Office",
  },
};
