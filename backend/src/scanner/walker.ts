/**
 * scanner/walker.ts — 目录遍历器
 *
 * 递归遍历 Markdown 目录树，按规则过滤文件，
 * 返回所有匹配的 .md 文件路径及其内容。
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

/** 遍历结果中的文件记录 */
export interface FileEntry {
  /** 绝对路径 */
  absolutePath: string;
  /** 相对 MD 根的路径 */
  relativePath: string;
  /** 文件内容 */
  content: string;
  /** SHA256 摘要 */
  sha256: string;
  /** 文件大小（字节） */
  size: number;
  /** 修改时间戳 */
  mtimeMs: number;
}

/** 默认排除目录 */
const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".nowen",
  "templates",
  ".DS_Store",
  "Thumbs.db",
  ".obsidian",
  ".trash",
  ".hg",
  ".svn",
]);

/** 默认排除文件模式 */
const DEFAULT_IGNORE_PATTERNS = [
  /^\./,           // 隐藏文件
  /~$/,            // 临时文件
  /\.swp$/,        // vim swap
  /\.tmp$/i,       // 临时文件
];

/** 遍历配置 */
export interface WalkOptions {
  /** 排除的目录名 */
  ignoreDirs?: Set<string>;
  /** 排除的文件正则 */
  ignorePatterns?: RegExp[];
  /** 最大文件大小（字节，默认 10MB） */
  maxFileSize?: number;
  /** 仅返回文件名（不读内容） */
  namesOnly?: boolean;
}

/**
 * 递归遍历目录，返回所有匹配的 .md 文件
 */
export function walkDir(
  rootDir: string,
  options: WalkOptions = {},
): FileEntry[] {
  const ignoreDirs = options.ignoreDirs || DEFAULT_IGNORE_DIRS;
  const ignorePatterns = options.ignorePatterns || DEFAULT_IGNORE_PATTERNS;
  const maxFileSize = options.maxFileSize || 10 * 1024 * 1024;
  const namesOnly = options.namesOnly || false;

  const results: FileEntry[] = [];

  function walk(currentDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return; // 跳过无权限目录
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // 跳过排除目录
        if (ignoreDirs.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // 仅处理 .md 文件
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".md") continue;

      // 跳过隐藏/临时文件
      if (ignorePatterns.some((p) => p.test(entry.name))) continue;

      // 相对路径
      const relativePath = path.relative(rootDir, fullPath);

      if (namesOnly) {
        results.push({
          absolutePath: fullPath,
          relativePath,
          content: "",
          sha256: "",
          size: 0,
          mtimeMs: 0,
        });
        continue;
      }

      // 读取文件内容
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > maxFileSize) continue; // 跳过超大文件
        if (stat.size === 0) continue; // 跳过空文件

        const content = fs.readFileSync(fullPath, "utf-8");
        const sha256 = crypto.createHash("sha256").update(content).digest("hex");

        results.push({
          absolutePath: fullPath,
          relativePath,
          content,
          sha256,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // 跳过无法读取的文件
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * 快速扫描目录结构（只返回路径，不读内容）
 */
export function scanFiles(rootDir: string): FileEntry[] {
  return walkDir(rootDir, { namesOnly: true });
}
