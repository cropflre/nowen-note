/**
 * 从 frontend/public/favicon.svg 同步桌面、飞牛和网页图标。
 *
 * 输出：Electron 与飞牛打包用母图、Linux 图标集、Microsoft Store 磁贴和网页图标。
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
const appxIconsDir = path.join(root, "build/appx");

const SIZE = 1024; // electron-builder 推荐的母图尺寸
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const APPX_ICONS = {
  "StoreLogo.png": [50, 50],
  "Square150x150Logo.png": [150, 150],
  "Square44x44Logo.png": [44, 44],
  "Wide310x150Logo.png": [310, 150],
};

async function main() {
  if (!fs.existsSync(srcSvg)) {
    console.error(`[build-icon] 源 SVG 不存在：${srcSvg}`);
    process.exit(1);
  }

  const svg = fs.readFileSync(srcSvg, "utf8");

  // favicon.svg 原始 viewBox 是 32x32，我们放大到 1024x1024
  // density 设 96 * (1024/32) = 3072，让 sharp 按高 DPI 渲染保留锐利度
  const masterPng = await sharp(Buffer.from(svg), { density: 96 * (SIZE / 32) })
    .resize(SIZE, SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }, // 透明底
    })
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.mkdirSync(linuxIconsDir, { recursive: true });
  fs.mkdirSync(appxIconsDir, { recursive: true });
  fs.writeFileSync(outPng, masterPng);
  await Promise.all(
    LINUX_ICON_SIZES.map((size) =>
      sharp(masterPng)
        .resize(size, size)
        .png({ compressionLevel: 9 })
        .toFile(path.join(linuxIconsDir, `${size}x${size}.png`)),
    ),
  );
  await Promise.all(
    Object.entries(APPX_ICONS).map(([name, [width, height]]) =>
      sharp(masterPng)
        .resize(width, height, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9 })
        .toFile(path.join(appxIconsDir, name)),
    ),
  );
  fs.writeFileSync(
    path.join(root, "frontend/public/nowen-note-icon.svg"),
    svg.replace('width="32" height="32"', 'width="512" height="512"'),
    "utf8",
  );
  // iOS 给主屏幕图标应用系统圆角，网页快捷图标使用满幅底色。
  const fullBleedSvg = svg.replace(/(<rect id="icon-background"[^>]*?)\s+rx="[^"]*"/, "$1");
  await sharp(Buffer.from(fullBleedSvg), { density: 96 * (180 / 32) })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(path.join(root, "frontend/public/apple-touch-icon.png"));

  const stat = fs.statSync(outPng);
  console.log(
    `[build-icon] 已生成 ${outPng} (${SIZE}x${SIZE}, ${(stat.size / 1024).toFixed(1)} KB)`,
  );
  console.log(
    `[build-icon] 已生成 Linux 图标集 ${linuxIconsDir} (${LINUX_ICON_SIZES.join(", ")}px)`,
  );
  console.log(`[build-icon] 已生成 Microsoft Store 磁贴图标 ${appxIconsDir}`);
  console.log("[build-icon] 已同步网页图标");
}

main().catch((err) => {
  console.error("[build-icon] 失败：", err);
  process.exit(1);
});
