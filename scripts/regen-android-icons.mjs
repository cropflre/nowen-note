#!/usr/bin/env node
/**
 * 兼容旧命令：Android 图标生成已统一到 sync-mobile-icons.mjs。
 *
 * 旧脚本曾在文件内硬编码一套 Android 专用图标，容易和桌面端 Electron 图标不一致。
 * 统一以 frontend/public/favicon.svg 为图标源，生成 Android、iOS 和 HarmonyOS 图标。
 */
import "./sync-mobile-icons.mjs";
