/**
 * 把 frontend/public/favicon.svg 栅格化成 PC 端打包用的 icon.png
 *
 * 用途：PC 端 electron 应用图标
 * 输出：1024x1024 母图，以及 Linux 桌面环境使用的标准尺寸图标集
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
const linuxIconsDir = path.join(root, "build/icons");

const SIZE = 1024; // electron-builder 推荐的母图尺寸
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

async function main() {
  if (!fs.existsSync(srcSvg)) {
    console.error(`[build-icon] 源 SVG 不存在：${srcSvg}`);
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(srcSvg);

  // favicon.svg 原始 viewBox 是 32x32，我们放大到 1024x1024
  // density 设 96 * (1024/32) = 3072，让 sharp 按高 DPI 渲染保留锐利度
  const masterPng = await sharp(svgBuffer, { density: 96 * (SIZE / 32) })
    .resize(SIZE, SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }, // 透明底
    })
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.mkdirSync(linuxIconsDir, { recursive: true });
  fs.writeFileSync(outPng, masterPng);
  await Promise.all(
    LINUX_ICON_SIZES.map((size) =>
      sharp(masterPng)
        .resize(size, size)
        .png({ compressionLevel: 9 })
        .toFile(path.join(linuxIconsDir, `${size}x${size}.png`)),
    ),
  );

  const stat = fs.statSync(outPng);
  console.log(
    `[build-icon] 已生成 ${outPng} (${SIZE}x${SIZE}, ${(stat.size / 1024).toFixed(1)} KB)`,
  );
  console.log(
    `[build-icon] 已生成 Linux 图标集 ${linuxIconsDir} (${LINUX_ICON_SIZES.join(", ")}px)`,
  );
}

main().catch((err) => {
  console.error("[build-icon] 失败：", err);
  process.exit(1);
});
