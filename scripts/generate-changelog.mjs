#!/usr/bin/env node
// Generate CHANGELOG.md, GitHub Release notes, the in-app changelog JSON,
// and keep README changelog blocks compact.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");
const README_PATHS = [
  path.join(REPO_ROOT, "README.md"),
  path.join(REPO_ROOT, "README.en.md"),
];

const GROUPS = [
  { type: "feat", title: "✨ 新增", order: 1 },
  { type: "fix", title: "🐛 修复", order: 2 },
  { type: "perf", title: "⚡ 优化", order: 3 },
  { type: "refactor", title: "♻️ 重构", order: 4 },
  { type: "docs", title: "📝 文档", order: 5 },
  { type: "style", title: "💄 样式", order: 6 },
  { type: "test", title: "✅ 测试", order: 7 },
  { type: "build", title: "📦 构建", order: 8 },
  { type: "ci", title: "🤖 CI", order: 9 },
  { type: "chore", title: "🔧 其他", order: 10 },
  { type: "revert", title: "⏪ 回滚", order: 11 },
  { type: "other", title: "📌 杂项", order: 12 },
];
const GROUP_BY_TYPE = Object.fromEntries(GROUPS.map((group) => [group.type, group]));
const COMMIT_RE = /^(feat|fix|perf|refactor|docs|chore|style|test|build|ci|revert)(\(([^)]+)\))?(!)?:\s*(.+)$/i;

