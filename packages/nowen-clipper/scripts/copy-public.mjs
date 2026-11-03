#!/usr/bin/env node
/**
 * 把 public/ 目录下的 manifest.json、icons、静态 HTML 引用的资源
 * 复制到 dist/，保证装载到浏览器时路径一致。
 *
 * 浏览器目标：
 *   - 默认（无参数 / --browser=chrome）：直接使用 public/manifest.json
 *   - --browser=firefox：**从 Chrome manifest 程序化派生**一份 Firefox 清单
 *     写入 dist/manifest.json，不再读取任何 manifest.firefox.json。
 *
 * 为什么派生而不是维护两份：
 *   之前的做法是让 public/manifest.firefox.json 与 public/manifest.json 并行存放，
 *   两边都手动维护。结果出现了版本号漂移（0.1.0 vs 0.1.1）、权限漂移（Chrome 加了
 *   debugger 但 FF 版忘了同步/过滤）等典型问题。本次改造：
 *
 *     Chrome manifest 是事实源（single source of truth）
 *     → 构建 Firefox 时按已知差异点派生：
 *         1) background.service_worker → background.scripts
 *            Firefox MV3 尚未默认启用 service_worker 字段，加载时会报
 *            "background.service_worker is currently disabled"。
 *         2) 过滤掉 Firefox 不支持的权限（目前：debugger）。
 *            代码侧已经对 chrome.debugger feature-detect 降级，去掉声明不影响功能。
 *         3) 注入 browser_specific_settings.gecko（扩展 id + 最低版本），
 *            否则 AMO 上传会报 missing application id。
 *
 *   这样后续只维护一份 Chrome manifest，FF 清单自动同步。
 *
 * 走"单 manifest 落盘"路线（而不是在 dist 里同时输出两份 manifest）的原因：
 *   浏览器扩展打包工具（web-ext / chrome.zip）只识别根目录下的 manifest.json，
 *   多余的 manifest.firefox.json 在 Chrome Webstore 校验时会触发"unknown manifest field"
 *   误报。所以构建期就一锤定音。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDir = join(root, "public");
const dstDir = join(root, "dist");

// 解析 --browser=xxx 参数
// 支持的目标：
//   - chrome  ：Chrome Web Store
//   - edge    ：Microsoft Edge Add-ons（与 Chrome 同为 Chromium，manifest 完全一致，
//               这里独立出来只是为了让 pack 脚本能产出 -edge 后缀的 zip，方便上传到
//               Edge 商店时不与 Chrome 包混淆）
//   - firefox ：Firefox Add-ons（AMO），需要派生 manifest，见 deriveFirefoxManifest
const browserArg = process.argv.find((a) => a.startsWith("--browser="));
const browser = browserArg ? browserArg.slice("--browser=".length) : "chrome";
if (!["chrome", "edge", "firefox"].includes(browser)) {
  console.error(`[copy-public] 未知的 --browser=${browser}，只支持 chrome | edge | firefox`);
  process.exit(1);
}

if (!existsSync(srcDir)) {
  console.warn("[copy-public] public/ 不存在，跳过");
  process.exit(0);
}
if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

// 1. 拷贝除 manifest*.json 之外的所有静态资源（图标 / 共享文件）。
//    manifest 由后续步骤按 browser 选择性拷贝，避免 dist 里同时存在两份导致混淆。
function walk(from, to) {
  for (const entry of readdirSync(from)) {
    if (/^manifest(\..+)?\.json$/i.test(entry)) continue;
    const src = join(from, entry);
    const dst = join(to, entry);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
      walk(src, dst);
    } else {
      copyFileSync(src, dst);
    }
  }
}
walk(srcDir, dstDir);

// 2. 按目标浏览器选择 manifest：
//    - chrome  → 直接拷贝 public/manifest.json
//    - firefox → 从 public/manifest.json 派生（见文件顶部注释）
const chromeManifestPath = join(srcDir, "manifest.json");
if (!existsSync(chromeManifestPath)) {
  console.error(`[copy-public] 缺少 ${chromeManifestPath}`);
  process.exit(1);
}

if (browser !== "firefox") {
  copyFileSync(chromeManifestPath, join(dstDir, "manifest.json"));
} else {
  // ---- Firefox 派生 ----
  const chromeManifest = JSON.parse(readFileSync(chromeManifestPath, "utf8"));
  const ff = deriveFirefoxManifest(chromeManifest);
  writeFileSync(
    join(dstDir, "manifest.json"),
    JSON.stringify(ff, null, 2) + "\n",
    "utf8",
  );
}

/**
 * 从 Chrome MV3 manifest 派生 Firefox MV3 manifest。
 *
 * 差异点：
 *   1) background.service_worker → background.scripts（Firefox MV3 尚未默认启用
 *      service_worker 字段；用 event page 的 scripts 形式，行为一致）。
 *   2) permissions 过滤：剔除 Firefox 不支持或声明即拒收的权限（当前只有 debugger）。
 *   3) browser_specific_settings.gecko：注入扩展 id、strict_min_version 与
 *      data_collection_permissions。其中 data_collection_permissions 是 Firefox
 *      自 2025 年起对所有新上传/新版本扩展强制要求的字段（AMO 校验会直接报错）。
 *      Nowen Clipper 仅把用户主动剪藏的网页内容发送到用户自建的 nowen-note 后端，
 *      扩展作者不接收任何数据，所以声明 required=["none"]。若未来加入任何 telemetry
 *      / 崩溃上报等，必须同步更新这里（见 https://mzl.la/firefox-builtin-data-consent）。
 *
 * 其他字段（name/description/version/action/commands/host_permissions/content_scripts/
 * web_accessible_resources/icons/options_ui）两边等价，直通即可。这里用浅拷贝 + 覆写
 * 需要的字段，未显式覆写的字段原样透传——未来 Chrome manifest 加新字段自动生效，
 * 若是 Firefox 不认的字段再按需加入 FF_UNSUPPORTED 黑名单。
 *
 * @param {Record<string, unknown>} chrome
 * @returns {Record<string, unknown>}
 */
