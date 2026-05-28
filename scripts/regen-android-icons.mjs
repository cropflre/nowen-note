#!/usr/bin/env node
/**
 * 兼容旧命令：Android 图标生成已统一到 sync-mobile-icons.mjs。
 *
 * 旧脚本曾在文件内硬编码一套 Android 专用图标，容易和桌面端 Electron 图标不一致。
 * 现在统一以 electron/icon.png 为单一来源，同时生成 Android 与 iOS App Icon。
 */
import "./sync-mobile-icons.mjs";
