#!/usr/bin/env node
/**
 * 一次性脚本：根据简约设计重新生成 Android legacy mipmap PNG 图标
 *
 * - 读取：frontend/android/app/src/main/res/drawable/ic_launcher_foreground.xml
 *   已经表达的视觉（便签 + 镂空 N），重构成一份独立 SVG（legacy 版只需要 "完整图标"
 *   而不是前景 + 背景分层），背景同样用 #F5F3EE 奶白。
 * - 输出：5 个密度（mdpi 48 / hdpi 72 / xhdpi 96 / xxhdpi 144 / xxxhdpi 192），
 *   每个密度生成 ic_launcher.png（方形）和 ic_launcher_round.png（圆形蒙版）。
 * - Adaptive icon（Android 8.0+）仍由 drawable/ic_launcher_foreground.xml +
 *   drawable/ic_launcher_background.xml 提供，这里只兜底 Android 7-。
 *
 * 用法：node scripts/regen-android-icons.mjs
 * 依赖：根 node_modules/sharp
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RES_DIR = path.join(
    REPO_ROOT,
    "frontend",
    "android",
    "app",
    "src",
    "main",
    "res",
);

// 与 adaptive icon foreground/background 保持一致的配色 —— 简约、无黑色
const BG = "#F5F3EE"; // 奶白
const FG = "#4F6BED"; // 靛蓝

// legacy 图标用整张 108×108（含背景），viewBox 与 adaptive 保持一致
// 注意：legacy 图标没有 72×72 的安全区裁切概念，可以占满整个 108×108，
// 因此正方形内我们让便签比 adaptive 前景略大一圈，视觉更饱满。
const squareSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <rect width="108" height="108" rx="22" ry="22" fill="${BG}"/>
  <!-- 便签主体（比 adaptive 前景略大，因为 legacy 没有 72 安全区限制） -->
  <path fill="${FG}"
        d="M28,18 L78,18 L92,32 L92,84 Q92,90 86,90 L26,90 Q20,90 20,84 L20,24 Q20,18 26,18 Z
           M78,18 L78,32 L92,32 Z"/>
  <!-- 折角挖空 -->
  <path fill="${BG}" d="M78,18 L78,32 L92,32 Z"/>
  <!-- 折角内缘描边 -->
  <path fill="none" stroke="${FG}" stroke-width="1.5"
        d="M78,18 L78,32 L92,32"/>
  <!-- 镂空 N -->
  <path fill="${BG}"
        d="M34,36 L42,36 L70,68 L70,36 L78,36 L78,76 L70,76 L42,44 L42,76 L34,76 Z"/>
</svg>
`;

// 圆形版用同一张 SVG + 圆形 mask
const roundSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <defs>
    <clipPath id="c"><circle cx="54" cy="54" r="54"/></clipPath>
  </defs>
  <g clip-path="url(#c)">
    <rect width="108" height="108" fill="${BG}"/>
    <path fill="${FG}"
          d="M28,18 L78,18 L92,32 L92,84 Q92,90 86,90 L26,90 Q20,90 20,84 L20,24 Q20,18 26,18 Z
             M78,18 L78,32 L92,32 Z"/>
    <path fill="${BG}" d="M78,18 L78,32 L92,32 Z"/>
    <path fill="none" stroke="${FG}" stroke-width="1.5"
          d="M78,18 L78,32 L92,32"/>
    <path fill="${BG}"
          d="M34,36 L42,36 L70,68 L70,36 L78,36 L78,76 L70,76 L42,44 L42,76 L34,76 Z"/>
  </g>
</svg>
`;

// Adaptive foreground 的位图回退（108×108，透明底），用于 mipmap-*/ic_launcher_foreground.png
// 这些 PNG 只有老主题 / 个别启动器会读，但原项目已有，保持同步避免视觉不一致
const foregroundSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <path fill="${FG}"
        d="M34,22 L80,22 L90,32 L90,80 Q90,86 84,86 L30,86 Q24,86 24,80 L24,28 Q24,22 30,22 Z
           M80,22 L80,32 L90,32 Z"/>
  <path fill="${BG}" d="M80,22 L80,32 L90,32 Z"/>
  <path fill="none" stroke="${FG}" stroke-width="1.5"
        d="M80,22 L80,32 L90,32"/>
  <path fill="${BG}"
        d="M38,38 L45,38 L71,68 L71,38 L78,38 L78,74 L71,74 L45,44 L45,74 L38,74 Z"/>
</svg>
`;

// 标准 mipmap 密度尺寸（单位：px）
const DENSITIES = [
    { dir: "mipmap-mdpi", size: 48 },
    { dir: "mipmap-hdpi", size: 72 },
    { dir: "mipmap-xhdpi", size: 96 },
    { dir: "mipmap-xxhdpi", size: 144 },
    { dir: "mipmap-xxxhdpi", size: 192 },
];

async function renderPng(svg, size, outFile) {
    await sharp(Buffer.from(svg))
        .resize(size, size, { fit: "contain" })
        .png({ compressionLevel: 9 })
        .toFile(outFile);
    const kb = (fs.statSync(outFile).size / 1024).toFixed(2);
    console.log(`  wrote ${path.relative(REPO_ROOT, outFile)}  ${size}px  ${kb} KB`);
}

async function main() {
    for (const d of DENSITIES) {
        const dir = path.join(RES_DIR, d.dir);
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[${d.dir}]`);
        await renderPng(squareSvg, d.size, path.join(dir, "ic_launcher.png"));
        await renderPng(roundSvg, d.size, path.join(dir, "ic_launcher_round.png"));
        // adaptive 前景的位图回退：同密度尺寸，透明底
        await renderPng(
            foregroundSvg,
            d.size,
            path.join(dir, "ic_launcher_foreground.png"),
        );
    }
    console.log("\nDone. Next: cd frontend && npm run cap:release");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