function deriveFirefoxManifest(chrome) {
  // Firefox 不支持（或声明即拒）的权限；按需扩展。
  const FF_UNSUPPORTED_PERMISSIONS = new Set(["debugger"]);

  const out = { ...chrome };

  // 1) background
  if (chrome.background && typeof chrome.background === "object") {
    const bg = { ...chrome.background };
    if (bg.service_worker) {
      bg.scripts = [bg.service_worker];
      delete bg.service_worker;
    }
    out.background = bg;
  }

  // 2) permissions 过滤
  if (Array.isArray(chrome.permissions)) {
    out.permissions = chrome.permissions.filter(
      (p) => !FF_UNSUPPORTED_PERMISSIONS.has(p),
    );
  }

  // 3) gecko 标识（固定 id，升级不会触发"新扩展"身份断裂）
  //    data_collection_permissions 是 Firefox 128+ 才认识的字段，因此把
  //    strict_min_version 提到 128.0；低于此版本的 Firefox 本来也不会校验该字段。
  out.browser_specific_settings = {
    gecko: {
      id: "nowen-clipper@nowen-note",
      strict_min_version: "128.0",
      data_collection_permissions: {
        // 扩展作者端不收集任何数据；用户内容仅发送到用户自建后端。
        required: ["none"],
      },
    },
  };

  return out;
}

// 3. 顺手清掉历史构建可能残留的 manifest.firefox.json。
const stale = join(dstDir, "manifest.firefox.json");
if (existsSync(stale)) rmSync(stale);

// vite 把 HTML entry 输出到 dist/src/popup/index.html 这种位置。
// 我们希望 manifest 里的 popup/index.html 指向 dist/popup/index.html。
// 这一步由 vite 的 input 配置 + output.assetFileNames 控制，不在这里处理。

console.log(`[copy-public] 已复制 public/ → dist/（target=${browser}）`);