function parseArgs(argv) {
  const args = {
    version: "",
    since: "",
    write: false,
    section: false,
    syncReadme: false,
    emitJson: false,
    jsonLimit: 10,
    readmeLimit: 5,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-v":
      case "--version":
        args.version = argv[++index] || "";
        break;
      case "--since":
        args.since = argv[++index] || "";
        break;
      case "--write":
        args.write = true;
        break;
      case "--section":
        args.section = true;
        break;
      case "--sync-readme":
        args.syncReadme = true;
        break;
      case "--emit-json":
        args.emitJson = true;
        break;
      case "--json-limit":
        args.jsonLimit = Number.parseInt(argv[++index], 10) || 10;
        break;
      case "--readme-limit":
        // Retained for CLI compatibility. README no longer embeds release history.
        args.readmeLimit = Number.parseInt(argv[++index], 10) || 5;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`未知参数: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`用法: node scripts/generate-changelog.mjs [options]

选项:
  -v, --version X.Y.Z   本次发布版本号
      --since <tag>     指定 commit 起始 tag
      --write           写入 CHANGELOG.md
      --section         输出本版本 Markdown 片段
      --sync-readme     保持 README 更新日志区块为精简入口
      --emit-json       更新 frontend/public/changelog.json
      --json-limit N    JSON 保留版本数（默认 10）
      --readme-limit N  兼容参数；README 不再嵌入完整版本记录
      --dry-run         仅打印，不写文件
  -h, --help            显示帮助`);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function normalizeVersion(version) {
  return String(version || "").replace(/^v/, "");
}

function getLastTag(excludeVersion = "") {
  const excluded = normalizeVersion(excludeVersion);
  try {
    const tags = git(["tag", "--list", "v*", "--sort=-v:refname"])
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    return tags.find((tag) => normalizeVersion(tag) !== excluded) || "";
  } catch {
    return "";
  }
}

function getCommitsSince(sinceTag) {
  const range = sinceTag ? `${sinceTag}..HEAD` : "HEAD";
  let raw = "";
  try {
    raw = git(["log", range, "--no-merges", "--pretty=format:%H%x1f%s%x1f%b%x1e"]);
  } catch {
    raw = git(["log", "HEAD", "--no-merges", "--pretty=format:%H%x1f%s%x1f%b%x1e"]);
  }

  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = "", subject = "", body = ""] = record.split("\x1f");
      return { hash: hash.trim(), subject: subject.trim(), body: body.trim() };
    });
}

function categorize(commit) {
  const match = COMMIT_RE.exec(commit.subject);
  if (!match) {
    return { type: "other", scope: "", breaking: false, subject: commit.subject, hash: commit.hash };
  }
  return {
    type: match[1].toLowerCase(),
    scope: (match[3] || "").trim(),
    breaking: Boolean(match[4]) || /BREAKING CHANGE/i.test(commit.body),
    subject: match[5].trim(),
    hash: commit.hash,
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}::${item.scope}::${item.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function today() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

function renderSection(version, items) {
  const lines = [`## v${normalizeVersion(version)} - ${today()}`, ""];
  if (items.length === 0) {
    lines.push("_本版本无可展示的 commit 变更（可能全部是合并或工作流修改）_", "");
    return lines.join("\n");
  }

  const grouped = new Map();
  for (const item of items) {
    const group = GROUP_BY_TYPE[item.type] || GROUP_BY_TYPE.other;
    if (!grouped.has(group.type)) grouped.set(group.type, { ...group, items: [] });
    grouped.get(group.type).items.push(item);
  }

  for (const group of [...grouped.values()].sort((left, right) => left.order - right.order)) {
    lines.push(`### ${group.title}`, "");
    for (const item of group.items) {
      const scope = item.scope ? `**${item.scope}**: ` : "";
      const breaking = item.breaking ? "⚠️ " : "";
      const hash = item.hash ? ` (${item.hash.slice(0, 7)})` : "";
      lines.push(`- ${breaking}${scope}${item.subject}${hash}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function ensureChangelog() {
  if (fs.existsSync(CHANGELOG_PATH)) return;
  fs.writeFileSync(
    CHANGELOG_PATH,
    "# 更新日志 / Changelog\n\n<!-- ADD_NEW_HERE -->\n",
    "utf-8",
  );
}

function writeChangelog(section, version) {
  ensureChangelog();
  const raw = fs.readFileSync(CHANGELOG_PATH, "utf-8");
  const normalized = normalizeVersion(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = new RegExp(`^## v${normalized}\\b[\\s\\S]*?(?=^## v|\\s*$)`, "m");
  let next = raw;

  if (existing.test(raw)) {
    next = raw.replace(existing, `${section.trim()}\n\n`);
  } else if (raw.includes("<!-- ADD_NEW_HERE -->")) {
    next = raw.replace("<!-- ADD_NEW_HERE -->", `<!-- ADD_NEW_HERE -->\n\n${section.trim()}`);
  } else {
    next = `${raw.trim()}\n\n${section.trim()}\n`;
  }

  fs.writeFileSync(CHANGELOG_PATH, next.replace(/\n{4,}/g, "\n\n\n"), "utf-8");
}

function compareVersion(left, right) {
  const a = left.split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const b = right.split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x === y) continue;
    if (typeof x === typeof y) return x < y ? -1 : 1;
    return typeof x === "number" ? 1 : -1;
  }
  return 0;
}

function parseChangelog() {
  ensureChangelog();
  const raw = fs.readFileSync(CHANGELOG_PATH, "utf-8");
  const entries = [];
  for (const part of raw.split(/\n(?=## v\d)/)) {
    const match = part.match(/^## v([\w.\-+]+)\s*-\s*(\d{4}-\d{2}-\d{2})?/);
    if (!match) continue;
    entries.push({
      version: match[1],
      date: match[2] || "",
      body: part.replace(/^## v[^\n]*\n/, "").trim(),
    });
  }
  return entries.sort((left, right) => compareVersion(right.version, left.version));
}

function compactReadme(readmePath) {
  if (!fs.existsSync(readmePath)) return false;
  const raw = fs.readFileSync(readmePath, "utf-8");
  const english = path.basename(readmePath) === "README.en.md";
  const note = english
    ? "<!-- Detailed release history lives in CHANGELOG.md. Keep the README focused on stable capabilities and recent highlights. -->"
    : "<!-- 详细版本记录请查看 CHANGELOG.md；README 仅维护稳定能力与近期重点增强。 -->";
  const block = `<!-- CHANGELOG:BEGIN -->\n${note}\n<!-- CHANGELOG:END -->`;
  const marker = /<!-- CHANGELOG:BEGIN -->[\s\S]*?<!-- CHANGELOG:END -->/m;
  const next = marker.test(raw)
    ? raw.replace(marker, block)
    : `${raw.replace(/\s*$/, "")}\n\n${block}\n`;
  if (next === raw) return false;
  fs.writeFileSync(readmePath, next, "utf-8");
  return true;
}

function emitJson(entries, limit) {
  const outputPath = path.join(REPO_ROOT, "frontend", "public", "changelog.json");
  const output = {
    generatedAt: new Date().toISOString(),
    entries: entries.slice(0, limit).map(({ version, date, body }) => ({ version, date, body })),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const maintenanceOnly = !args.version && !args.write && !args.section && (args.syncReadme || args.emitJson);
  if (!maintenanceOnly && !args.version) {
    console.error("错误：请使用 --version X.Y.Z（或仅使用 --sync-readme / --emit-json）");
    process.exitCode = 1;
    return;
  }

  let section = "";
  if (args.version) {
    const version = normalizeVersion(args.version);
    const since = args.since || getLastTag(version);
    const items = dedupe(getCommitsSince(since).map(categorize)).filter((item) => {
      const subject = item.subject.toLowerCase();
      return !subject.startsWith("release:") && !subject.startsWith("chore: release") && !(item.type === "chore" && item.scope === "release");
    });
    section = renderSection(version, items);

    if (args.section) process.stdout.write(section);
    if (args.write) {
      if (args.dryRun) console.error(section);
      else writeChangelog(section, version);
    }
  }

  const entries = parseChangelog();
  if (args.syncReadme) {
    if (args.dryRun) console.error("[dry-run] README 更新日志区块将保持精简");
    else README_PATHS.forEach(compactReadme);
  }
  if (args.emitJson) {
    if (args.dryRun) console.error(`[dry-run] 将写入最近 ${args.jsonLimit} 个版本到 changelog.json`);
    else emitJson(entries, args.jsonLimit);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
