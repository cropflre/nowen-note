#!/usr/bin/env node
/**
 * 从 frontend/public/favicon.svg 同步移动端 App 图标。
 * 输出：
 *   - Android launcher icon：frontend/android/app/src/main/res/mipmap-<density>/ic_launcher*.png
 *   - Android adaptive icon 配置：mipmap-anydpi-v26/ic_launcher*.xml + values/ic_launcher_background.xml
 *   - iOS AppIcon：frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
 *   - HarmonyOS 应用图标：AppScope 与 entry 下的分层图标和启动窗口图标
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SOURCE_ICON = path.join(REPO_ROOT, "frontend", "public", "favicon.svg");
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

const HARMONY_MEDIA_DIRS = ["AppScope", "entry/src/main"].map((scope) =>
  path.join(REPO_ROOT, "nowen-harmony", scope, "resources", "base", "media"),
);
const ICON_SIZE = 1024;
const ANDROID_BACKGROUND = "#101F37";
const DENSITIES = [
  { dir: "mipmap-mdpi", size: 48 },
  { dir: "mipmap-hdpi", size: 72 },
  { dir: "mipmap-xhdpi", size: 96 },
  { dir: "mipmap-xxhdpi", size: 144 },
  { dir: "mipmap-xxxhdpi", size: 192 },
];

function renderSvg(svg) {
  return sharp(Buffer.from(svg, "utf8"), { density: (72 * ICON_SIZE) / 32 })
    .resize(ICON_SIZE, ICON_SIZE)
    .png({ compressionLevel: 9 });
}

async function resizeIcon(icon, size, outFile) {
  await sharp(icon).resize(size, size).png({ compressionLevel: 9 }).toFile(outFile);
  logWrite(outFile, size);
}

async function renderRound(icon, size, outFile) {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
    "utf8",
  );
  await sharp(icon)
    .resize(size, size)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png({ compressionLevel: 9 })
    .toFile(outFile);
  logWrite(outFile, size);
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
    <color name="ic_launcher_background">${ANDROID_BACKGROUND}</color>
</resources>
`,
  );
}

async function renderAndroidIcons(squareIcon, adaptiveForeground) {
  syncAdaptiveIconXml();
  for (const d of DENSITIES) {
    const dir = path.join(ANDROID_RES_DIR, d.dir);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[${d.dir}]`);
    await resizeIcon(squareIcon, d.size, path.join(dir, "ic_launcher.png"));
    await renderRound(squareIcon, d.size, path.join(dir, "ic_launcher_round.png"));
    // 常规图标画布为 48dp，Adaptive Icon 的每一层使用 108dp。
    const layerSize = (d.size * 108) / 48;
    await resizeIcon(adaptiveForeground, layerSize, path.join(dir, "ic_launcher_foreground.png"));
  }
}

async function renderHarmonyIcons(svg, backgroundSvg, foregroundSvg) {
  const background = await renderSvg(backgroundSvg).removeAlpha().toBuffer();
  const foreground = await renderSvg(foregroundSvg).toBuffer();
  for (const dir of HARMONY_MEDIA_DIRS) {
    writeText(path.join(dir, "app_icon.svg"), svg);
    fs.writeFileSync(path.join(dir, "icon_background.png"), background);
    fs.writeFileSync(path.join(dir, "icon_foreground.png"), foreground);
    logWrite(path.join(dir, "icon_background.png"), ICON_SIZE);
    logWrite(path.join(dir, "icon_foreground.png"), ICON_SIZE);
  }
}

async function main() {
  const svg = fs.readFileSync(SOURCE_ICON, "utf8");
  const backgroundTag = /<rect id="icon-background"[^>]*\/>/;
  const markTag = '<g id="icon-mark">';
  if (!backgroundTag.test(svg) || !svg.includes(markTag)) {
    throw new Error("favicon.svg 需要 icon-background 和 icon-mark 图层");
  }

  const squareSvg = svg.replace(backgroundTag, (tag) => tag.replace(/\s+rx="[^"]*"/, ""));
  const foregroundSvg = svg.replace(backgroundTag, "");
  const backgroundSvg = squareSvg.replace(markTag, '<g id="icon-mark" display="none">');
  // 将图形居中缩至 75%，让外缘进入 Android 66dp 的圆形安全区。
  const adaptiveSvg = foregroundSvg.replace(
    markTag,
    '<g id="icon-mark" transform="translate(4 4) scale(0.75)">',
  );

  const squareIcon = await renderSvg(squareSvg).removeAlpha().toBuffer();
  const adaptiveForeground = await renderSvg(adaptiveSvg).toBuffer();
  await renderAndroidIcons(squareIcon, adaptiveForeground);

  fs.mkdirSync(path.dirname(IOS_ICON), { recursive: true });
  fs.writeFileSync(IOS_ICON, squareIcon);
  logWrite(IOS_ICON, ICON_SIZE);

  await renderHarmonyIcons(svg, backgroundSvg, foregroundSvg);
}

main().catch((error) => {
  console.error("[sync-mobile-icons] 生成失败", error);
  process.exit(1);
});
