#!/usr/bin/env node
/**
 * 同步移动端 App 图标到桌面端 Electron 图标。
 *
 * 单一来源：electron/icon.png（由 npm run build:icon 从 frontend/public/favicon.svg 生成）
 * 输出：
 *   - Android launcher icon：frontend/android/app/src/main/res/mipmap-<density>/ic_launcher*.png
 *   - Android adaptive icon 配置：mipmap-anydpi-v26/ic_launcher*.xml + values/ic_launcher_background.xml
 *   - iOS AppIcon：frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SOURCE_ICON = path.join(REPO_ROOT, "electron", "icon.png");
const ANDROID_RES_DIR = path.join(REPO_ROOT, "frontend", "android", "app", "src", "main", "res");
const IOS_ICON = path.join(
  REPO_ROOT,
  "frontend",
  "ios",
  "App",
  "App",
  "Assets.xcassets",
  "AppIcon.appiconset",
  "AppIcon-512@2x.png",
);

const BACKGROUND = "#FFFFFF";
const DENSITIES = [
  { dir: "mipmap-mdpi", size: 48 },
  { dir: "mipmap-hdpi", size: 72 },
  { dir: "mipmap-xhdpi", size: 96 },
  { dir: "mipmap-xxhdpi", size: 144 },
  { dir: "mipmap-xxxhdpi", size: 192 },
];

function ensureFile(file) {
  if (!fs.existsSync(file)) {
    console.error(`[sync-mobile-icons] 找不到源图标：${file}`);
    console.error("请先运行：npm run build:icon");
    process.exit(1);
  }
}

async function sourcePng(size) {
  return sharp(SOURCE_ICON)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function renderSquare(size, outFile) {
  const icon = await sourcePng(size);
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: BACKGROUND,
    },
  })
    .composite([{ input: icon, gravity: "center" }])
    .flatten({ background: BACKGROUND })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(outFile);
}

async function renderRound(size, outFile) {
  const icon = await sourcePng(size);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: BACKGROUND,
    },
  })
    .composite([{ input: icon, gravity: "center" }, { input: mask, blend: "dest-in" }])
    .png({ compressionLevel: 9 })
    .toFile(outFile);
}

async function renderForeground(size, outFile) {
  // Adaptive Icon 的 foreground 保持透明背景，background 单独由 @color/ic_launcher_background 提供。
  // 这里直接使用桌面图标的完整透明画布，确保 logo 与桌面端一致。
  await sharp(SOURCE_ICON)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(outFile);
}

async function renderIosIcon() {
  fs.mkdirSync(path.dirname(IOS_ICON), { recursive: true });
  const icon = await sourcePng(1024);
  await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: BACKGROUND,
    },
  })
    .composite([{ input: icon, gravity: "center" }])
    .flatten({ background: BACKGROUND })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(IOS_ICON);
  logWrite(IOS_ICON, 1024);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  console.log(`  wrote ${path.relative(REPO_ROOT, file)}`);
}

function logWrite(file, size) {
  const kb = (fs.statSync(file).size / 1024).toFixed(2);
  console.log(`  wrote ${path.relative(REPO_ROOT, file)}  ${size}px  ${kb} KB`);
}

function syncAdaptiveIconXml() {
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
  writeText(path.join(ANDROID_RES_DIR, "mipmap-anydpi-v26", "ic_launcher.xml"), adaptive);
  writeText(path.join(ANDROID_RES_DIR, "mipmap-anydpi-v26", "ic_launcher_round.xml"), adaptive);
  writeText(
    path.join(ANDROID_RES_DIR, "values", "ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BACKGROUND}</color>
</resources>
`,
  );
}

async function renderAndroidIcons() {
  syncAdaptiveIconXml();
  for (const d of DENSITIES) {
    const dir = path.join(ANDROID_RES_DIR, d.dir);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[${d.dir}]`);
    const square = path.join(dir, "ic_launcher.png");
    const round = path.join(dir, "ic_launcher_round.png");
    const foreground = path.join(dir, "ic_launcher_foreground.png");
    await renderSquare(d.size, square);
    logWrite(square, d.size);
    await renderRound(d.size, round);
    logWrite(round, d.size);
    await renderForeground(d.size, foreground);
    logWrite(foreground, d.size);
  }
}

async function main() {
  ensureFile(SOURCE_ICON);
  console.log(`[sync-mobile-icons] source: ${path.relative(REPO_ROOT, SOURCE_ICON)}`);
  await renderAndroidIcons();
  await renderIosIcon();
  console.log("\nDone. Mobile app icons now match the desktop Electron logo.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
