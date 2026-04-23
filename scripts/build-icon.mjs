/**
 * 把 frontend/public/favicon.svg 栅格化成 PC 端打包用的 icon.png
 *
 * 用途：PC 端 electron 应用图标（electron/icon.png）
 * 输出：1024x1024 PNG，透明背景，正方形
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const srcSvg = path.join(root, "frontend/public/favicon.svg");
const outPng = path.join(root, "electron/icon.png");

const SIZE = 1024; // electron-builder 推荐的母图尺寸

async function main() {
  if (!fs.existsSync(srcSvg)) {
    console.error(`[build-icon] 源 SVG 不存在：${srcSvg}`);
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(srcSvg);

  // favicon.svg 原始 viewBox 是 32x32，我们放大到 1024x1024
  // density 设 96 * (1024/32) = 3072，让 sharp 按高 DPI 渲染保留锐利度
  await sharp(svgBuffer, { density: 96 * (SIZE / 32) })
    .resize(SIZE, SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }, // 透明底
    })
    .png({ compressionLevel: 9 })
    .toFile(outPng);

  const stat = fs.statSync(outPng);
  console.log(
    `[build-icon] 已生成 ${outPng} (${SIZE}x${SIZE}, ${(stat.size / 1024).toFixed(1)} KB)`
  );
}

main().catch((err) => {
  console.error("[build-icon] 失败：", err);
  process.exit(1);
});
