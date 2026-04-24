#!/usr/bin/env node
/**
 * 从 SVG 生成扩展所需的 PNG 图标（16 / 32 / 48 / 128）。
 *
 * 依赖：sharp（可选，高质量渲染）。如果环境没装 sharp，退化方案是把同一张
 * SVG 拷贝成所有尺寸的 svg 文件 + 在 manifest 里用 svg（Chrome 不支持 svg 作
 * action icon，必须用 PNG）。所以最佳实践是装 sharp，或者手动用任意工具导出。
 *
 * 这里做"优雅降级"：
 *   - 有 sharp → 生成真正的 PNG
 *   - 没 sharp → 打印提示，让开发者自行生成
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcSvg = join(root, "public/icons/icon.svg");
const outDir = join(root, "public/icons");

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 128];

(async () => {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.warn(
      "[gen-icons] 未安装 sharp，跳过 PNG 生成。请运行 `npm install -D sharp` 后重试，或手动把\n" +
      "  public/icons/icon.svg 导出为 icon-16/32/48/128.png 放入 public/icons/。",
    );
    process.exit(0);
  }

  const svg = readFileSync(srcSvg);
  for (const s of sizes) {
    const out = join(outDir, `icon-${s}.png`);
    await sharp(svg, { density: 384 })
      .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(`[gen-icons] → ${out}`);
  }
})().catch((e) => {
  console.error("[gen-icons] failed:", e);
  process.exit(1);
});
